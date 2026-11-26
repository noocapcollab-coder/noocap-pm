// Brand asks that fell through: the deal's memory says "We owe: …", the brand wrote last, and nothing is waiting in
// Approvals. That happens when a promise draft was rejected, when a rule shipped after the email arrived, or when the
// inbox read it wrong. Each one is put to Harsh on WhatsApp once (swipe-reply with the answer and it becomes the email),
// so nothing a brand asked for sits unanswered because no single email triggered the right path.
import { notion } from './notion.js';
import { DS } from './tools.js';
import { log } from './briefs.js';
import { pendingDraft } from './outbox.js';

// Cover images, thumbnails and captions are the editor's and script writer's work too (Dreamina x Chris, Nov 16:
// "send the updated cover image and caption" went to Harsh as an ask)
// Publishing and pinning a comment are the creator's and team's work as well (Manyfast x Chris, Nov 26:
// Seungjoo's approval, "publish on Nov 30, then the final 50% invoice", reached Harsh and Pratham as a swipe-reply ask)
const WORK = /\b(cut|edit(ed|s)?|revis(ed|ion)|script|film(ed|ing)?|upload|deliver(y|ed)?|footage|draft|cover(?: image)?|thumbnail|caption)\b/i;
const PUBLISH = /\b(publish(ed|ing)?|publication|post(?:ing)?\s+the\s+(?:video|reel)|go(?:es)?\s+live|pin(?:ned)?\s+(?:the\s+|it\b|a\s+)?(?:comment|text)?)\b/i;
// "send the final 50% invoice after publication" is the PM's own next step once the video is live, not a fact Harsh holds,
// and its "when" is not a date question. Pure.
export const withoutLaterInvoice = (s) => String(s || '').replace(/\b(?:and\s+)?(?:send|raise|issue|share)\s+(?:the\s+|an?\s+)?(?:final\s+|second\s+|remaining\s+|balance\s+)?(?:\d+\s*%\s+)?(?:payment\s+)?invoice\s+(?:after|once|when|following)\s+(?:the\s+)?(?:video\s+|reel\s+|it\s+)?(?:is\s+|goes\s+)?(?:publication|published|posting|posted|live|going\s+live)\b/gi, '').trim();
const INFO = /\b(code|codes|link|links|url|e-?mail|address|details|account|contract|sign|signature|rate|price|invoice|w-?9|tax|bank|paypal|confirm|confirmation|approval|analytics|stats|insights|screenshot|file|access)\b/i;
const day = (x) => String(x || '').slice(0, 10);
// The "already asked" mark for one brand email on one deal. The inbox writes it when it asks Harsh, so the heartbeat's
// sweep never asks the same thing again (system check Nov 20, CapCut x Brad: Alisa's 12:35 IST chase reached Pratham
// from the inbox and again 7 minutes later from the sweep, "(last brand email 2026-11-20) Brad's earliest timeline").
export const owedMark = (dealId, lastBrand) => `${dealId} ${day(lastBrand)}`;

// System check Nov 16 (Dreamina x Chris Artist Team): Jenny's chase for the watermark/cover fixes reached Harsh on
// WhatsApp as "make the requested revisions ... and send them to the brand" while Prateek already had the changes.
// An ask that is only work the team produces (cuts, revisions, scripts, uploads), with no date and nothing only we have,
// is never a Harsh ask: the editor/script flow answers it with the work itself.
export function teamWorkOnly(need) {
  const s = withoutLaterInvoice(need);
  if (!s.trim()) return false;
  return (WORK.test(s) || PUBLISH.test(s) || /\brevisions\b/i.test(s)) && !/\b(timeline|eta|when|date|schedule)\b/i.test(s) && !INFO.test(s);
}

// The open item, or null. Pure, so it can be tested.
export function owedItem(deal, today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)) {
  if (!deal || deal.paused || deal.channel === 'WhatsApp' || deal.stage === 'Lost') return null;
  // A Paid deal is done only until the brand writes again: SpeakOn x Chris was paid for reel 1, then Cassie sent the
  // reel 2 brief and asked when the script would come (Oct 30) and nobody answered for six days (Nov 5)
  if (deal.stage === 'Paid' && !(deal.lastBrand && deal.paidDate && day(deal.lastBrand) > day(deal.paidDate))) return null;
  const open = String(deal.memory || '').split(/OPEN NOW:/i)[1] || '';
  const m = open.match(/we owe:?\s*([^\n]+)/i);
  if (!m) return null;
  const owe = m[1].replace(/<br\s*\/?>.*$/i, '').trim().replace(/\.$/, '');
  const oweCore = withoutLaterInvoice(owe);
  if (!owe || /^(nothing|none|n\/a|-)\b/i.test(owe)) return null;
  // Only things a person has to hand over (codes, links, an email address, details, a signature, a yes/no). Work the team
  // produces (scripts, cuts, revised videos, uploads) already has its own flow through the editors and is never asked here.
  // A date for that work ("an estimated timeline for the first draft") is Harsh's call though, so it is asked
  const when = /\b(timeline|eta|when|date|schedule)\b/i.test(oweCore);
  if ((WORK.test(oweCore) && !when) || (!INFO.test(oweCore) && !when)) return null;
  if (PUBLISH.test(oweCore) && !INFO.test(oweCore) && !when) return null;
  // The brand spoke last, within the last 10 days
  if (!deal.lastBrand || (deal.lastOur && day(deal.lastOur) >= day(deal.lastBrand))) return null;
  const age = (Date.parse(today) - Date.parse(day(deal.lastBrand))) / 864e5;
  if (age > 10) return null;
  return { need: owe.slice(0, 300), since: day(deal.lastBrand) };
}

export async function sweepOwed(deals, { now } = {}) {
  const asked = [];
  for (const deal of deals) {
    if (asked.length >= 3) break; // never flood the chat in one run; the rest come next heartbeat
    const item = owedItem(deal, now);
    if (!item) continue;
    if (await pendingDraft(deal.id, 'Reply').catch(() => true)) continue;
    const mark = owedMark(deal.id, item.since);
    const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: 'Owed ask' } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length > 0).catch(() => true);
    if (seen) continue;
    const ask = { dealId: deal.id, brand: deal.brand, creator: deal.creator, need: item.need, threadId: deal.threadId || '', messageRfc: deal.messageRfc || '', subject: deal.threadSubject || '', brandEmail: deal.brandEmail || '', theirMessage: `(last brand email ${item.since}) ${item.need}` };
    try { const W = await import('./whatsapp.js'); await W.askForInfo(ask); } catch (e) { console.error('owed ask', e.message); }
    await log({ event: `Owed ask: ${deal.brand} × ${deal.creator}`, outcome: 'Alert', email: { messageId: '' }, deal, details: `${mark} · ${item.need}`, area: 'Brand deals', creator: deal.creator }).catch(() => {});
    asked.push(`${deal.brand} × ${deal.creator}`);
  }
  return asked;
}
