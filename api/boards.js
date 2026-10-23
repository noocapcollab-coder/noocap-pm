// GET /api/boards?k=<BOARDS_KEY> — one shared snapshot of every creator REELS board.
//
// The dashboards (posting calendar, scripting page, video brief, pipeline) used to each ask Notion for the same
// boards every 20-60 seconds. Notion allows one integration about 3 requests a second, so together with the PM they
// kept hitting "rate limited". Now they read this snapshot instead: Vercel's CDN keeps one copy for a minute and
// serves it to every viewer, so Notion is asked for the boards about once a minute in total.
//
// Rows keep Notion's own property shape (trimmed: rich text is reduced to plain_text and href), so each dashboard's
// existing readers work on them unchanged. Each board holds its 300 most recently edited cards from the last 150 days.
import { notion } from '../lib/notion.js';

export const config = { maxDuration: 120 };

const BOARDS = [
  { creator: 'Brad', ds: '28b508e9-9dda-81ba-8d7f-000b84b83fbd' },
  { creator: 'Chris', ds: '2a1508e9-9dda-8125-bd63-000bb75578dd' },
  { creator: 'Lindsay', ds: '301508e9-9dda-811b-83c7-000b46be09b1' },
  { creator: 'Valeri', ds: 'f0dbec00-505d-4e16-8e51-b2fcfea21445' },
  { creator: 'Duncan', ds: '328508e9-9dda-8186-b4ca-000bd212e84b' },
  { creator: 'Dmytro', ds: '36b508e9-9dda-8004-a37f-000b460c8c46' },
  { creator: 'David Iya', ds: '898508e9-9dda-8383-ad90-070f01618f5a' },
  { creator: 'Nicole McCain', ds: '25b449d2-35ba-4026-992e-39af9974b158' },
  { creator: 'Emtech', ds: '328508e9-9dda-8000-b3c9-000b0d791507' },
];
const MAX_ROWS = 300;
const MAX_AGE_DAYS = 150;
const MEMO_MS = 45 * 1000;

const rich = (arr) => (arr || []).map((t) => (t.href ? { plain_text: t.plain_text, href: t.href } : { plain_text: t.plain_text }));
function trimProp(p) {
  if (!p) return p;
  switch (p.type) {
    case 'title': return { type: 'title', title: rich(p.title) };
    case 'rich_text': return { type: 'rich_text', rich_text: rich(p.rich_text) };
    case 'people': return { type: 'people', people: (p.people || []).map((u) => ({ id: u.id, name: u.name })) };
    case 'files': return { type: 'files', files: (p.files || []).map((f) => ({ name: f.name, type: f.type, external: f.external, file: f.file ? { url: f.file.url } : undefined })) };
    case 'relation': return { type: 'relation', relation: (p.relation || []).map((r) => ({ id: r.id })) };
    case 'rollup': return { type: 'rollup' };
    case 'created_by': case 'last_edited_by': return { type: p.type };
    default: return p;
  }
}
function trimPage(pg) {
  const properties = {};
  for (const k in pg.properties || {}) properties[k] = trimProp(pg.properties[k]);
  return { id: pg.id, url: pg.url, created_time: pg.created_time, last_edited_time: pg.last_edited_time, parent: pg.parent, properties };
}

async function readBoard(b) {
  const since = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString();
  const rows = [];
  let cursor;
  do {
    const r = await notion('POST', `/data_sources/${b.ds}/query`, {
      page_size: 100,
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const pg of r.results || []) if (!pg.in_trash && !pg.archived) rows.push(trimPage(pg));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor && rows.length < MAX_ROWS);
  return rows.slice(0, MAX_ROWS);
}

let memo = null, inflight = null;
const lastGood = {};
async function build() {
  const boards = {};
  for (const b of BOARDS) {
    const key = b.ds.replace(/-/g, '');
    try {
      const rows = await readBoard(b);
      lastGood[key] = { rows, at: new Date().toISOString() };
      boards[key] = { creator: b.creator, rows, at: lastGood[key].at };
    } catch (e) {
      // Keep the board's last good copy rather than dropping it
      boards[key] = lastGood[key] ? { creator: b.creator, rows: lastGood[key].rows, at: lastGood[key].at, stale: true } : { creator: b.creator, rows: [], error: String(e.message || e).slice(0, 200) };
    }
  }
  return { at: new Date().toISOString(), boards };
}

export default async function handler(req, res) {
  const want = process.env.BOARDS_KEY || '';
  if (!want || String(req.query?.k || '') !== want) return res.status(401).json({ error: 'Set BOARDS_KEY in Vercel and pass it as ?k=' });
  if (!memo || Date.now() - memo.t > MEMO_MS) {
    if (!inflight) inflight = build().then((d) => { memo = { t: Date.now(), d }; return d; }).finally(() => { inflight = null; });
    try { await inflight; } catch (e) { if (!memo) return res.status(502).json({ error: String(e.message || e).slice(0, 200) }); }
  }
  // One copy at Vercel's edge for a minute, then served stale while one request refreshes it in the background
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
  return res.status(200).json(memo.d);
}
