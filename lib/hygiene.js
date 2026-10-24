// PM · Data check. Once a morning, lists the board cards and deals whose missing or placeholder data stops the
// automation from working (a card called "NA" can't get a script, a deal without a rate can't be invoiced), grouped so
// whoever owns it can fix it in a minute. Posted to #pm-alerts. Nothing is changed automatically.
import { notion } from './notion.js';
import { DS, allVideos, todayIST } from './tools.js';
import { openDeals, discord, log } from './briefs.js';
import { stageBefore } from './outbox.js';

export const PLACEHOLDER = /^(n\/?a|tbd|tba|repost|idea|untitled|new( video)?|test|video|x|-+|\.+|\?+)$/i;
const num = (status) => parseInt(String(status || ''), 10) || 0;
const day = (s) => (s ? String(s).slice(0, 10) : '');
const short = (s, n = 50) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export async function dataProblems() {
  const today = todayIST();
  const twoDaysAgo = new Date(Date.parse(today) - 2 * 864e5).toISOString().slice(0, 10);
  // Older than 3 weeks is history nobody will act on: leave it out so the list stays short and real
  const floor = new Date(Date.parse(today) - 21 * 864e5).toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.parse(today) + 14 * 864e5).toISOString().slice(0, 10);
  const { videos } = await allVideos();
  const cards = {}; // creator -> lines
  const add = (c, line) => (cards[c] ||= []).push(line);
  for (const v of videos) {
    const n = num(v.status);
    if (n < 1 || n > 11) continue; // posted, repost and archive are history
    const pd = day(v.post_date);
    const t = String(v.title || '').trim();
    if (pd && pd < floor) continue;
    // A placeholder name only matters once the card is close to going out
    if ((!t || t.length < 3 || PLACEHOLDER.test(t)) && (!pd || pd <= inTwoWeeks)) add(v.creator, `"${t || 'no title'}" has no real title (${v.status}${pd ? `, posts ${pd}` : ''})`);
    if (!pd && n >= 6) add(v.creator, `"${short(t)}" is at ${v.status} but has no post date`);
    if (pd && pd < twoDaysAgo) add(v.creator, `"${short(t)}" was due ${pd} and is still at ${v.status}: post it or move the date`);
  }

  const deals = [];
  for (const d of await openDeals()) {
    const name = `${d.brand} × ${d.creator || '?'}`;
    if (!stageBefore(d.stage, 'Price Agreed') && !d.finalRate) deals.push(`${name}: no Final Rate USD, so the invoice can't be raised`);
    if (!d.brandEmail && d.channel !== 'WhatsApp' && !stageBefore(d.stage, 'Price Agreed')) deals.push(`${name}: no Brand Email, so the PM can't write to them`);
    if (!stageBefore(d.stage, 'Brief Received') && stageBefore(d.stage, 'Posted') && !d.linkedVideo) deals.push(`${name}: no video card linked, so filming and editing aren't tracked`);
    if (!d.creator) deals.push(`${name}: no creator set`);
  }
  return { cards, deals };
}

// The morning digest, once a day after 10:00 IST
export async function morningDataCheck({ force = false } = {}) {
  const today = todayIST();
  const hourIST = new Date(Date.now() + 5.5 * 36e5).getUTCHours();
  if (!force && hourIST < 10) return null;
  const tag = `Data check ${today}`;
  if (!force) {
    const done = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { equals: tag } } }).catch(() => ({ results: [] }));
    if ((done.results || []).length) return null;
  }
  const { cards, deals } = await dataProblems();
  const creators = Object.keys(cards).sort();
  const total = creators.reduce((n, c) => n + cards[c].length, 0) + deals.length;
  await log({ event: tag, outcome: 'Rule', email: { messageId: '' }, details: `${total} things to fix` }).catch(() => {});
  if (!total) return { total: 0 };
  const parts = [`🧾 **Data to fix today (${total})**: these stop the automation from working until someone fills them in`];
  for (const c of creators) parts.push(`**${c}** (board)\n` + cards[c].slice(0, 8).map((l) => '• ' + l).join('\n') + (cards[c].length > 8 ? `\n• …and ${cards[c].length - 8} more` : ''));
  if (deals.length) parts.push(`**Brand deals**\n` + deals.slice(0, 12).map((l) => '• ' + l).join('\n') + (deals.length > 12 ? `\n• …and ${deals.length - 12} more` : ''));
  // Discord caps a message at 2000 characters, so long digests go out in pieces
  let msg = '';
  for (const p of parts) {
    if ((msg + '\n\n' + p).length > 1900) { await discord(msg, 'pm').catch(() => {}); msg = p; } else msg = msg ? msg + '\n\n' + p : p;
  }
  if (msg) await discord(msg, 'pm').catch(() => {});
  return { total, creators: creators.length, deals: deals.length };
}
