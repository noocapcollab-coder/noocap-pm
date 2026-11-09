// Daily loose ends (Harsh, Nov 9). Once a morning the PM lists the brand-deal records that slipped through, so each can
// be fixed in a minute instead of turning into a missed post, a chase that never starts or a wrong invoice:
//  - sponsor cards with no deal pointing at them (Inworld, TRIPO)
//  - live deals past the brief with no video card
//  - live sponsor cards with no POST DATE (they never show on the calendar)
//  - invoiced deals with no due date (no payment chase can start)
//  - a deal whose amount disagrees with its revenue row (Zeely $1,000 vs $2,000)
// The message starts with 🟡 so it lands in #pm-alerts and is mirrored to WhatsApp.
import { notion, plain } from './notion.js';
import { DS, todayIST, allVideos } from './tools.js';
import { openDeals, discord, log } from './briefs.js';

const bare = (s) => String(s || '').replace(/-/g, '').toLowerCase().match(/[0-9a-f]{32}/)?.[0] || '';
const num = (s) => parseInt(String(s || ''), 10);
const LIVE_DEAL = ['Brief Received', 'Script Sent', 'Script Approved', 'In Production', 'Submitted', 'Approved'];
const MULTI = /\b([2-9]|two|three|four|five)\s*(x\s*)?(reels?|videos?|posts?|shorts?|tiktoks?|ugc)\b|\b(reels|videos)\b/i;

// Pure part, so it can be tested: what is loose, given cards, deals and revenue rows
export function findLooseEnds({ videos = [], deals = [], revenue = [] }) {
  const linked = new Set(deals.map((d) => bare(d.linkedVideo)).filter(Boolean));
  const liveSponsor = videos.filter((v) => v.sponsor && num(v.status) >= 2 && num(v.status) <= 11);
  const cardsNoDeal = liveSponsor.filter((v) => !linked.has(bare(v.id)));
  const cardsNoDate = liveSponsor.filter((v) => !v.post_date);
  const dealsNoCard = deals.filter((d) => LIVE_DEAL.includes(d.stage) && !d.linkedVideo);
  const invoicedNoDue = deals.filter((d) => d.stage === 'Invoiced' && !d.invoiceDue);
  const mismatch = [];
  for (const d of deals) {
    const rate = Number(d.invoiceAmount || d.finalRate || 0);
    if (!rate || !d.linkedVideo || MULTI.test(String(d.deliverables || ''))) continue;
    const rows = revenue.filter((r) => bare(r['Video Link']) && bare(r['Video Link']) === bare(d.linkedVideo) && Number(r['Amount USD'] || 0) > 0);
    if (rows.length !== 1) continue;
    const amt = Number(rows[0]['Amount USD']);
    if (Math.abs(amt - rate) >= 1) mismatch.push({ deal: d, revenue: amt, rate });
  }
  return { cardsNoDeal, cardsNoDate, dealsNoCard, invoicedNoDue, mismatch };
}

export function looseEndsText(l, max = 6) {
  const sec = (title, list, line) => list.length ? [`*${title} (${list.length})*`, ...list.slice(0, max).map((x) => '• ' + line(x)), ...(list.length > max ? [`• …and ${list.length - max} more`] : [])] : [];
  const lines = [
    ...sec('Sponsor cards with no deal', l.cardsNoDeal, (v) => `${v.creator}: ${v.title} (${v.status})`),
    ...sec('Deals with no video card', l.dealsNoCard, (d) => `${d.brand} × ${d.creator} (${d.stage})`),
    ...sec('Live sponsor cards with no post date', l.cardsNoDate, (v) => `${v.creator}: ${v.title}`),
    ...sec('Invoiced with no due date', l.invoicedNoDue, (d) => `${d.brand} × ${d.creator}`),
    ...sec('Deal and revenue amounts disagree', l.mismatch, (m) => `${m.deal.brand} × ${m.deal.creator}: deal $${m.rate}, revenue row $${m.revenue}`),
  ];
  return lines;
}

export async function sendLooseEnds({ force = false } = {}) {
  const today = todayIST();
  if (!force) {
    const done = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { equals: `Loose ends ${today}` } } }).catch(() => ({ results: [] }));
    if ((done.results || []).length) return 'already sent';
  }
  const [{ videos }, deals, revPages] = await Promise.all([
    allVideos(),
    openDeals(),
    (async () => { const out = []; let cursor; do { const r = await notion('POST', `/data_sources/${DS.revenue}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }); out.push(...(r.results || [])); cursor = r.has_more ? r.next_cursor : null; } while (cursor && out.length < 500); return out; })().catch(() => []),
  ]);
  const revenue = revPages.map((p) => ({ 'Video Link': p.properties?.['Video Link']?.url || '', 'Amount USD': p.properties?.['Amount USD']?.number || 0, title: plain(p.properties?.['Video Title']) }));
  const l = findLooseEnds({ videos, deals, revenue });
  const lines = looseEndsText(l);
  const total = l.cardsNoDeal.length + l.dealsNoCard.length + l.cardsNoDate.length + l.invoicedNoDue.length + l.mismatch.length;
  if (total) await discord(`🟡 **Loose ends today (${total})**\n${lines.join('\n')}\nFix them in Notion, or tell me on WhatsApp what each one is.`, 'pm');
  await log({ event: `Loose ends ${today}`, outcome: 'Rule', email: { messageId: '' }, details: total ? lines.join('\n').slice(0, 1900) : 'Nothing loose today' });
  return total ? `${total} loose end(s)` : 'nothing loose';
}
