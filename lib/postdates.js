// Every live sponsor card needs a POST DATE: without one it is missing from the creator's calendar, nothing chases it
// and emails can't name a go-live date (SpeakOn x Chris (2) had none on Nov 5; Harsh had raised missing dates a month
// earlier and the PM only ever listed them). Each heartbeat: a card with a deal that has a deadline gets that date; the
// rest are put to Harsh once on WhatsApp, and his reply "date speakon 12 nov" sets it. A date is never guessed.
import { notion } from './notion.js';
import { DS, todayIST } from './tools.js';
import { log } from './briefs.js';

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const id32 = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
const LIVE = (n) => n >= 2 && n <= 11; // briefed and not posted yet

async function datePropOf(pageId) {
  const card = await notion('GET', `/pages/${pageId}`);
  const dp = Object.entries(card.properties || {}).find(([n, v]) => v.type === 'date' && /post/i.test(n) && !/posted/i.test(n));
  return { card, prop: dp ? dp[0] : null, value: dp ? dp[1].date?.start || null : null };
}

export async function setCardPostDate(pageId, day) {
  const { prop, value } = await datePropOf(pageId);
  if (!prop) throw new Error('that card has no POST DATE column');
  await notion('PATCH', `/pages/${pageId}`, { properties: { [prop]: { date: { start: day } } } });
  return value;
}

export async function fillPostDates() {
  const { allVideos } = await import('./tools.js');
  const { openDeals } = await import('./briefs.js');
  const today = todayIST();
  const [{ videos }, deals] = await Promise.all([allVideos({ quick: true }), openDeals()]);
  const missing = videos.filter((v) => v.sponsor && !v.post_date && LIVE(parseInt(String(v.status || ''), 10)));
  const filled = [], ask = [];
  for (const v of missing) {
    const d = deals.find((x) => id32(x.linkedVideo) && id32(x.linkedVideo) === id32(v.url || v.id));
    const deadline = d && String(d.deadline || '').slice(0, 10);
    if (deadline && deadline >= today) {
      await setCardPostDate(String(v.id), deadline).catch(() => null);
      filled.push(`${v.title} (${v.creator}) → ${deadline}`);
      continue;
    }
    const mark = id32(v.url || v.id);
    const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: 'Post date asked' } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length).catch(() => 1);
    if (!seen) ask.push({ v, mark });
  }
  if (ask.length) {
    const lines = ask.slice(0, 8).map(({ v }) => `• *${v.title}* (${v.creator}), card at ${String(v.status).replace(/^\d+\.?\d*-\s*/, '')}`);
    const text = `🙋 *${ask.length} sponsor card${ask.length > 1 ? 's have' : ' has'} no post date*, so ${ask.length > 1 ? 'they don\'t' : 'it doesn\'t'} show on the calendar:\n${lines.join('\n')}\n\nReply like *date speakon 12 nov* and I'll set it.`;
    try { const W = await import('./whatsapp.js'); await W.forward(text); } catch (e) { console.error('post date ask', e.message); }
    for (const { v, mark } of ask.slice(0, 8)) await log({ event: `Post date asked: ${v.title}`.slice(0, 118), outcome: 'Alert', email: { messageId: '' }, details: mark, area: 'Brand deals', creator: v.creator }).catch(() => {});
  }
  return { filled, asked: ask.map(({ v }) => v.title) };
}

// "date speakon 12 nov" / "post date semrush nov 20": set the date on that creator's card that has none
export function parseDateCommand(t, now = new Date()) {
  const m = String(t || '').trim().match(/^(?:post\s+)?date\s+(.+?)\s+((?:\d{1,2}\s+[a-z]{3,9})|(?:[a-z]{3,9}\s+\d{1,2})|(?:\d{4}-\d{2}-\d{2}))\s*$/i);
  if (!m) return null;
  const raw = m[2];
  let day = /^\d{4}-/.test(raw) ? raw : null;
  if (!day) {
    const parsed = new Date(`${raw} ${now.getUTCFullYear()} 12:00 UTC`);
    if (Number.isNaN(parsed.getTime())) return null;
    if (parsed.getTime() < now.getTime() - 60 * 864e5) parsed.setUTCFullYear(parsed.getUTCFullYear() + 1);
    day = parsed.toISOString().slice(0, 10);
  }
  return { brand: m[1].trim(), day };
}

export async function setDateFromChat(brandText) {
  const { allVideos } = await import('./tools.js');
  const { videos } = await allVideos({ quick: true });
  const b = key(brandText.brand);
  let hits = videos.filter((v) => v.sponsor && LIVE(parseInt(String(v.status || ''), 10)) && key(v.title).includes(b));
  const undated = hits.filter((v) => !v.post_date);
  if (undated.length) hits = undated;
  if (hits.length !== 1) return { error: hits.length ? `more than one card matches: ${hits.map((v) => `${v.title} (${v.creator})`).join(', ')}. Add more of the name.` : `no live sponsor card matches "${brandText.brand}"` };
  const before = await setCardPostDate(String(hits[0].id), brandText.day);
  return { ok: true, title: hits[0].title, creator: hits[0].creator, day: brandText.day, before };
}
