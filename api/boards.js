// GET /api/boards?k=<BOARDS_KEY> — one shared snapshot of every creator REELS board.
//
// The dashboards (posting calendar, scripting page, video brief, pipeline) used to each ask Notion for the same
// boards every 20-60 seconds. Notion allows one integration about 3 requests a second, so together with the PM they
// kept hitting "rate limited". Now they read this snapshot instead: Vercel's CDN keeps one copy for a minute and
// serves it to every viewer, so Notion is asked for the boards about once a minute in total.
//
// How it stays light on Notion: a Vercel Cron calls this every minute and asks each board only for the cards edited
// since the last sync (usually none, so one tiny request per board). The full boards are re-read every 30 minutes and
// on a cold start, which also drops cards that were deleted. Viewers are always served the copy in memory straight
// away and never wait on Notion.
//
// Rows keep Notion's own property shape (trimmed: rich text is reduced to plain_text and href), so each dashboard's
// existing readers work on them unchanged. Each board holds its 300 most recently edited cards from the last 150 days.
import { notion } from '../lib/notion.js';
import { cronAllowed } from '../lib/hook.js';
import { waitUntil } from '@vercel/functions';
import { logStatusChanges } from '../lib/history.js';

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
  // Not a creator board: editors' finished videos. Synced here so its status changes go into STATUS HISTORY too
  { creator: 'Video Intake', ds: '13cf6abc-bcfc-4a35-95d5-e130fd58e720', intake: true },
  // Same for EDIT TRACKER, where every video lives from assignment to posted since 26 Oct 2026
  { creator: 'EDIT TRACKER', ds: '8fceee86-cd0d-4045-9b4f-33363fcd25c1', intake: true },
];
const MAX_ROWS = 300;
const MAX_AGE_DAYS = 150;

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

const FULL_EVERY_MS = 30 * 60 * 1000;
const FRESH_MS = 50 * 1000;
const sinceIso = () => new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString();

// Every card of one board edited on or after `after` (newest first), up to MAX_ROWS
async function query(b, after, cap = MAX_ROWS) {
  const rows = [];
  let cursor, more = false;
  do {
    const r = await notion('POST', `/data_sources/${b.ds}/query`, {
      page_size: 100,
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: after } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const pg of r.results || []) rows.push(pg);
    cursor = r.has_more ? r.next_cursor : undefined;
    more = !!cursor;
  } while (cursor && rows.length < cap);
  return { rows, more };
}

// The live copy: one Map of cards per board, kept up to date by small "what changed" queries
const S = { boards: {}, lastSync: 0, lastFull: 0, out: null, stats: {} };
const keyOf = (b) => b.ds.replace(/-/g, '');

function publish() {
  const floor = Date.now() - MAX_AGE_DAYS * 864e5;
  const boards = {};
  for (const b of BOARDS) {
    const k = keyOf(b), st = S.boards[k];
    if (!st) { boards[k] = { creator: b.creator, rows: [], error: 'not loaded yet' }; continue; }
    const rows = [...st.map.values()].filter((p) => Date.parse(p.last_edited_time) >= floor)
      .sort((x, y) => Date.parse(y.last_edited_time) - Date.parse(x.last_edited_time)).slice(0, MAX_ROWS);
    boards[k] = { creator: b.creator, rows, at: st.at, ...(st.error ? { stale: true } : {}) };
  }
  S.out = { at: new Date(S.lastSync).toISOString(), full_at: new Date(S.lastFull).toISOString(), boards };
}

// Cards whose status may have changed since the last sync, with their previous copy, for STATUS HISTORY
let changes = [];
async function fullBoard(b, after) {
  const { rows } = await query(b, sinceIso());
  const old = S.boards[keyOf(b)]?.map;
  const map = new Map();
  for (const pg of rows) {
    if (!pg.in_trash && !pg.archived) map.set(pg.id, trimPage(pg));
    if (old && after && pg.last_edited_time >= after) changes.push({ page: pg, board: b, old: old.get(pg.id) });
  }
  S.boards[keyOf(b)] = { map, at: new Date().toISOString() };
}

async function sync({ full = false } = {}) {
  const startedAt = Date.now();
  const doFull = full || !S.lastFull || startedAt - S.lastFull > FULL_EVERY_MS;
  // Notion's edit times are rounded to the minute, so look back two minutes past the last sync to miss nothing
  const after = new Date((S.lastSync || startedAt) - 2 * 60 * 1000).toISOString();
  let changed = 0, calls = 0;
  const one = async (b) => {
    const k = keyOf(b);
    try {
      if (doFull || !S.boards[k]) { await fullBoard(b, S.boards[k] ? after : null); calls += 3; return; }
      const { rows, more } = await query(b, after, 100);
      calls++;
      if (more) { await fullBoard(b, after); calls += 3; return; } // a big batch edit: just re-read the board
      const st = S.boards[k];
      for (const pg of rows) {
        changed++;
        changes.push({ page: pg, board: b, old: st.map.get(pg.id) });
        if (pg.in_trash || pg.archived) st.map.delete(pg.id); else st.map.set(pg.id, trimPage(pg));
      }
      st.at = new Date().toISOString(); delete st.error;
    } catch (e) {
      // Keep the board's last good copy rather than dropping it
      if (S.boards[k]) S.boards[k].error = String(e.message || e).slice(0, 200);
    }
  };
  // Three boards at a time: quick, still gentle on Notion's limit
  for (let i = 0; i < BOARDS.length; i += 3) await Promise.all(BOARDS.slice(i, i + 3).map(one));
  if (changes.length > 500) changes = changes.slice(-500);
  S.lastSync = startedAt;
  if (doFull) S.lastFull = startedAt;
  S.stats = { kind: doFull ? 'full' : 'changes', changed, calls, ms: Date.now() - startedAt };
  publish();
}

let inflight = null;
const refresh = (opts) => (inflight ||= sync(opts).finally(() => { inflight = null; }));

export default async function handler(req, res) {
  const want = process.env.BOARDS_KEY || '';
  const cron = cronAllowed(req);
  if (!cron) {
    if (!want) return res.status(503).json({ error: 'BOARDS_KEY is not set on noocap-pm (or it was added without a redeploy)' });
    if (String(req.query?.k || '') !== want) return res.status(401).json({ error: 'Wrong or missing key' });
  }
  // The every-minute cron: pick up what changed and report how much work that was
  if (cron || req.query?.sync === '1') {
    await refresh({ full: req.query?.full === '1' }).catch(() => {});
    // Status changes are written by the cron only, so two syncs can't log the same move twice
    if (cron && process.env.STATUS_HISTORY !== 'off') {
      const batch = changes; changes = [];
      S.stats.history = await logStatusChanges(batch).catch((e) => 'error: ' + String(e.message).slice(0, 120));
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: !!S.out, ...S.stats, at: S.out?.at, full_at: S.out?.full_at });
  }
  if (!S.out) {
    // Cold start: build the copy once, then everyone after this is served from memory
    try { await refresh({ full: true }); } catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 200) }); }
  } else if (Date.now() - S.lastSync > FRESH_MS) {
    // Serve the copy now and catch up in the background
    waitUntil(refresh().catch(() => {}));
  }
  // One copy at Vercel's edge for a minute, then served stale while one request refreshes it in the background
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
  return res.status(200).json(S.out);
}
