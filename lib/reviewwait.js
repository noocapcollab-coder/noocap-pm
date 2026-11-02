// Cuts waiting for the team's check (EDIT TRACKER: In Review) that nobody has looked at. "Claude's own phone number"
// (Duncan) sat In Review from 30 Oct after Prabal's fix and missed its 31 Oct go-live because nothing reminded anyone.
// Once a day per row (from 10:00 IST), and right away when the go-live date is today, tomorrow or already passed.
import { notion, plain } from './notion.js';
import { DS } from './tools.js';
import { discord, log } from './briefs.js';

const WAIT_HOURS = 6;
const istDay = (t = Date.now()) => new Date(t + 5.5 * 36e5).toISOString().slice(0, 10);
const bare = (s) => String(s || '').replace(/-/g, '');

export function reviewUrgency(goLive, today) {
  if (!goLive) return 'none';
  if (goLive < today) return 'late';
  const d = Math.round((Date.parse(goLive) - Date.parse(today)) / 864e5);
  return d <= 1 ? 'soon' : 'later';
}

async function goLiveOf(videoId) {
  if (!videoId) return null;
  try {
    const p = await notion('GET', `/pages/${videoId}`);
    for (const [n, v] of Object.entries(p.properties || {})) if (v.type === 'date' && /post/i.test(n) && v.date?.start) return v.date.start.slice(0, 10);
  } catch { /* no card */ }
  return null;
}

export async function remindWaitingReviews({ force = false } = {}) {
  const today = istDay();
  const hour = new Date(Date.now() + 5.5 * 36e5).getUTCHours();
  const r = await notion('POST', `/data_sources/${DS.tracker}/query`, { page_size: 50, filter: { property: 'Status', select: { equals: 'In Review' } } }).catch(() => ({ results: [] }));
  const due = [];
  for (const p of r.results || []) {
    if (p.in_trash) continue;
    const waitedH = (Date.now() - Date.parse(p.last_edited_time)) / 36e5;
    if (waitedH < WAIT_HOURS) continue;
    const goLive = await goLiveOf(plain(p.properties?.['Video ID']));
    const urgency = reviewUrgency(goLive, today);
    if (!force && hour < 10 && urgency !== 'late' && urgency !== 'soon') continue;
    const marker = `Review waiting: ${bare(p.id)} ${today}`;
    const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { equals: marker } } }).then((x) => (x.results || []).length > 0).catch(() => true);
    if (seen) continue;
    due.push({ id: p.id, url: p.url, marker, title: plain(p.properties?.['Video Title']) || 'Untitled', creator: plain(p.properties?.Creator) || '?', editor: plain(p.properties?.Editor) || '', frame: plain(p.properties?.['Frame.io Link']) || '', days: Math.floor(waitedH / 24), goLive, urgency });
  }
  if (!due.length) return [];
  const order = { late: 0, soon: 1, later: 2, none: 3 };
  due.sort((a, b) => order[a.urgency] - order[b.urgency]);
  const when = (x) => (x.urgency === 'late' ? `⚠️ was due to go live ${x.goLive}` : x.goLive ? `goes live ${x.goLive}` : 'no go-live date');
  const lines = due.slice(0, 10).map((x) => `• **${x.title}** × ${x.creator}${x.editor ? ` (${x.editor})` : ''} · waiting ${x.days ? x.days + 'd' : 'since today'} · ${when(x)}${x.frame ? `\n  ${x.frame}` : ''}\n  → [Open row](${x.url})`);
  await discord(`👀 **${due.length === 1 ? 'A cut is' : `${due.length} cuts are`} waiting for your check** (In Review)\n${lines.join('\n')}\nSet each to **To Post** (personal) or **Send to Brand** (sponsor), or **Changes** if it needs fixes.`, 'pm');
  for (const x of due) await log({ event: x.marker, outcome: 'Alert', email: { messageId: '' }, details: `${x.title} × ${x.creator} waiting In Review ${x.days}d · ${when(x)}` }).catch(() => {});
  return due.map((x) => `${x.title} × ${x.creator}`);
}
