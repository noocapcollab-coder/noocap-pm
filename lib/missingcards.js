// Deals that owe more videos than their creator's board has cards for (Harsh, Nov 22: Upfluence × Duncan agreed 2
// YouTube Shorts, only "Upfluence × Duncan 1" was ever on the board, and when Upfluence asked for the second draft
// nobody had a card for it). The heartbeat adds the missing cards ("Brand × Creator 2", …) at 2- Waiting For Brief and
// tells Harsh once, so the second video is planned, briefed and edited like the first.
import { notion, plain, titleOf } from './notion.js';
import { BOARDS } from './tools.js';

const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1 };
// How many videos (not stories, posts or carousels) the deliverables ask for. Pure.
export function videosOwed(deliverables = '') {
  let t = String(deliverables).toLowerCase().replace(/\([^)]*\)/g, ' '); // "(syndicated to TikTok, …)" is the same video
  // "One short video posted as 1 Instagram Reel + 1 TikTok + 1 YouTube Short + 1 Facebook post" is ONE video cross-posted,
  // not four (KooKo AI x Valeri, Nov 26: three extra cards were made). Only what comes before the cross-post words counts.
  const cut = t.search(/\b(posted|published|shared|distributed|uploaded|repurposed)\s+(as|to|on|across)\b|\bcross[- ]?post|\bsyndicat|\bacross\s+(all\s+)?(platforms|channels)|\bsame video\b/);
  if (cut > 0) t = t.slice(0, cut);
  let n = 0;
  const re = /\b(\d+|one|two|three|four|five|six|a|an|single)\s*(?:x|×)?\s*(?:dedicated\s+|integrated\s+|short[- ]form\s+|long[- ]form\s+)?(?:youtube\s+|instagram\s+|ig\s+|tiktok\s+)?(shorts?|reels?|videos?|tiktoks?|integrations?)\b/g;
  for (const m of t.matchAll(re)) n += Number(WORD[m[1]] ?? m[1]) || 0;
  return n;
}

const lc = (s) => String(s || '').toLowerCase();
const key = (s) => lc(s).replace(/\.(ai|io|app|co|com)\b/g, ' ').replace(/[^a-z0-9]/g, '');
// Cards on the board that belong to this deal: the title names the brand (any age: the first video may be months old)
export function cardsForDeal(titles, brand) {
  const k = key(brand).slice(0, 8);
  if (k.length < 3) return [];
  return titles.filter((t) => key(t).includes(k));
}

export async function missingVideoCards({ dry = false } = {}) {
  const { openDeals, discord } = await import('./briefs.js');
  const deals = (await openDeals({ withClosed: true }).catch(() => [])).filter((d) => !['Paid', 'Lost', 'Invoiced'].includes(d.stage) && !d.paused);
  const out = [];
  const titlesByBoard = new Map();
  for (const d of deals) {
    const owed = videosOwed(d.deliverables);
    if (owed < 2 || owed > 6) continue; // a single video is the deal's own card; huge counts are retainers, not cards
    const board = BOARDS.find((b) => lc(b.creator) === lc(d.creator));
    if (!board) continue;
    if (!titlesByBoard.has(board.ds)) {
      const titles = [];
      let cursor;
      do {
        const r = await notion('POST', `/data_sources/${board.ds}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }).catch(() => ({ results: [] }));
        for (const p of r.results || []) if (!p.in_trash) titles.push(titleOf(p) || '');
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor && titles.length < 1500);
      titlesByBoard.set(board.ds, titles);
    }
    const have = cardsForDeal(titlesByBoard.get(board.ds), d.brand);
    if (!have.length || have.length >= owed) continue; // no card at all is the new-deal path's job
    const add = [];
    for (let i = have.length + 1; i <= owed; i++) add.push(`${d.brand} × ${d.creator} ${i}`);
    if (!dry) {
      const { claimOnce } = await import('./briefs.js');
      if (!(await claimOnce(`Missing cards · ${d.id} · ${owed}`, 24 * 90).catch(() => false))) continue;
      const { addVideoCards } = await import('./briefs.js');
      const made = await addVideoCards({ creator: d.creator, brand: d.brand, videos: add.map((title) => ({ title, brief: null, post_date: null })) });
      // The new card takes the deal's details from its sibling card (type, brand email, month, format), so it looks like
      // the first one on the board (Upfluence × Duncan 2, Nov 23: TYPE was empty). The post date is never guessed:
      // Harsh sets it, and the alert says so (a card with no date is missing from the calendar view)
      await copySiblingProps(board.ds, d.brand, made.filter((m) => !m.existed).map((m) => m.url)).catch(() => {});
      await discord(`🎬 **${d.brand} × ${d.creator}: ${owed} videos agreed, only ${have.length} on the board**\n• Added ${add.join(', ')} to ${d.creator}'s board so the next one is planned. Deliverables: ${String(d.deliverables).slice(0, 160)}\n• ⚠️ No post date yet: set it on the card so it shows on the calendar.`, 'pm').catch(() => {});
    }
    out.push(`${d.brand} × ${d.creator}: ${have.length} of ${owed} cards → add ${add.join(', ')}`);
  }
  return out;
}

const COPY = /^(type|brand email|month|format)$/i;
// Copy the deal details from the brand's existing card on the board onto the new cards (never dates, status or links)
async function copySiblingProps(ds, brand, urls) {
  const ids = urls.map((u) => (String(u).match(/[0-9a-f]{32}/i) || [])[0]).filter(Boolean);
  if (!ids.length) return;
  // Search by the brand in the title (a board holds hundreds of cards, the first one may be months old)
  const fresh = await notion('GET', `/pages/${ids[0]}`);
  const titleProp = Object.entries(fresh.properties || {}).find(([, v]) => v.type === 'title')?.[0];
  if (!titleProp) return;
  const r = await notion('POST', `/data_sources/${ds}/query`, { page_size: 50, filter: { property: titleProp, title: { contains: String(brand).split(/\s+/)[0] } }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
  const sib = (r.results || []).find((p) => !p.in_trash && !ids.includes(p.id.replace(/-/g, '')) && cardsForDeal([titleOf(p) || ''], brand).length);
  if (!sib) return;
  const props = {};
  for (const [name, v] of Object.entries(sib.properties || {})) {
    if (!COPY.test(name.trim())) continue;
    if (v.type === 'select' && v.select) props[name] = { select: { name: v.select.name } };
    else if (v.type === 'multi_select' && v.multi_select?.length) props[name] = { multi_select: v.multi_select.map((o) => ({ name: o.name })) };
    else if (v.type === 'rich_text' && v.rich_text?.length) props[name] = { rich_text: [{ type: 'text', text: { content: plain(v).slice(0, 1900) } }] };
    else if (v.type === 'email' && v.email) props[name] = { email: v.email };
  }
  if (Object.keys(props).length) for (const id of ids) await notion('PATCH', `/pages/${id}`, { properties: props });
}
