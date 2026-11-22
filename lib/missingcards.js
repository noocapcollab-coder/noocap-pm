// Deals that owe more videos than their creator's board has cards for (Harsh, Nov 22: Upfluence × Duncan agreed 2
// YouTube Shorts, only "Upfluence × Duncan 1" was ever on the board, and when Upfluence asked for the second draft
// nobody had a card for it). The heartbeat adds the missing cards ("Brand × Creator 2", …) at 2- Waiting For Brief and
// tells Harsh once, so the second video is planned, briefed and edited like the first.
import { notion, plain, titleOf } from './notion.js';
import { BOARDS } from './tools.js';

const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1 };
// How many videos (not stories, posts or carousels) the deliverables ask for. Pure.
export function videosOwed(deliverables = '') {
  const t = String(deliverables).toLowerCase().replace(/\([^)]*\)/g, ' '); // "(syndicated to TikTok, …)" is the same video
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
      await addVideoCards({ creator: d.creator, brand: d.brand, videos: add.map((title) => ({ title, brief: null, post_date: null })) });
      await discord(`🎬 **${d.brand} × ${d.creator}: ${owed} videos agreed, only ${have.length} on the board**\n• Added ${add.join(', ')} to ${d.creator}'s board so the next one is planned. Deliverables: ${String(d.deliverables).slice(0, 160)}`, 'pm').catch(() => {});
    }
    out.push(`${d.brand} × ${d.creator}: ${have.length} of ${owed} cards → add ${add.join(', ')}`);
  }
  return out;
}
