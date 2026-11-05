// Before the WhatsApp/chat PM answers, it gets a briefing on every deal the message names: who the brand contact is,
// the thread an email would go into, what was agreed, what is open, the video card and its date. Harsh, Nov 5: "if I
// tell my PM to send this or that, I want to make sure the PM knows what it is doing." Plain code, no AI, and only
// for messages that name a brand (a few hundred tokens each).
import { openDeals } from './briefs.js';

const key = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]/g, '');
const id32 = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();

export function namedDeals(text, deals) {
  const t = key(text);
  if (t.length < 4) return [];
  const hits = deals.filter((d) => d.stage !== 'Lost' && key(d.brand).length >= 4 && t.includes(key(d.brand)));
  // a creator named too narrows it ("speakon chris")
  const creatorNamed = hits.filter((d) => d.creator && t.includes(key(d.creator)));
  const list = creatorNamed.length ? creatorNamed : hits;
  // live deals first, then the newest
  return list.sort((a, b) => (['Paid'].includes(a.stage) - ['Paid'].includes(b.stage)) || String(b.lastBrand || '').localeCompare(String(a.lastBrand || ''))).slice(0, 3);
}

export async function dealBriefing(text) {
  const all = await openDeals({ withClosed: true }).catch(() => []);
  const hits = namedDeals(text, all);
  if (!hits.length) return '';
  let videos = [];
  try { videos = (await (await import('./tools.js')).allVideos({ quick: true })).videos || []; } catch { /* without the card */ }
  const memo = (m) => {
    const s = String(m || '').replace(/<br\s*\/?>/gi, '\n');
    const part = (name) => (s.split(new RegExp(`${name}:`, 'i'))[1] || '').split(/\n(?:AGREED|HISTORY|BILLING|OPEN NOW):/i)[0].trim();
    return [part('AGREED') && `agreed: ${part('AGREED').slice(0, 300)}`, part('OPEN NOW') && `open now: ${part('OPEN NOW').slice(0, 400)}`].filter(Boolean).join('\n  ');
  };
  const lines = hits.map((d) => {
    const v = videos.find((x) => id32(x.url || x.id) && id32(x.url || x.id) === id32(d.linkedVideo));
    const email = d.channel !== 'WhatsApp' && d.threadId;
    return [
      `• ${d.brand} x ${d.creator || '?'} · stage ${d.stage || '?'}${d.finalRate ? ` · $${d.finalRate}` : ''}`,
      email ? `  email goes to ${d.brandEmail || '(no brand email on file)'}${d.threadCc ? `, cc ${d.threadCc}` : ''}, in the thread "${d.threadSubject || 'on file'}"` : '  WhatsApp deal: the creator talks to the brand, so the PM never emails them; anything for the brand goes to the creator',
      `  next action: ${d.nextAction || 'none'}`,
      memo(d.memory) ? `  ${memo(d.memory)}` : '',
      v ? `  video card: "${v.title}" at ${v.status}${v.post_date ? `, posts ${v.post_date}` : ', NO post date'}` : '  no video card linked',
    ].filter(Boolean).join('\n');
  });
  return `[Deal briefing for this message (live data). Use it before acting, and say which deal and recipient you used.]\n${lines.join('\n')}`;
}
