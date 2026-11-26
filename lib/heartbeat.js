// PM · Heartbeat. n8n calls /api/tick every few minutes.
// Looks at deals and their videos, drafts the emails that are due, and sends the morning brief once a day.
import { notion, plain, titleOf, pageIdOf } from './notion.js';
import { BOARDS, DS, todayIST, runTool, followGap, isWeekend } from './tools.js';
import { schemaOf, findProp } from './actions.js';
import { openDeals, setIf, discord, log, card } from './briefs.js';
import { createDraft, pendingDraft, writeEmail, stageBefore, OUTBOX_DS, addScriptCards, scriptCardUrls, carriesPostedLinks } from './outbox.js';
import { runDriveFolders } from './drive.js';
import { findIntakeRow, findIntakeRows, syncCardsFromIntake, syncBrandApprovalCards } from './intake.js';
import { syncMoney, moneyDigest } from './money.js';


// The newest email in a Gmail thread, from the Agent Log: who sent it (brand / ours), when, and its gist
async function lastThreadEmail(threadId) {
  if (!threadId) return null;
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Thread ID', rich_text: { equals: threadId } }, { property: 'From Side', select: { is_not_empty: true } }, { property: 'Email Date', date: { is_not_empty: true } }] }, sorts: [{ property: 'Email Date', direction: 'descending' }] }).catch(() => ({ results: [] }));
  const p = (r.results || [])[0];
  if (!p) return null;
  return { side: plain(p.properties?.['From Side']), at: String(plain(p.properties?.['Email Date']) || '').slice(0, 10), summary: String(plain(p.properties?.Rule) || '').replace(/^Brief catcher:\s*/, '').slice(0, 300) };
}

const MAX_DRAFTS_PER_TICK = 6;
// Autopilot: these email types send themselves after a hold, unless rejected in Approvals. PM_AUTOPILOT=off turns it off.
// Scripts: the PM drafts the email with the PDF and sends it itself after the hold. PM_SCRIPT_AUTOSEND=off makes script
// emails wait in Approvals instead; PM_SCRIPT_EMAILS=off stops drafting them at all (you send scripts by hand).
const SCRIPT_EMAILS = process.env.PM_SCRIPT_EMAILS !== 'off';
const SCRIPT_AUTO = SCRIPT_EMAILS && process.env.PM_SCRIPT_AUTOSEND !== 'off';
const KINDS_SET = [...new Set([...String(process.env.PM_AUTOPILOT_KINDS || 'Follow-up,Payment chase').split(',').map((k) => k.trim()).filter(Boolean), 'Follow-up', 'Payment chase', 'Tool access'])];
// Follow-ups and payment chases send themselves after the hold, no approval (Harsh, Nov 7: "the follow-up email
// shouldn't have my approval, so send it directly"). Kinds listed here would always wait for him.
// Invoices and billing-detail emails always wait for Harsh's tap, whatever PM_AUTOPILOT_KINDS or the scorecard says
// (Harsh, Nov 16: "keep invoice thing on approval")
export const ALWAYS_ASK = ['Invoice', 'Billing details'];

// A money ask never goes over the brand's own unanswered email (see the call in draft())
export function brandWaitingOnUs(deal, kind, now = Date.now()) {
  if (!['Payment chase', 'Billing details'].includes(kind)) return false;
  const t = (v) => { const x = Date.parse(String(v || '').replace(' ', 'T')); return Number.isFinite(x) ? x : 0; };
  const b = t(deal.lastBrand), o = t(deal.lastOur);
  return !!b && b > o && now - b < 5 * 864e5;
}
// A payment chase never goes while the live link the brand asked for is still ours to send. Gamut x Lindsay, Nov 20:
// Iddo asked for the second invoice "together with the live link"; only the invoice went, so our invoice email was the
// newest and brandWaitingOnUs let a chase through 3 days later (test bank gamut-lindsay-chase-without-live-link-nov20
// kept failing, bug hunter Nov 22). Owed = no Links Sent Date and either we hold a posted link nobody emailed, or the
// deal's Next Action / OPEN NOW says the brand wants the live link. Pure.
export function liveLinkOwed(deal, kind) {
  if (kind !== 'Payment chase' || !deal || deal.linksSent) return false;
  if (/https?:\/\//.test(String(deal.postedLinks || ''))) return true;
  const open = (String(deal.memory || '').split(/OPEN NOW:/i)[1] || '').split(/\n\s*\n|\n[A-Z][A-Z ]{3,}:/)[0];
  const want = /\b(live|posted|published)\s+(video\s+|reel\s+|post\s+)?links?\b|\blinks?\s+to\s+the\s+(live|posted|published)\b/i;
  return want.test(String(deal.nextAction || '')) || want.test(open);
}
export const AUTO_KINDS = process.env.PM_AUTOPILOT === 'off' ? [] : [...KINDS_SET, ...(SCRIPT_AUTO && !KINDS_SET.includes('Script') ? ['Script'] : [])].filter((k) => !ALWAYS_ASK.includes(k));
export const AUTO_HOLD_MIN = 30;
// Whose move it is, from the deal's Next Action: ours when we are revising, writing or editing, when it says what we owe,
// or when it names the creator doing something ("Chris to opt in on Creator.co"). Then the brand is not chased.
// System check Nov 6 (afternoon): the Invoice Due Date is often our own default (invoice + 3 days for Stripe, + 14
// otherwise), and the before-due chase quoted it to the brand as if agreed (Zeely "on track for payment by November
// 6th" when the terms say "due upon confirmation"; Softr "by November 22"). A due date only reaches a brand email when
// the deal's Payment Terms name one (Net N, N days, a date). Rule 49.
export function dueDateForBrand(deal) {
  if (!deal?.invoiceDue) return null;
  return /net\s*\d+|\d+\s*(business\s*)?days|\b\d{1,2}[\/.-]\d{1,2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(String(deal.paymentTerms || '')) ? deal.invoiceDue : null;
}

// System check Nov 6: before the due date, a "did the invoice reach you / is it on track" reminder is only for a brand
// that has gone quiet since the invoice. If the brand wrote back after the invoice and nothing of ours followed, they
// already told us where it stands ("scheduled for 13/11" Runway, "payment submitted" Dreamina): a soft check-in then
// just repeats our own question. The real chase still comes once the due date passes.
export function brandAnsweredInvoice(deal, beforeDue) {
  if (!beforeDue || !deal?.invoiceSent || !deal?.lastBrand) return false;
  const brand = String(deal.lastBrand), sent = String(deal.invoiceSent).slice(0, 10);
  if (brand.slice(0, 10) < sent) return false;
  return !deal.lastOur || brand >= String(deal.lastOur);
}

// The brand says it already paid and we are waiting for its proof: the next email is the receipt request, never a
// chase that says the money hasn't come (Zeely AI x Duncan, Nov 16: Victoria wrote on Nov 13 that the second half was
// sent, the receipt request was waiting in Approvals, and the heartbeat drafted 'we have not seen the $1,000 come through'
// on top of it; rejected by the afternoon check, rule 9).
export function paymentClaimPending(deal) {
  const na = String(deal?.nextAction || '');
  const open = (String(deal?.memory || '').split(/OPEN NOW:/i)[1] || '');
  const claim = /\b(says?|said|claims?|claimed)\b[^.\n]{0,40}\b(paid|payment (was |has been )?(sent|made))|payment confirmation|transfer (receipt|confirmation)|proof of payment|waiting for (their|the) (payment )?(proof|receipt|confirmation)/i;
  if (!claim.test(na) && !claim.test(open)) return false;
  // Only while the brand's claim is the newest word: a later email from them (or our receipt ask answered) re-opens chasing
  return !deal.lastOur || !deal.lastBrand || String(deal.lastBrand) >= String(deal.lastOur);
}

// A deal opened for a new campaign inside an old thread can carry the old deal's invoice fields by mistake (rule 54).
// Its "invoice" is then a copy: another, older deal on the same thread was invoiced the same day. Only the older deal
// chases that money (Dreamina x Chris BD-70, Nov 10: the new-campaign deal sent a $3,000 chase for the October invoice,
// two days before the date Kepan gave, system check Nov 11).
export function copiedInvoice(deal, deals = []) {
  if (!deal?.threadId || !deal?.invoiceSent) return false;
  const day = String(deal.invoiceSent).slice(0, 10);
  return deals.some((o) => o.id !== deal.id && o.threadId === deal.threadId && String(o.invoiceSent || '').slice(0, 10) === day
    && String(o.created || '') < String(deal.created || '') && !/^lost$/i.test(o.stage || ''));
}

// Our newest email to the brand: Last Our Reply, or a cut sent after it (the deal row can be older than this run's send)
export function latestOurEmail(deal, cutSent, anySent) {
  // System check Nov 14 (Tripo 3D x Lindsay / JEEVMEDIA): sends now run before the deal emails in the same heartbeat
  // (df6125d), so a follow-up auto-sent minutes ago is not yet in the deal's Last Our Reply. Its Sent row counts as our
  // newest email too, or a second "follow-up 1 of 5" is drafted and sent 40 minutes after the first.
  // A deal with no email dates at all (the creator handed it over and nobody wrote since: Valchy AI x Valeri, Nov 5 to
  // 17, never chased) counts the wait from the day the deal was opened
  let best = deal.lastOur || deal.scriptSent || deal.confirmed || deal.teamCc || deal.created || null;
  for (const at of [cutSent, anySent]) if (at && (!best || String(at).slice(0, 16) > String(best).slice(0, 16))) best = at;
  return best;
}

// System check Nov 14 (Runway AI x Chris): the PM's 'today' is India time but Notion's created_time is UTC, so a past-due
// chase written after 18:30 UTC on the due date still looked "written before the due date" and was retired and redrafted
// every 10 minutes (about 30 drafts in one night). Compare both in India time.
export function writtenBeforeDue(createdTime, due) {
  if (!createdTime || !due) return false;
  const t = Date.parse(createdTime);
  if (!Number.isFinite(t)) return false;
  return new Date(t + 5.5 * 36e5).toISOString().slice(0, 10) <= String(due).slice(0, 10);
}

// A payment chase the second check held as "Needs you" never sent itself again: rule 80 (Harsh, Nov 23, 18cdd30) says the
// second reader only logs on a chase, but drafts it held before that fix stayed in Approvals for good (afternoon check
// Nov 25: Dreamina x Chris BD-5's $3,000 past-due chase, written Nov 23 05:16 UTC, was still waiting two days later and
// blocked every newer reminder). After a day such a draft is retired and the next reminder replaces it. Holds for other
// reasons (a made-up detail, a stranger's address) stay with Harsh. Pure.
export function heldChaseToRetire(why, createdTime, now = Date.now()) {
  if (!/^Needs you:\s*second check says/i.test(String(why || ''))) return false;
  const t = Date.parse(createdTime || '');
  return Number.isFinite(t) && now - t > 24 * 36e5;
}

// True when an email went out less than `hours` ago (Sent At from PM OUTBOX). Used to stop a same-kind redraft in the
// heartbeat run that just sent it (Teamily AI x Brad, Nov 14).
export function sentWithinHours(sentAt, hours, now = Date.now()) {
  const t = Date.parse(sentAt || '');
  if (!Number.isFinite(t)) return false;
  return now - t >= -5 * 6e4 && now - t < hours * 36e5;
}

async function lastSentOf(dealId, kind) {
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: dealId } }, { property: 'Kind', select: { equals: kind } }, { property: 'Status', select: { equals: 'Sent' } }] }, sorts: [{ property: 'Sent At', direction: 'descending' }] });
  return (r.results || [])[0]?.properties?.['Sent At']?.date?.start || null;
}

// A Next Action that says outright the move is ours ("Waiting on us: provide Brad's production timeline", "We owe: ...")
// holds a follow-up even when the card sits at 9 from an older cut (CapCut x Brad, Nov 24: the card waited on Chris's old
// cut, so the follow-up asked Alisa about "the revised script for Brad" we had only promised; night check). Pure.
export function saysWaitingOnUs(nextAction) {
  return /^\s*(waiting (on|for) us\b|we owe\b)/i.test(String(nextAction || ''));
}

export function ourMoveText(nextAction, creator) {
  const t = String(nextAction || '');
  const c0 = String(creator || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "Waiting for Chris's team to send the script", "Waiting on our team / the editor / Rudraksh": the next move is ours,
  // so the brand is never chased for it (Bug hunter Nov 20: HoneyBook x Chris got "we will have it over to you shortly")
  const ours = `(our|the) (team|editor|script ?writer)|editors?|rudraksh|harsh|pratham|management|noocap|us${c0 ? `|${c0}('s)?( team)?` : ''}`;
  if (new RegExp(`^\\s*waiting (for|on) (${ours})\\b`, 'i').test(t)) return true;
  if (/^\s*waiting (for|on)\b/i.test(t)) return false;
  if (/^\s*(management|harsh|pratham)\b/i.test(t)) return true;
  // "Editor making the brand's changes", "Brad reshooting the video" are our move too (CapCut x Chris got a follow-up
  // promising the reshoot "within the next few days" while we owed the cut, system check Nov 9)
  if (/revising|writing|editing|making (the )?([\w']+ )?changes|re-?shoot|working on|we owe|opt[- ]?in|sign up|our side to|management to|harsh to/i.test(t)) return true;
  const c = String(creator || '').trim();
  return !!c && new RegExp(`^\\s*${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^.]{0,40}?\\bto\\b`, 'i').test(t);
}

const AUTOPILOT_FROM = process.env.PM_AUTOPILOT_FROM || '2026-09-29T14:00:00Z'; // drafts made before autopilot existed still wait for a person
// Chris's inbox: replies to a brand (quote, counter, close, rate hold, decline, reply) always wait in Approvals as drafts.
// Only the "are you still interested?" nudges send themselves. LEADS_AUTOPILOT_KINDS overrides, LEADS_AUTOPILOT=off stops them too.
export const LEAD_KINDS = String(process.env.LEADS_AUTOPILOT_KINDS || 'Lead follow-up').split(',').map((k) => k.trim()).filter(Boolean);
const LEADS_AUTO_FROM = process.env.LEADS_AUTOPILOT_FROM || '2026-10-03T00:00:00+05:30';
const autoKindsNow = () => (process.env.PM_AUTOPILOT === 'off' ? [] : [...AUTO_KINDS, ...(Date.now() >= Date.parse(LEADS_AUTO_FROM) && process.env.LEADS_AUTOPILOT !== 'off' ? LEAD_KINDS : [])].filter((k) => !ALWAYS_ASK.includes(k)));
const FOLLOW_UP_AFTER_DAYS = 3;
// Harsh, Nov 24: "keep chasing". Follow-ups, on-hold check-ins and payment reminders never stop after a set number:
// they keep going on the 3 / 5 / 9 weekday gaps (9 from the third on) until the brand answers
const MAX_FOLLOW_UPS = Infinity;
// Script approvals: up to 5 follow-ups, one every 3 days, then Harsh decides (Harsh, Nov 7)
const SCRIPT_FOLLOW_UPS = 5;
const SCRIPT_FOLLOW_GAP = 3;
const WAITING_ON_BRAND = ['Price Agreed', 'Script Sent', 'Submitted'];
// Our newest history line says we accepted their offer (or agreed a rate) and asked for the contract or brief: the deal is
// agreed and the brand owes us the next step, even while the stage still says Negotiating (Tripo 3D x Valeri, Nov 11 to
// 17: "us accepted $650 per video and requested contract", stage Negotiating, nobody chased Zeelot for 6 days)
export function weAcceptedAndAsked(memory) {
  const hist = String(memory || '').split(/HISTORY:/i)[1] || '';
  const lines = hist.split(/BILLING:|OPEN NOW:/i)[0].split(/<br\s*\/?>|\n/).map((l) => l.trim()).filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
  const last = lines[lines.length - 1] || '';
  return /^\d{4}-\d{2}-\d{2}\s+(us|noocap|we)\b/i.test(last.replace(/\s*\/\s*/g, ' ')) && /\b(accept|agree|confirm|works for us|happy to proceed)/i.test(last) && /\b(contract|brief|agreement)\b/i.test(last);
}
const pageIdFromUrl = (u) => pageIdOf(u);
const daysSince = (d) => (d ? Math.floor((new Date(todayIST()) - new Date(String(d).slice(0, 10))) / 864e5) : null);
// Whole days really gone by since a timestamp (a bare date falls back to calendar days). Follow-up waits use this:
// calendar days compared the IST date of today with the UTC date of our email, so a follow-up to Yulia was drafted at
// 00:05 IST on Nov 14 as "3 days" after our caption email of Nov 11 14:19 UTC, only 2 days 4 hours later
// (ElevenLabs x Duncan, system check Nov 14; lesson "A follow-up waits from our newest email" seen 3 times)
export const elapsedDays = (d, now = Date.now()) => (!d ? null : String(d).length <= 10 ? daysSince(d) : Math.max(0, Math.floor((now - Date.parse(d)) / 864e5)));
const istHour = () => new Date(Date.now() + 5.5 * 36e5).getUTCHours();

export function scriptSentFor(deal, video) {
  if (!deal?.scriptSent) return false;
  if (!video?.created) return true;
  return String(deal.scriptSent).slice(0, 10) >= String(video.created).slice(0, 10);
}

// ---- Several cards of one deal at Script Approval (CapCut × Lindsay, Nov 16: three videos, one brief) ----
// Harsh: the scripts of cards that reach 5 together go in ONE email with all the PDFs, in the deal's thread; a card
// that reaches 5 later goes on its own, in the same thread.
const normT = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
// "CapCut × Lindsay", "CapCut × Lindsay (2)", "CapCut x Lindsay #3", "CapCut video 2", "CapCut"
export function isDealCardTitle(title, brand, creator) {
  const b = normT(brand);
  if (!b) return false;
  // A bare number counts too: "UPFLUENCE × DUNCAN 2" (Nov 24: its script sat at 5 and never went to Upfluence)
  const n = normT(String(title || '').replace(/\s*(\(\s*\d+\s*\)|#\s*\d+|[-–]?\s*(video|reel|part|v)\s*\d+|\s\d{1,2})\s*$/i, ''));
  if (!n.startsWith(b)) return false;
  const rest = n.slice(b.length), c = normT(creator), first = normT(String(creator || '').split(/\s+/)[0]);
  return ['', c, first, 'x' + c, 'x' + first].includes(rest);
}

// A sibling card of an email deal ("CapCut × Lindsay (2)" next to the linked "CapCut × Lindsay") is not an orphan: the
// deal's Script email carries it (dealCards). Only the deal's first card sits in Linked Video, so the orphan check sent
// Harsh and Pratham "Script ready … send the brand on WhatsApp" PDFs for CapCut × Lindsay (2) and (3) though both
// scripts had already gone to Sophie by email (system check, Nov 16). WhatsApp deals still get the PDF.
export function cardOfEmailDeal(card, deals) {
  return (deals || []).some((d) => d && d.threadId && d.channel !== 'WhatsApp' && d.linkedVideo
    && String(d.creator || '').toLowerCase() === String(card?.creator || '').toLowerCase()
    && isDealCardTitle(card?.title, d.brand, d.creator));
}

// The page id at the end of a Notion link. Stripping every dash first glued the title's number to the id
// ("CapCut-Lindsay-2-4165…" read as "24165…"), so cards (2) and (3) looked unsent and got a second email (Nov 16)
export const hexId = (u) => pageIdOf(u) || '';

export function changesAfterCut(rows, ourLast) {
  return (rows || []).some((r) => r.status === 'Changes' && (!r.changesAt || !ourLast || String(r.changesAt).slice(0, 16) > String(ourLast).slice(0, 16)));
}

export function cardBelongsToDeal(cardMail, deal) {
  if (!cardMail) return true;
  const mails = `${deal.brandEmail || ''} ${deal.threadCc || ''}`.toLowerCase();
  if (mails.includes(cardMail)) return true;
  // same company domain (mia@ vs sophie@growmaxvalue.com) still counts
  const dom = cardMail.split('@')[1];
  return !!dom && !/^(gmail|outlook|hotmail|yahoo|icloud|proton|qq|163)\./.test(dom) && mails.includes(`@${dom}`);
}

// Card ids whose script already went in (or is waiting in) a Script email of this deal
async function scriptCardsCovered(dealId) {
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { and: [{ property: 'Deal', relation: { contains: dealId } }, { property: 'Kind', select: { equals: 'Script' } }] } }).catch(() => ({ results: [] }));
  const ids = new Set();
  for (const row of r.results || []) {
    const st = plain(row.properties?.Status);
    if (!['Draft', 'Sent', 'Approved', 'Sending'].includes(st)) continue;
    const ctx = (row.properties?.Context?.rich_text || []).map((t) => t.plain_text).join('');
    for (const u of [row.properties?.Video?.url, ...(ctx.match(/https?:\/\/\S+/g) || [])]) { const h = hexId(u); if (h) ids.add(h); }
  }
  return ids;
}


// The version of each card's script that last went to the brand ("fp <card>=<hash>" on Sent Script rows), and the cards
// already in a Script draft that hasn't gone yet
// A deal paid upfront (100% before the video) stays in the script step while its video is not posted: its first
// script AND any revised script after the brand's notes (system check Nov 20, Manyfast x Duncan). Pure, so it is tested.
export function upfrontScriptDeal(d, paidDaysAgo) {
  return !!(d && d.stage === 'Paid' && d.linkedVideo && d.paidDate && paidDaysAgo <= 30 && !String(d.postedLinks || '').trim());
}

// Sent Script rows (any deal) that carried this card, by its Video link or its "fp <card>=" fingerprint. Pure.
export function rowsCarryCard(rows, cardHex) {
  const h = String(cardHex || '').replace(/-/g, '').toLowerCase();
  return !!h && (rows || []).some((r) => String(r.video || '').replace(/-/g, '').toLowerCase().includes(h) || String(r.context || '').replace(/-/g, '').toLowerCase().includes(h));
}
async function cardScriptSentAnywhere(cardId) {
  const h = hexId(cardId);
  if (!h) return false;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 20, filter: { and: [{ property: 'Kind', select: { equals: 'Script' } }, { property: 'Status', select: { equals: 'Sent' } }, { or: [{ property: 'Video', url: { contains: h } }, { property: 'Context', rich_text: { contains: h } }] }] } }).catch(() => ({ results: [] }));
  return rowsCarryCard((r.results || []).map((p) => ({ video: p.properties?.Video?.url, context: (p.properties?.Context?.rich_text || []).map((t) => t.plain_text).join('') })), h);
}
async function scriptVersions(dealId) {
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { and: [{ property: 'Deal', relation: { contains: dealId } }, { property: 'Kind', select: { equals: 'Script' } }] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] }).catch(() => ({ results: [] }));
  const sent = new Map(); const pending = new Set(); const sentAt = new Map();
  for (const row of r.results || []) {
    const st = plain(row.properties?.Status);
    const ctx = (row.properties?.Context?.rich_text || []).map((t) => t.plain_text).join('');
    if (st === 'Sent') for (const m of ctx.matchAll(/fp ([0-9a-f]{32})=([0-9a-f]{12})/g)) sent.set(m[1], m[2]);
    if (st === 'Sent') { const at = plain(row.properties?.['Sent At']) || row.created_time; for (const u of [row.properties?.Video?.url, ...(ctx.match(/https?:\/\/\S+/g) || [])]) { const h = hexId(u); if (h && (!sentAt.has(h) || String(at) > String(sentAt.get(h)))) sentAt.set(h, at); } }
    if (['Draft', 'Sending', 'Approved'].includes(st)) for (const u of [row.properties?.Video?.url, ...(ctx.match(/https?:\/\/\S+/g) || [])]) { const h = hexId(u); if (h) pending.add(h); }
  }
  return { sent, pending, sentAt };
}


// When brand script changes were last marked on each card ("Script changes on card" in the AGENT LOG, see
// markScriptChanges in lib/inbox.js)
async function scriptChangesMarks(hexes) {
  const out = new Map();
  if (!hexes.length) return out;
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 50, filter: { and: [{ property: 'Event', title: { starts_with: 'Script changes on card' } }, { or: hexes.slice(0, 20).map((h) => ({ property: 'Details', rich_text: { contains: h } })) }] }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }).catch(() => ({ results: [] }));
  for (const row of r.results || []) { const h = (plain(row.properties?.Details).match(/[0-9a-f]{32}/) || [])[0]; if (h && !out.has(h)) out.set(h, row.created_time); }
  return out;
}

// A card back at 5 after the brand asked for script changes (marked after the last script email that carried it): the
// script there is the revised one, so it goes again. Pure.
export function changedSinceSent(cards, { sentAt, pending }, marks) {
  return cards.filter((c) => c.num === 5 && !/\bhold\b/i.test(c.title || '') && !pending.has(hexId(c.id)) && sentAt.has(hexId(c.id)) && marks.has(hexId(c.id)) && String(marks.get(hexId(c.id))) > String(sentAt.get(hexId(c.id))));
}

// Cards at 5 whose script changed since the version the brand got: a revised script to send again
export function revisedCards(cards, { sent, pending }, current) {
  return cards.filter((c) => c.num === 5 && !/\bhold\b/i.test(c.title || '') && !pending.has(hexId(c.id)) && sent.has(hexId(c.id)) && current[hexId(c.id)] && current[hexId(c.id)] !== sent.get(hexId(c.id)));
}

// The card's script is word for word the version the brand already got (same fingerprint as the last sent Script email),
// so sending it as "the revised script with your notes worked in" would hand them the old one again. AI Inspo x Duncan,
// Nov 23: the card was back at 5 with the unchanged script and the PM sent it twice (04:45 and 05:15 UTC) as revised;
// Jessie wrote back that she could not find any difference. Unknown fingerprints are not judged. Pure.
export function sameScriptAsSent({ sent } = {}, hex, fp) {
  return !!(fp && hex && sent?.has?.(hex) && sent.get(hex) === fp);
}

// Is this card's script still owed to the brand?
// Script rows (any deal) that already carry a card: a card's script that went from ANOTHER deal of the same brand and
// creator is not owed again. Runway AI x Chris, Nov 20: since 35312c9 the old October deal (Posted) reaches the script
// step, picked up the November card through dealCards, and drafted the script that had gone 30 minutes earlier from the
// November deal. Pure: rows are PM OUTBOX pages.
export function cardsScriptedElsewhere(rows) {
  const ids = new Set();
  for (const row of rows || []) {
    const st = plain(row.properties?.Status);
    if (!['Draft', 'Sent', 'Approved', 'Sending'].includes(st)) continue;
    const ctx = (row.properties?.Context?.rich_text || []).map((t) => t.plain_text).join('');
    for (const u of [row.properties?.Video?.url, ...(ctx.match(/https?:\/\/\S+/g) || [])]) { const h = hexId(u); if (h) ids.add(h); }
  }
  return ids;
}
async function scriptRowsForCards(cards) {
  const hexes = [...new Set((cards || []).map((c) => hexId(c.id)).filter(Boolean))].slice(0, 10);
  if (!hexes.length) return [];
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { and: [{ property: 'Kind', select: { equals: 'Script' } }, { or: hexes.flatMap((h) => [{ property: 'Video', url: { contains: h } }, { property: 'Context', rich_text: { contains: h } }]) }] } }).catch(() => ({ results: [] }));
  return r.results || [];
}

export function cardScriptOwed(card, { covered, scriptSent, now = Date.now() }) {
  if (!card || card.num !== 5 || /\bhold\b/i.test(card.title || '')) return false;
  if (covered?.has(hexId(card.id))) return false;
  // A card that has sat at 5 untouched for two weeks is old news, not a script still to send
  if (card.edited && now - Date.parse(card.edited) > 14 * 864e5) return false;
  // When no Script email of this deal went through the PM, a script Harsh sent himself after the card last changed
  // covers it (only the deal's Script Sent Date shows it)
  if (!covered?.size && scriptSent && card.edited && String(scriptSent).slice(0, 10) >= String(card.edited).slice(0, 10)) return false;
  return true;
}

// The deal's cards on the creator's board (the linked card plus same-name siblings), newest status read
export const dealCardsOf = (deal, linked) => dealCards(deal, linked);
const NEEDS_CARD = ['Brief Received', 'Script Approved', 'Submitted', 'Approved'];
export function dealsWithoutCard(deals) {
  return (deals || []).filter((d) => d && NEEDS_CARD.includes(d.stage) && !String(d.linkedVideo || '').trim() && !d.paused);
}
// The deal's own card already on the creator's board, to link instead of alerting Harsh (PM LESSONS "A deal past the
// brief always has a video card", Nov 22: PANDA SECURITY at 7 and ZEN UGC 1-3 existed but the deals' Linked Video was
// empty, so a "no video card" alert went out). Never a card another deal links to, never a posted card (last campaign's
// history); with several reels the earliest card is linked.
export function cardToLink(cards, deal, deals) {
  const taken = new Set((deals || []).filter((d) => d && d.id !== deal?.id && d.linkedVideo).map((d) => hexId(d.linkedVideo)));
  const live = (cards || []).filter((v) => v && v.id && !taken.has(hexId(v.id)) && !(v.num >= 12) && !/^(12|13)\b|archive/i.test(String(v.status || '')));
  live.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
  return live[0] || null;
}
export const videoInfoOf = (url) => videoInfo(url);
// Deals whose cards are at 5- Script Approval or 4.8- Script Changes right now (one query per creator board), so the
// deal loop handles them before anything else
export function scriptCardDeals(deals, cards) {
  return deals.filter((d) => cards.some((c) => (d.linkedVideo && hexId(d.linkedVideo) === hexId(c.id)) || (c.creator === d.creator && isDealCardTitle(c.title, d.brand, d.creator))));
}
async function scriptReadyDeals(deals) {
  const cards = [];
  for (const b of BOARDS) {
    try {
      const r = await notion('POST', `/data_sources/${b.ds}/query`, { page_size: 30, filter: { property: 'Status', status: { equals: '5- Script Approval Brand/Creator' } } });
      const r2 = await notion('POST', `/data_sources/${b.ds}/query`, { page_size: 30, filter: { property: 'Status', status: { equals: '4.8- Script Changes' } } }).catch(() => ({ results: [] }));
      for (const p of [...(r.results || []), ...(r2.results || [])]) if (!p.in_trash) cards.push({ id: p.id, creator: b.creator, title: titleOf(p) });
    } catch { /* board without that status */ }
  }
  return scriptCardDeals(deals, cards);
}

async function dealCards(deal, linked) {
  const out = linked ? [linked] : [];
  const board = BOARDS.find((b) => b.creator === deal.creator);
  if (!board || !deal.brand) return out;
  try {
    const schema = await schemaOf(board.ds);
    const titleProp = Object.entries(schema).find(([, v]) => v.type === 'title')?.[0];
    if (!titleProp) return out;
    const r = await notion('POST', `/data_sources/${board.ds}/query`, { page_size: 25, filter: { property: titleProp, title: { contains: String(deal.brand).split(/\s+/)[0] } } });
    for (const page of r.results || []) {
      if (page.archived || page.in_trash || out.some((c) => hexId(c.id) === hexId(page.id))) continue;
      if (!isDealCardTitle(titleOf(page), deal.brand, deal.creator)) continue;
      // Two deals with the same brand and creator (CapCut × Chris: Mia's GrowMaxValue deal and Alisa's old one switched
      // to Brad, Nov 16): a card that names its brand's email belongs only to the deal with that email
      const cardMail = (String(plain(page.properties?.['Brand Email']) || '').toLowerCase().match(/[^\s<>()"'\[\]]+@[^\s<>()"'\[\]]+\.[a-z]{2,}/) || [])[0];
      if (!cardBelongsToDeal(cardMail, deal)) continue;
      // Only recent cards: an old reel of a brand we worked with months ago is not part of this deal
      if (Date.now() - Date.parse(page.created_time || 0) > 60 * 864e5) continue;
      const v = await videoInfo(page.url);
      if (v) out.push(v);
    }
  } catch (e) { console.error('deal cards', deal.brand, e.message); }
  return out;
}

async function videoInfo(url) {
  const id = pageIdFromUrl(url);
  if (!id) return null;
  try {
    const page = await notion('GET', `/pages/${id}`);
    let status = '', postedUrl = null, postDate = null;
    for (const [name, p] of Object.entries(page.properties || {})) {
      const n = name.toLowerCase();
      if (n === 'status') status = plain(p) || '';
      if (p.type === 'date' && /post/.test(n) && p.date?.start) postDate = p.date.start.slice(0, 10);
      if (p.type === 'url' && p.url && (/posted/.test(n) || /^(ig|instagram|yt|youtube|tiktok|tt)\b/.test(n))) postedUrl = postedUrl ? `${postedUrl}\n${p.url}` : p.url;
    }
    const brandEmail = String(plain(page.properties?.['Brand Email']) || '').toLowerCase().match(/[^\s<>()"'\[\]]+@[^\s<>()"'\[\]]+\.[a-z]{2,}/)?.[0] || '';
    return { id, url: page.url, title: titleOf(page), status, num: parseInt(status, 10), postedUrl, postDate, edited: page.last_edited_time, created: page.created_time, brandEmail };
  } catch {
    return null;
  }
}

// Has this exact Frame.io link already gone to the brand, is it waiting in Approvals, or did Harsh reject it?
// Frame.io keeps one link per video and stacks new versions on it, so a revised cut usually arrives on the SAME link
// as the first cut. "Already shared" therefore means: an email with this link written after the brand asked for the
// changes (since), not any email ever.
// Fills a deal's missing brand email / thread from its linked lead (the Leads row keeps the email thread)
export async function contactFromLead(deal) {
  const r = await notion('POST', `/data_sources/${DS.leads || 'a63d1576-b2b7-41c0-822e-57d54b224f6d'}/query`, { page_size: 1, filter: { property: 'Deal', relation: { contains: deal.id } } });
  const lead = (r.results || [])[0];
  if (!lead) return false;
  const g = (n) => String(plain(lead.properties?.[n]) || '').trim();
  const fill = leadContactFill(deal, { email: g('Brand Email'), messageId: g('Message ID'), threadId: g('Thread ID'), subject: g('Thread Subject'), creator: deal.creator });
  if (!Object.keys(fill.props).length) return false;
  // setIf writes each value in the column's own type (email, text...)
  const schema = await schemaOf(DS.deals);
  const p = {};
  for (const [k, v] of Object.entries(fill.props)) setIf(schema, p, k, v);
  if (!Object.keys(p).length) return false;
  await notion('PATCH', `/pages/${deal.id}`, { properties: p });
  Object.assign(deal, fill.deal);
  return true;
}

// What to copy: only empty fields, only a real address. A Message-ID also serves as the thread (the sender finds the
// Gmail thread from it, see approveAndSend). Lindsay's mail lives in her own inbox, so it is copied on every reply.
export function leadContactFill(deal, lead) {
  const rt = (s) => String(s);
  const props = {}, out = {};
  if (!deal.brandEmail && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(lead.email || '')) { props['Brand Email'] = lead.email; out.brandEmail = lead.email; }
  const mid = /^<?[^<>\s]+@[^<>\s]+>?$/.test(lead.messageId || '') ? lead.messageId : '';
  if (!deal.messageRfc && mid) { props['Message ID'] = rt(mid); out.messageRfc = mid; }
  // A lead's hex thread id belongs to the creator's own Gmail (Chris), not noocapcollab's: use the Message-ID, and the
  // send step finds noocapcollab's copy of the thread from it (or by subject)
  if (!deal.threadId && mid) { props['Thread ID'] = rt(mid); out.threadId = mid; }
  if (!deal.threadSubject && lead.subject) { props['Thread Subject'] = rt(lead.subject); out.threadSubject = lead.subject; }
  if (!deal.threadCc && /lindsay/i.test(lead.creator || '')) { props['Thread CC'] = rt('collab@automateaiconsulting.com'); out.threadCc = 'collab@automateaiconsulting.com'; }
  return { props, deal: out };
}

// The day our side (NOOCAP or the creator's team) already emailed one of these posted links, from the deal's 📨
// transcript lines, or ''. Pure.
export function linksEmailedBefore(lines = [], postedLinks = '') {
  for (const l of lines) {
    const head = String(l).split('\n')[0];
    const m = head.match(/^📨\s*(\d{4}-\d{2}-\d{2})\s*·\s*(us \(NOOCAP\)|[^·]*'s team)\s*·/i);
    if (m && carriesPostedLinks(String(l).slice(head.length), postedLinks)) return m[1];
  }
  return '';
}

async function frameAlreadyShared(dealId, frame, since) {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [
    { property: 'Deal', relation: { contains: dealId } }, { property: 'Body', rich_text: { contains: frame.slice(0, 90) } },
    ...(since ? [{ timestamp: 'created_time', created_time: { after: new Date(since).toISOString() } }] : []),
    // a draft you rejected counts too: rejecting it means "don't send this cut", so it is never drafted again
    { or: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Status', select: { equals: 'Sent' } }, { property: 'Status', select: { equals: 'Rejected' } }] },
  ] } });
  return (res.results || []).length > 0;
}

// Where this run's deal loop starts: the deal the previous heartbeat stopped before (its step reads "Deal emails (N of M
// deals, next: Brand × Creator)"), otherwise half the list further on every 10 minutes. Pure.
export function dealLoopStart(deals = [], prevSteps = '', now = Date.now()) {
  const m = String(prevSteps || '').match(/Deal emails \(\d+ of \d+ deals, next: (.+)\) · \d+ms/);
  if (m) { const i = deals.findIndex((d) => `${d.brand} × ${d.creator}` === m[1].trim()); if (i >= 0) return i; }
  return deals.length ? (Math.floor(now / 6e5) * Math.ceil(deals.length / 2)) % deals.length : 0;
}

// The Steps text of the last finished heartbeat in PM RUNS
async function lastHeartbeatSteps() {
  const r = await notion('POST', '/data_sources/caf1a59e-ec98-4af1-b522-b4a23aa5d1e3/query', { page_size: 1,
    filter: { and: [{ property: 'Job', select: { equals: 'Heartbeat' } }, { property: 'Status', select: { does_not_equal: 'Running' } }] },
    sorts: [{ property: 'Started', direction: 'descending' }] });
  return plain(r.results?.[0]?.properties?.Steps) || '';
}

// Vercel stops the function at 300s. Stop starting new work well before that so the run always finishes and
// writes its row (a killed run stays "Running" and n8n shows it as failed). Whatever was skipped runs next tick.
const TIME_BUDGET_MS = 170 * 1000;
// The steps after Invoices only get time on the short ticks. The 30-minute work (every15: minute % 15 < 5, so the :04
// and :34 ticks) makes the Invoices step run 75 to 95 s, so those ticks always pass the budget before the end of the
// run. The hourly jobs at the end of the tick were gated on "minute < 10", which is that same :04 tick, so Brand pool,
// the hourly "Updates, nothing needed from you" digest, the unsigned-contract alert, the WhatsApp re-open template check
// and the 11:30 IST raw-folder opener never ran (Queued FYI rows piled up unsent from Nov 9 to Nov 21; bug hunter).
// They now run on the one tick in minutes 5 to 14, which never overlaps a 30-minute slot for any 10-minute cadence. Pure.
export const every15Tick = (m) => m % 15 < 5;
export const hourlyTailTick = (m) => m >= 5 && m < 15;

export async function runHeartbeat({ force = false, report: given } = {}) {
  let last = Date.now();
  const T0 = Date.now();
  const late = () => Date.now() - T0 > TIME_BUDGET_MS;
  const skipped = [];
  // The tick's slot comes from the minute the tick STARTED. The hourly tail jobs read the clock when they were reached,
  // about two minutes into the :14 tick (minute 16), so hourlyTailTick was never true and Brand pool, the FYI digest,
  // the contract alert and the template check still never ran after 0f85a31 (bug hunter, Nov 21).
  const tickMin = new Date(T0).getUTCMinutes();
  // Slow, non-urgent parts run every 30 minutes instead of every 10, to go easy on Notion and Vercel usage
  const every15 = force || every15Tick(tickMin);
  const report = given || { drafts: [], handed_to_harsh: [], brief: null, errors: [], steps: [] };
  // Time each part of the tick for the Runs page
  const mark = (name) => { report.now = 'after ' + name; const errs = report.errors.length; report.steps.push({ name, ms: Date.now() - last, ok: errs === (mark.errs || 0) }); mark.errs = errs; last = Date.now(); };
  const allDeals = await openDeals({ withClosed: true });
  const deals = allDeals.filter((d) => !['Paid', 'Lost'].includes(d.stage));
  // Deals paid upfront (100% before the video) are Paid while their script still has to go out. openDeals() leaves Paid
  // out, so they never reached the script step and Manyfast x Duncan's script, promised "today" on Nov 19, never went
  // (Harsh, Nov 20). They join the loop for the script step only: paid in the last 30 days, a card, no script sent yet.
  const upfrontPaid = allDeals.filter((d) => upfrontScriptDeal(d, daysSince(d.paidDate))).map((d) => ({ ...d, upfrontOnly: true }));
  mark('Read brand deals');
  // The brand contacts on every sponsor card, copied from its deal. Hourly, and early in the run: at the end of the
  // tick it was skipped every time the run went past its time budget, so no card was ever filled (Harsh, Nov 10)
  if (force || tickMin < 10) {
    try { const { syncBrandEmails } = await import('./brandemails.js'); const ch = await syncBrandEmails(deals.filter((d) => !['Lost'].includes(d.stage))); report.steps.push({ name: `Brand Email on cards: ${ch.length} updated`, ms: 0, ok: true }); if (ch.length) report.brand_emails = ch; } catch (e) { report.errors.push('brand emails on cards: ' + String(e.message).slice(0, 120)); }
  }
  // Editor said "done" on the CTAs (Video Intake To Post / Posted) but the board card stayed behind: catch it up
  try { const { harshBoardToEditors } = await import('./harshboard.js'); const sent = await harshBoardToEditors(); if (sent.length) { report.steps.push({ name: `Harsh's board sent to editors: ${sent.length}`, ms: 0, ok: true }); report.drafts.push(...sent.map((x) => `Editor ping (Harsh's board): ${x}`)); } } catch (e) { report.errors.push(`Harsh's board: ${String(e.message).slice(0, 120)}`); }
  // Once an hour: open deals with no Platforms yet get them from the deliverables, the deal memory or the lead (lib/platforms.js)
  // Any card with a brief but no POST DATE gets one, whatever path made it (Harsh, Nov 26)
  if (tickMin < 10) { try { const { fillMissingPostDates } = await import('./briefs.js'); const set = await fillMissingPostDates(); if (set.length) report.drafts.push(...set.map((x) => `Post date set: ${x}`)); } catch (e) { report.errors.push(`Post dates: ${String(e.message).slice(0, 120)}`); } }
  if (tickMin < 10) { try { const { fillDealPlatforms } = await import('./platforms.js'); const set = await fillDealPlatforms(); if (set.length) report.drafts.push(...set.map((x) => `Platforms set: ${x}`)); } catch (e) { report.errors.push(`Platforms: ${String(e.message).slice(0, 120)}`); } }
  // Once an hour: deals owing more videos than the creator's board has cards (lib/missingcards.js)
  if (tickMin < 10) { try { const { missingVideoCards } = await import('./missingcards.js'); const added = await missingVideoCards(); if (added.length) report.drafts.push(...added.map((x) => `Missing card added: ${x}`)); } catch (e) { report.errors.push(`Missing cards: ${String(e.message).slice(0, 120)}`); } }
  // Editor reminders: a video sitting too long at one stage, tightened by its go-live date (lib/editornudge.js)
  try { const { editorNudges } = await import('./editornudge.js'); const sent = await editorNudges(); if (sent.length) { report.steps.push({ name: `Editor reminders: ${sent.length}`, ms: 0, ok: true }); report.drafts.push(...sent.map((x) => `Editor reminder: ${x}`)); } } catch (e) { report.errors.push(`Editor reminders: ${String(e.message).slice(0, 120)}`); }
  try { const moved = await syncCardsFromIntake(); if (moved.length) { report.steps.push({ name: 'Cards caught up to To Post', ms: 0, ok: true }); report.cards_moved = moved; } } catch (e) { report.errors.push(`Card sync: ${String(e.message).slice(0, 120)}`); }
  try { const moved = await syncBrandApprovalCards(); if (moved.length) { report.steps.push({ name: 'Cards with the brand moved to 9- Approval', ms: 0, ok: true }); report.cards_moved = [...(report.cards_moved || []), ...moved]; } } catch (e) { report.errors.push(`Approval card sync: ${String(e.message).slice(0, 120)}`); }
  // Sends and Drive folders run before the deal emails (Nov 14): the deal emails grew to ~2 minutes a tick, and both of
  // these sat at the end of the tick, so they were skipped as "out of time" on almost every run. Cards reached
  // 10- To Post with no Edited Video folder for two days (David Iya, Nov 12-13) and held drafts waited for hours.
  // 5a. Autopilot: send held drafts whose 30 minutes are up (evening log lists them)
  if (autoKindsNow().length) {
    try { report.autopilot = await runAutopilot(); } catch (e) { report.errors.push('autopilot: ' + String(e.message).slice(0, 150)); }
  }
  mark('Autopilot sends');
  // 5. Drive folders for videos that reached 6- To Film
  // Every tick, no longer every 15 minutes: it reads the shared board snapshot (about 100ms when there is nothing to
  // do), and a card that reached To Film just after a 15-minute slot waited up to half an hour for its links (Higgsfield
  // Short Drama x Lindsay, Nov 18)
  if (late()) { skipped.push('Drive folders'); } else try {
    report.drive = await runDriveFolders();
    const made = report.drive.made || [];
    const newF = made.filter((m) => !m.rawOnly); // Raw Footage backfills stay quiet
    if (newF.length) await discord(`📁 **Drive folders ready (${newF.length})**\n` + newF.map((m) => `• ${m.creator} · ${m.title} → [folder](${m.folder})${m.shared ? '' : ' ⚠️ share by hand'}`).join('\n'), 'log');
    for (const e of report.drive.errors || []) report.errors.push('drive ' + e);
  } catch (e) { report.errors.push('drive: ' + String(e.message).slice(0, 150)); }

  mark('Drive folders');
  let budget = MAX_DRAFTS_PER_TICK;
  // Two deal rows can end up on the same email thread (e.g. "Riverflow" and "Sourceful" for one campaign). A nudge
  // must look at the whole thread: skip it when a sibling deal is further along, or anyone wrote in the thread recently.
  const threadSays = (deal, kind) => {
    if (!/^(Follow-up|Payment chase)$/.test(kind) || !deal.threadId) return null;
    const sibs = deals.filter((d) => d.id !== deal.id && d.threadId && d.threadId === deal.threadId);
    if (!sibs.length) return null;
    const ahead = sibs.find((d) => !stageBefore(d.stage, deal.stage) && d.stage !== deal.stage);
    if (ahead) return `another deal on this thread (${ahead.brand}) is already at ${ahead.stage}`;
    const last = [deal, ...sibs].flatMap((d) => [d.lastOur, d.lastBrand]).filter(Boolean).map((x) => String(x).slice(0, 10)).sort().pop();
    if (last && daysSince(last) < followGap(deal.followUps || 0)) return `the thread had an email on ${last}`;
    return null;
  };
  const draft = async (kind, deal, args) => {
    if (budget <= 0) return;
    // While the AI is paused only invoice emails can be written (they use a plain template): the rest wait without
    // using up this run's draft budget, so an invoice further down the list still goes out
    if (kind !== 'Invoice') { const { aiPaused } = await import('./pause.js'); if (aiPaused()) return; }
    if (deal.channel === 'WhatsApp') return; // the creator runs this brand on WhatsApp: never email them
    // Money emails go to the address the brand gave for invoices (finance@…), with the usual contact on Cc
    if (['Payment chase', 'Invoice'].includes(kind)) {
      const { billingEmailOf } = await import('./invoicing.js');
      const be = billingEmailOf(deal.billing) || '';
      if (be && be !== String(deal.brandEmail || '').toLowerCase()) deal = { ...deal, brandEmail: be, threadCc: [deal.brandEmail, deal.threadCc].filter(Boolean).join(', ') };
    }
    // System check Nov 16 (ZenBusiness x Lindsay): a follow-up goes To whoever at the brand wrote last in the deal's
    // conversation (Natalie), with the old Brand Email moved to Cc, never to the first contact by default
    if (kind === 'Follow-up' && deal.id) {
      try {
        const M = await import('./memory.js');
        const { oursAddr } = await import('./outbox.js');
        const who = M.latestBrandSender(await M.readTranscript(deal.id, 20000));
        if (who && !oursAddr(who) && who !== String(deal.brandEmail || '').toLowerCase()) {
          const cc = [deal.brandEmail, ...String(deal.threadCc || '').split(/[,;]\s*/)].map((x) => String(x || '').trim()).filter((x) => x && x.toLowerCase() !== who);
          deal = { ...deal, brandEmail: who, threadCc: [...new Set(cc)].join(', ') };
        }
      } catch (e) { console.error('follow-up sender', e.message); }
    }
    // A check-in or chase must answer the brand in its own thread. A deal added by hand with no thread would go out as a
    // brand-new email to whoever is in Brand Email (it happened with Bluehost): skip it and leave it to a person.
    if (['Follow-up', 'Payment chase'].includes(kind) && (!deal.threadId || !deal.messageRfc)) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, the deal has no email thread to reply in`]; return; }
    // Gamut x Lindsay and Dreamina x Chris, Nov 20 (lesson "Answer the brand's question before chasing money", seen 3
    // times): a billing reminder or payment chase was drafted while the brand's newest email (hashtags to fix, a live
    // link to send) still waited for our answer. Money asks wait until we have answered; after 5 quiet days the usual
    // chase can go again so a "we'll pay on the 13th" never blocks the past-due chase for good
    // Harsh, Nov 23: "send reminders no matter what" (Gamut x Lindsay: the payment chase was held 5 days because the
    // live link was still owed). A payment chase is never held back: what would have stopped it goes into the email
    // instead (the live link, an answer to their last message, "we haven't seen it land yet")
    if (kind === 'Payment chase') {
      const notes = [];
      if (brandWaitingOnUs(deal, kind)) notes.push('Their latest email is still unanswered: answer it briefly first in this same email, then ask about the payment.');
      if (liveLinkOwed(deal, kind)) notes.push(/https?:\/\//.test(String(deal.postedLinks || '')) ? `They asked for the live link and never got it: include it in this email (${String(deal.postedLinks).replace(/\s+/g, ' ').slice(0, 300)}).` : 'They asked for the live link and we have not sent it: say it is coming right after this.');
      const said = threadSays(deal, kind);
      if (said) notes.push(`Keep in mind: ${said}. Still ask, politely, when we can expect the payment.`);
      if (notes.length) args = { ...args, facts: { ...(args?.facts || {}), must_also: notes.join(' ') } };
    } else {
      if (brandWaitingOnUs(deal, kind)) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, the brand's latest email is still waiting for our answer`]; return; }
      const skip = threadSays(deal, kind);
      if (skip) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, ${skip}`]; return; }
    }
    if (!args.sameAs && await pendingDraft(deal.id, kind)) return; // sameAs: a cut for another video is its own email
    // System check Nov 14 (Teamily AI x Brad): sends run before the deal emails in the same heartbeat, so a Script
    // auto-sent at 12:14 left no Draft behind and the deal loaded at the start of the run still had no Script Sent Date:
    // a second Script draft was written a minute later. An email of the same kind sent on this deal in the last 12 hours
    // means it went out already (a revised script or a cut for another video passes facts.revised / sameAs).
    if (!args.sameAs && !args.replaces && !args.facts?.revised) {
      const at = await lastSentOf(deal.id, kind).catch(() => null);
      if (sentWithinHours(at, 12)) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, one was sent ${String(at).slice(0, 16)}`]; return; }
    }
    // Rejected, retired or expired in the last 3 days: don't pay the AI to write it again every 10 minutes
    // args.replaces: this draft replaces one the PM itself just retired (past-due chase), so the 3-day pause doesn't apply
    // (Zeely x Duncan, Nov 7: the before-due chase was retired at midnight and its replacement was blocked, so no chase went out)
    if (!args.replaces) { const { recentlyDropped } = await import('./outbox.js'); if (await recentlyDropped({ dealId: deal.id, kind, lastEmail: [deal.lastBrand, deal.lastOur] })) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, a draft was rejected or removed and no new email came in since`]; return; } }
    budget--;
    try {
      const mail = await writeEmail({ kind, deal, facts: args.facts || {} });
      // a link the email must carry (e.g. the Frame.io cut) goes in even if the writer forgot it
      const must = args.facts?.frame_io_link;
      if (must && !String(mail.body).includes(must)) mail.body = String(mail.body).replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\nReview link: ${must}\n${sig}`);
      if (must && !String(mail.body).includes(must)) mail.body += `\n\nReview link: ${must}`;
      // Notes the team wrote under NOTES on the script card go into the Script email word for word (CapCut x Brad, Nov 25:
      // "Please send them this:" and a paragraph on the hook and the caption CTA)
      if (kind === 'Script' && args.video) {
        try {
          const { scriptNotes } = await import('./pdf.js');
          const notes = await scriptNotes(hexId(args.video));
          if (notes && !String(mail.body).includes(notes.slice(0, 60))) {
            mail.body = /\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i.test(mail.body) ? String(mail.body).replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\n${notes}\n${sig}`) : `${mail.body}\n\n${notes}`;
          }
        } catch (e) { console.error('script notes', e.message); }
      }
      // The Stripe pay link is filled in when Harsh approves; make sure the email has a place for it
      if (args.stripeInvoice && !String(mail.body).includes('{{invoice_link}}')) mail.body = String(mail.body).replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\nYou can pay here: {{invoice_link}}\n${sig}`);
      if (args.stripeInvoice && !String(mail.body).includes('{{invoice_link}}')) mail.body += `\n\nYou can pay here: {{invoice_link}}`;
      // Without the brand's thread and message ID the email would start a NEW conversation (Weglot × Lindsay script,
      // Nov 1): it never sends itself, it waits in Approvals marked "Needs you" (autopilot skips those)
      const noThread = !deal.threadId || !deal.messageRfc;
      const auto = !noThread && AUTO_KINDS.includes(kind) && !['Invoice', 'Billing details'].includes(kind);
      let why = noThread ? `Needs you: no email thread on file for this deal, so this would go out as a NEW email instead of a reply. Send it from the brand's thread yourself, or reject it. · ${args.why}` : auto ? `${args.why} Sends on its own in ${AUTO_HOLD_MIN} min unless you reject it.` : args.why;
      // The writer took out made-up business or legal details (rule 71): held for Harsh, and he is told, since only he has them
      if (mail.needsYou && !/^Needs you/i.test(why)) why = `Needs you: ${mail.needsYou} · ${args.why}`;
      const r = await createDraft({ kind, deal, subject: mail.subject, body: mail.body, stripeInvoice: args.stripeInvoice, attach: args.attach || 'None', video: args.video || deal.linkedVideo, why, notify: !auto || !!mail.needsYou, sameAs: args.sameAs, context: args.context });
      if (r.created) report.drafts.push(`${kind}: ${deal.brand} × ${deal.creator}`);
      if (r.created && kind === 'Draft video') { const { retireRepliesFor } = await import('./outbox.js'); const n = await retireRepliesFor(deal.threadId, r.id).catch(() => 0); if (n) report.drafts.push(`${deal.brand}: ${n} older reply draft(s) replaced by the cut email`); }
      if (r.created && auto && kind === 'Script' && !/^Needs you/i.test(why)) await discord(`📝 **Script going to ${deal.brand} · ${deal.creator}** in ${AUTO_HOLD_MIN} min\n• ${args.facts?.video_titles ? `${args.facts.video_titles.length} scripts (${args.facts.video_titles.join(', ')}) with all the PDFs attached` : `"${args.facts?.video_title || 'script'}" with the PDF attached`}, replying in their email thread. Reject it in Approvals to stop it`, 'pm');
      if (r.created) return true;
    } catch (e) {
      report.errors.push(`${kind} ${deal.brand}: ${e.message.slice(0, 150)}`);
    }
  };

  const moveToPosted = async (deal, video) => {
        // 2a. The video card says Posted but the deal is still at an earlier stage (Luma AI × Brad sat at Script Approved
        //     after posting): move it to Posted, which is what starts the invoice. Lost/Invoiced/Paid are left alone.
        // Only recent posts: an old deal never moved on (paid long ago outside email) must not start invoicing now
        const postedRecently = video && (video.postDate ? daysSince(video.postDate) <= 30 : Date.now() - Date.parse(video.edited || 0) < 14 * 864e5);
        if (video && video.num === 12 && deal.stage && deal.stage !== 'Lost' && postedRecently && stageBefore(deal.stage, 'Posted')) {
          try {
            const schema = await schemaOf(DS.deals);
            const p = {};
            setIf(schema, p, 'Deal Stage', 'Posted');
            await notion('PATCH', `/pages/${deal.id}`, { properties: p });
            await log({ event: `Deal moved to Posted: ${deal.brand} × ${deal.creator}`, outcome: 'Changed', email: { messageId: '' }, details: `The video card "${video.title}" is Posted; the deal was still at ${deal.stage}.` }).catch(() => {});
            report.drafts.push(`Stage → Posted: ${deal.brand} × ${deal.creator} (was ${deal.stage})`);
            deal.stage = 'Posted';
          } catch (e) { report.errors.push(`stage ${deal.brand}: ${String(e.message).slice(0, 120)}`); }
        }
  };

  // The deal emails get 110 seconds; the deals left go first on the next tick (the start rotates every 10 minutes), so
  // the steps after them still run and no deal is starved
  const dealsCut = () => Date.now() - T0 > 110 * 1000;
  // Each run starts half the list further on, so deals the last run never reached go first in the next one. Moving the
  // start by one deal per run left the tail of the list unchecked for hours (Polar x Valeri's follow-up, Nov 14).
  // Better still: start at the deal the last heartbeat stopped before, so every deal is reached within a couple of runs
  // however many fit in 110 seconds (Nov 19: every heartbeat for 5 hours ran out of time in the deal loop, so with the
  // half-list jump alone a deal past the reach of one run could wait hours).
  const prevSteps = await lastHeartbeatSteps().catch(() => '');
  const rot = dealLoopStart(deals, prevSteps);
  // Deals with a script waiting (a card at 5- Script Approval or 4.8- Script Changes) go first every run, so a ready
  // script never waits behind the 110-second rotation (Harsh, Nov 21: "still the scripts are not getting sent"; the
  // loop reaches about half of the 71 deals per run, so a script could sit 20+ minutes before it was even drafted)
  const scriptFirst = await scriptReadyDeals(deals).catch(() => []);
  const rest = [...deals.slice(rot), ...deals.slice(0, rot)].filter((d) => !scriptFirst.includes(d));
  const ordered = [...upfrontPaid, ...scriptFirst, ...rest];
  let reached = 0; let nextDeal = null;
  for (const deal of ordered) {
    if (late() || dealsCut()) { skipped.push('rest of the deal emails'); nextDeal = deal; break; }
    reached++;
    report.now = 'deal emails: ' + deal.brand;
    if (deal.paused) continue;
    // 0b. The brand pays only by bank or PayPal and we were waiting for the creator's verified details (Nov 16)
    if (String(deal.nextAction || '').startsWith('Send payment details: brand pays by bank or PayPal')) {
      try { const G = await import('./invoiceguard.js'); const n = await G.retryPaymentDetails(deal, { createDraft, say: (m) => discord(m, 'pm') }); if (n) report.drafts.push(`${deal.brand} × ${deal.creator}: ${n}`); } catch (e) { report.errors.push(`payment details ${deal.brand}: ${String(e.message).slice(0, 100)}`); }
    }

    // A deal added by hand (Hyper3D × Lindsay, Nov 3) has no brand email or thread, while the lead it came from has
    // both: copy them over, or the script and cut emails can never go out
    if ((deal.channel !== 'WhatsApp' || deal.channelGuessed) && (!deal.brandEmail || !deal.threadId || !deal.messageRfc)) {
      try { await contactFromLead(deal); } catch (e) { report.errors.push(`lead contact ${deal.brand}: ${String(e.message).slice(0, 100)}`); }
      if (deal.channelGuessed && deal.threadId) deal.channel = 'Email'; // its lead had the email thread after all
    }
    // Handled on WhatsApp: the creator runs the brand, so the PM never emails them. It only tells us when a cut is
    // ready (once per cut and round), so we can pass the link on.
    if (deal.channel === 'WhatsApp') {
      // WhatsApp deals too: the stage follows the card, so the Invoices page and revenue stay right
      try { if (deal.linkedVideo) await moveToPosted(deal, await videoInfo(deal.linkedVideo)); } catch { /* next tick */ }
      // The brand is on WhatsApp, so the PM can't message them: it tells Harsh, once, when something is ready to pass on
      const waOnce = async (kind, mark, text) => {
        const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: `${kind} (WhatsApp deal)` } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length > 0).catch(() => true);
        if (seen) return false;
        await discord(text, 'pm');
        await log({ event: `${kind} (WhatsApp deal): ${deal.brand} × ${deal.creator}`, outcome: 'Alert', email: { messageId: '' }, deal, details: mark, area: 'Brand deals', creator: deal.creator }).catch(() => {});
        report.drafts.push(`${kind} (WhatsApp deal): ${deal.brand} × ${deal.creator}`);
        return true;
      };
      try {
        const v = deal.linkedVideo ? await videoInfo(deal.linkedVideo) : null;
        if (v && v.num === 5) await waOnce('Script ready', `${v.id} script`, `📝 **Script ready: ${deal.brand} × ${deal.creator}** (WhatsApp deal)\n• "${v.title}" is at Script Approval. The script PDF is on WhatsApp: send it to the brand (or ask ${deal.creator} to).\n→ ${v.url}`).then((sent) => sent && scriptPdfToWhatsApp(v, deal.brand, deal.creator, report));
        if (v && v.num === 12) await waOnce('Posted', `${v.id} posted`, `🧾 **Posted: ${deal.brand} × ${deal.creator}** (WhatsApp deal)\n• "${v.title}" is live${v.postedUrl ? ': ' + v.postedUrl : ''}. Send the link${Number(deal.finalRate) ? ` and the $${deal.finalRate} invoice` : ' and the invoice'} on WhatsApp, then mark it on the Invoices page.`);
      } catch (e) { report.errors.push(`WhatsApp deal ${deal.brand}: ${String(e.message).slice(0, 120)}`); }
      try {
        const row = await findIntakeRow(deal).catch(() => null);
        if (row && row.status === 'In Review' && row.frame) {
          const round = (row.revisions || 0) + 1;
          const mark = `${row.frame} round ${round}`;
          const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: 'Cut ready (WhatsApp deal)' } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length > 0).catch(() => true);
          if (!seen) {
            await discord(`📎 **Cut ready: ${deal.brand} × ${deal.creator}** (${round > 1 ? `revised, round ${round}` : 'first cut'})\n• This deal is handled on WhatsApp, so no email goes to the brand. Pass the link on to ${deal.creator} or the brand.\n• ${row.frame}`, 'pm');
            await log({ event: `Cut ready (WhatsApp deal): ${deal.brand} × ${deal.creator}`, outcome: 'Alert', email: { messageId: '' }, deal, details: mark, area: 'Brand deals', creator: deal.creator }).catch(() => {});
            report.drafts.push(`Cut ready (WhatsApp deal): ${deal.brand} × ${deal.creator}`);
          }
        }
      } catch (e) { report.errors.push(`WhatsApp deal ${deal.brand}: ${String(e.message).slice(0, 120)}`); }
      continue;
    }
    try {
      const video = deal.linkedVideo ? await videoInfo(deal.linkedVideo) : null;
      if (deal.postingHold) await watchPostingHold(deal, video, draft, report).catch((e) => report.errors.push(`Posting hold ${deal.brand}: ${String(e.message).slice(0, 100)}`));
      // The brand asked us to hold the work ("pause scripting until the clause is confirmed"). Nothing goes out to them
      // (no script, no cut), but we keep checking in on the 3/5/9 weekday schedule so the deal doesn't go cold.
      const onHold = /^On hold \(brand\)/i.test(deal.nextAction || '');
      if (onHold) {
        if (deal.brandEmail && !['Posted', 'Invoiced', 'Paid', 'Lost'].includes(deal.stage)) {
          const since = [deal.lastOur, deal.lastBrand, deal.scriptSent, deal.confirmed].filter(Boolean).map((d) => String(d).slice(0, 10)).sort().pop();
          const waited = since ? daysSince(since) : 0;
          const reason = String(deal.nextAction).replace(/^On hold \(brand\):\s*/i, '');
          if (since && waited >= followGap(deal.followUps || 0) && !isWeekend()) {
            if (deal.followUps >= MAX_FOLLOW_UPS) {
              if (!deal.needsCheck) {
                const schema = await schemaOf(DS.deals);
                const p = {};
                setIf(schema, p, 'Needs Check', true);
                await notion('PATCH', `/pages/${deal.id}`, { properties: p });
                await discord(`🙋 **Over to you: ${deal.brand} × ${deal.creator}**\nStill on hold and no word after ${deal.followUps} check-ins (${waited} days). I've stopped chasing.`, 'pm');
                report.handed_to_harsh.push(deal.brand);
              }
            } else {
              await draft('Follow-up', deal, { why: `On hold for ${waited} days (${reason}). Check-in ${deal.followUps + 1} (until they answer) so the deal doesn't go cold.`, facts: { on_hold: true, waiting_for: reason, days_waiting: waited, follow_up_number: deal.followUps + 1, note: 'They asked us to pause the work until this is confirmed. Check in warmly: ask whether there is any update on it, say we are ready to pick the work back up the moment they give the go-ahead. Do not push or sound impatient, and do not send any script or video.' } });
            }
          }
        }
        continue;
      }

      // 1. Script is ready (video at 5- Script Approval). Harsh sends scripts himself, so by default the PM only flags it
      //    (Next Action + one Discord ping) and notices his email when it goes out. PM_SCRIPT_EMAILS=on brings back the drafted email.
      // A Script Sent Date older than this card belongs to an earlier reel of the same deal, so this card's script
      // has not gone out (SpeakOn x Chris reel 2 sat at 5 from Nov 5 because reel 1's Oct 14 date was still on the deal)
      // Several cards of one deal: every card at 5 whose script hasn't gone goes in one email (see dealCards)
      let scriptsByCard = false;
      let dealCardList = null;
      // A deal paid upfront (100% before the video, Manyfast x Duncan, Nov 19) is already Paid or Invoiced while its
      // script still has to go out: the stage only blocks the script once one was sent
      const upfrontOpen = ['Paid', 'Invoiced'].includes(deal.stage) && !deal.scriptSent;
      // A deal with several videos keeps going after its first video posts: CapCut x Chris was "Posted" (video 1 live)
      // while scripts 2 and 3 sat at 5 and never went (Harsh, Nov 20). Only a closed deal stops the script step.
      // ...and its REVISED script still has to go after the brand's notes (system check Nov 20, Manyfast x Duncan: the
      // updated script sat at 5 for hours because a Paid deal with a Script Sent Date never reached this step)
      if (SCRIPT_EMAILS && deal.stage !== 'Lost' && (deal.stage !== 'Paid' || upfrontOpen || deal.upfrontOnly)) {
        const cards = await dealCards(deal, video);
        dealCardList = cards;
        // A new version of a script that already went (moved back to 5 after changes): it goes again as a revised script.
        // Two signals: the card went through "4.8- Script Changes" after its last script email, or its script text differs
        // from the version the brand got
        const atChanges = cards.filter((c) => /^4\.8/.test(c.status || ''));
        if (cards.some((c) => c.num === 5) || atChanges.length) {
          try {
            const vers = await scriptVersions(deal.id);
            const marks = await scriptChangesMarks(cards.map((c) => hexId(c.id)));
            // Harsh moved a card to Script Changes himself: mark it once per round
            for (const c of atChanges) { const h = hexId(c.id); if (!marks.has(h) || (vers.sentAt.has(h) && String(marks.get(h)) < String(vers.sentAt.get(h)))) { const { markScriptChanges } = await import('./inbox.js'); await markScriptChanges(c.url, deal); marks.set(h, new Date().toISOString()); } }
            const due = new Map(changedSinceSent(cards, vers, marks).map((c) => [hexId(c.id), c]));
            if (vers.sent.size) {
              const { scriptFingerprint } = await import('./pdf.js');
              const current = {};
              for (const c of cards.filter((x) => x.num === 5 && vers.sent.has(hexId(x.id)))) current[hexId(c.id)] = await scriptFingerprint(c.id).catch(() => null);
              for (const c of revisedCards(cards, vers, current)) due.set(hexId(c.id), c);
              // A card moved back to 5 with the script unchanged is not a revised script
              for (const h of [...due.keys()]) if (sameScriptAsSent(vers, h, current[h])) { due.delete(h); report.drafts.push(`Revised script not sent, the card's script is unchanged since the last email: ${deal.brand} × ${deal.creator}`); }
            }
            // Revised scripts that are ready together go in one email with all the PDFs
            const list = [...due.values()].sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
            if (list.length) {
              const titles = list.map((c) => c.title);
              await draft('Script', deal, { attach: 'Script PDF', video: list[0].url, context: `Script cards: ${list.map((c) => c.url).join(' ')}`, sameAs: list.map((c) => hexId(c.id)).join(' '), why: `Revised script${list.length > 1 ? 's' : ''} for ${titles.map((t) => `"${t}"`).join(', ')}: back at Script Approval after the brand's script changes, so ${list.length > 1 ? 'they go' : 'it goes'} again.`, facts: list.length > 1 ? { video_titles: titles, script_count: list.length, revised: true, note: `${list.length} revised script PDFs are attached, one per video (${titles.join(', ')}). Say the updated scripts are attached with their notes worked in, and ask them to approve or share feedback on each. Do not describe the scripts.` } : { video_title: titles[0], revised: true, note: 'This is the updated version of a script we already sent. Say the revised script is attached, with their notes worked in, and ask them to approve it or share feedback.' } });
            }
          } catch (e) { report.errors.push(`revised script ${deal.brand}: ${String(e.message).slice(0, 120)}`); }
        }
        if (cards.length > 1 && cards.some((c) => c.num === 5)) {
          const covered = await scriptCardsCovered(deal.id);
          let owed = cards.filter((c) => cardScriptOwed(c, { covered, scriptSent: deal.scriptSent }));
          if (owed.length) { const elsewhere = cardsScriptedElsewhere(await scriptRowsForCards(owed)); owed = owed.filter((c) => !elsewhere.has(hexId(c.id))); }
          const byTitle = (a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true });
          const factsFor = (list, later) => {
            const titles = list.map((c) => c.title);
            return list.length > 1
              ? { video_titles: titles, script_count: list.length, deliverables: deal.deliverables, go_live: list.map((c) => c.postDate).filter(Boolean).sort()[0] || deal.deadline, note: `${list.length} script PDFs are attached, one per video (${titles.join(', ')}). Say here are the scripts for these videos in one short sentence, and ask them to approve or share feedback on each. Do not describe the scripts.` }
              : { video_title: titles[0], deliverables: deal.deliverables, go_live: list[0].postDate || deal.deadline, ...(later ? { note: 'Scripts for the other videos of this deal went earlier. This email carries the script for this one video only.' } : {}) };
          };
          const waiting = owed.length ? await pendingDraft(deal.id, 'Script').catch(() => null) : null;
          if (owed.length && waiting) {
            // The deal's Script email hasn't gone yet: the new card joins it, and the email is rewritten for all of them
            try {
              const inDraft = scriptCardUrls({ video: waiting.properties?.Video?.url, context: (waiting.properties?.Context?.rich_text || []).map((t) => t.plain_text).join('') });
              const list = cards.filter((c) => inDraft.some((u) => hexId(u) === hexId(c.id))).concat(owed).sort(byTitle);
              const mail = await writeEmail({ kind: 'Script', deal, facts: factsFor(list, !!deal.scriptSent) });
              await addScriptCards(waiting.id, owed.map((c) => c.url), mail.body, `Scripts for ${list.length} videos are ready (${list.map((c) => c.title).join(', ')}), so they go together in one email with all the PDFs.`);
              report.drafts.push(`Script email now carries ${list.length} scripts: ${deal.brand} × ${deal.creator}`);
            } catch (e) { report.errors.push(`script merge ${deal.brand}: ${String(e.message).slice(0, 120)}`); }
          } else if (owed.length) {
            owed.sort(byTitle);
            const titles = owed.map((c) => c.title);
            const later = covered.size > 0 || !!deal.scriptSent;
            await draft('Script', deal, { attach: 'Script PDF', video: owed[0].url, context: `Script cards: ${owed.map((c) => c.url).join(' ')}`, sameAs: later ? owed.map((c) => hexId(c.id)).join(' ') : undefined, why: owed.length > 1 ? `Scripts for ${owed.length} videos are ready (${titles.join(', ')}), so they go together in one email with all the PDFs.` : `Rudraksh's script for "${titles[0]}" is ready (status 5).`, facts: factsFor(owed, later) });
          }
          scriptsByCard = true; // this deal's cards are handled here; the single-card path below must not send again
        }
      }
      // A deal with no Linked Video but exactly one card of its own on the board uses that card (Dreamina x Chris, Nov 23:
      // the new $1,500 Katlas deal had its script at 5 for days, but only the old deal was linked to the card, so the
      // single-card step never ran for the new one)
      const scriptCard = video || (dealCardList && dealCardList.length === 1 && dealCardList[0].num === 5 ? dealCardList[0] : null);
      // System check, Nov 23 night: a card borrowed this way whose script already went to the brand from another deal of
      // the same campaign is left alone (Runway AI x Chris BD-76 and Dreamina x Chris BD-77: both scripts went on Nov 19
      // 22:26 UTC from BD-87 and the October deal, yet duplicates were drafted at 12:36 and 14:07 UTC on Nov 23)
      const borrowedSent = !video && scriptCard ? await cardScriptSentAnywhere(scriptCard.id) : false;
      if (borrowedSent) report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no script email, "${scriptCard.title}" already went to the brand from another deal`];
      if (!borrowedSent && !scriptsByCard && scriptCard && scriptCard.num === 5 && !/\bhold\b/i.test(scriptCard.title || '') && (['Brief Received', 'Signed', 'Price Agreed', null, undefined].includes(deal.stage) || upfrontOpen) && !scriptSentFor(deal, scriptCard)) {
        const video = scriptCard;
        if (SCRIPT_EMAILS) await draft('Script', deal, { attach: 'Script PDF', video: video.url, why: `Rudraksh's script for "${video.title}" is ready (status ${video.status}).`, facts: { video_title: video.title, deliverables: deal.deliverables, go_live: video.postDate || deal.deadline } }); // the card's POST DATE wins (Hyper3D said Nov 5, the card said Nov 13)
        else if (!/^Send the script/i.test(deal.nextAction || '')) {
          const schema = await schemaOf(DS.deals);
          const p = {};
          setIf(schema, p, 'Next Action', 'Send the script to the brand (you send it, the PM tracks it)');
          await notion('PATCH', `/pages/${deal.id}`, { properties: p });
          await discord(`📝 **Script ready: ${deal.brand} × ${deal.creator}**\n• "${video.title}" is at Script Approval. Send it to the brand from the email thread, and I'll pick it up and chase their approval\n→ [Open card](${video.url})`, 'pm');
          report.drafts.push(`Script flagged: ${deal.brand} × ${deal.creator}`);
        }
      }

      if (deal.upfrontOnly) continue; // a deal paid upfront is here for its script only

      // 1a. Revised script: the brand asked for changes (PM moved the card back to Script Draft and set "Rudraksh revising"),
      //     and the card is back at 5- Script Approval. Drafted for Harsh to check, never sent on its own.
      // 1a. The card skipped 5: it went from scripting straight to filming/editing/approval while the brand never got the
      //     script (Teamily AI x Brad, Nov 13: moved 4 -> 9 by hand, so no script email was made). Ping Harsh once per card.
      if (video && video.num >= 6 && video.num <= 11 && ['Brief Received', 'Signed', 'Price Agreed', null, undefined].includes(deal.stage) && !scriptSentFor(deal, video) && !deal.scriptApproved && !/no script|script (not needed|skipped)/i.test(`${deal.notes} ${deal.agentNotes}`)) {
        const mark = `${video.id} skipped script`;
        const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: 'Script never sent' } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length > 0).catch(() => true);
        if (!seen) {
          await discord(`⚠️ **Script never sent: ${deal.brand} × ${deal.creator}**\n• "${video.title}" is at ${video.status}, but the script was never sent to the brand (the card skipped 5- Script Approval).\n• Move it to 5 and the PM sends the script, or tell me if this brand doesn't need one.\n→ ${video.url}`, 'pm');
          await log({ event: `Script never sent: ${deal.brand} × ${deal.creator}`, outcome: 'Alert', email: { messageId: '' }, deal, details: mark, area: 'Brand deals', creator: deal.creator }).catch(() => {});
          report.drafts.push(`Script never sent (card skipped 5): ${deal.brand} × ${deal.creator}`);
        }
      }
      let unchangedScript = false;
      if (video && video.num === 5 && deal.stage === 'Script Sent' && /revising the script/i.test(deal.nextAction || '') && SCRIPT_EMAILS) {
        try { const { scriptFingerprint } = await import('./pdf.js'); unchangedScript = sameScriptAsSent(await scriptVersions(deal.id), hexId(video.id), await scriptFingerprint(video.id).catch(() => null)); } catch { /* unknown: judged as before */ }
        if (unchangedScript) report.drafts.push(`Revised script not sent, the card's script is unchanged since the last email: ${deal.brand} × ${deal.creator}`);
      }
      if (!unchangedScript && video && video.num === 5 && deal.stage === 'Script Sent' && /revising the script/i.test(deal.nextAction || '') && SCRIPT_EMAILS) {
        const made = await draft('Script', deal, { attach: 'Script PDF', video: video.url, why: `Revised script for "${video.title}" is back at Script Approval, so it goes back to the brand (Harsh, Nov 4: scripts go out without approval).`, facts: { video_title: video.title, revised: true, note: 'This is the revised script after their feedback. Say the updated script is attached with their notes worked in, and ask them to confirm.' } });
        // once per revision: the Next Action moves on, so a rejected draft isn't written again
        // (only when the draft really exists: out of budget or paused this run means try again next run)
        if (made || await pendingDraft(deal.id, 'Script').catch(() => null)) try { const schema = await schemaOf(DS.deals); const p = {}; setIf(schema, p, 'Next Action', 'Revised script going to the brand'); await notion('PATCH', `/pages/${deal.id}`, { properties: p }); } catch { /* next run */ }
      }

      // 1a2. A single card back at 5 with a new script while the deal stage is already past the script (CapCut x Brad,
      //      Nov 25: the brand asked for the script again, we promised "the revised script shortly" on Nov 20, the team
      //      wrote BRAD'S UPDATED SCRIPT + notes on the card at 5, but the deal stood at Submitted from an old cut, so
      //      neither the first-script path nor the revised path ran and nothing went for five days). The card's script
      //      must be new (never sent by the PM, or different from the version that went) and touched in the last 14 days.
      if (SCRIPT_EMAILS && video && video.num === 5 && !scriptsByCard && !/\bhold\b/i.test(video.title || '')
        && !(['Brief Received', 'Signed', 'Price Agreed', null, undefined].includes(deal.stage) || upfrontOpen)
        && !['Posted', 'Invoiced', 'Paid'].includes(deal.stage)
        && !(deal.stage === 'Script Sent' && /revising the script/i.test(deal.nextAction || ''))) {
        try {
          const covered = await scriptCardsCovered(deal.id).catch(() => new Set());
          const owedNow = cardScriptOwed(video, { covered: new Set(), scriptSent: deal.scriptSent });
          // Only when the deal shows the brand is waiting on a script from us (Nov 25, first run: Holo AI x Chris and
          // CodeRabbit x Chris were drafted while those brands were still reviewing the script they had)
          let fresh = owedNow && scriptOwedToBrand(deal) && !(await cardScriptSentAnywhere(video.id).catch(() => true));
          if (fresh && covered.has(hexId(video.id))) {
            const { scriptFingerprint } = await import('./pdf.js');
            fresh = !sameScriptAsSent(await scriptVersions(deal.id), hexId(video.id), await scriptFingerprint(video.id).catch(() => null));
          }
          if (fresh) await draft('Script', deal, { attach: 'Script PDF', video: video.url, why: `The script for "${video.title}" is at Script Approval with a version the brand hasn't had yet, so it goes to the brand.`, facts: { video_title: video.title, revised: !!(deal.scriptSent || covered.size || stageBefore('Script Sent', deal.stage) || deal.stage === 'Script Sent'), note: 'This is the updated script. Say it is attached and ask them to confirm or share feedback.' } });
        } catch (e) { report.errors.push(`revised script ${deal.brand}: ${String(e.message).slice(0, 120)}`); }
      }

      // 1b. Editor's cut is in review (Video Intake: In Review + Frame.io link) -> send it to the brand.
      //     Each new Frame.io link (first cut, revised cut) gets its own email, once.
      if (deal.brandEmail && !['Posted', 'Invoiced', 'Paid'].includes(deal.stage)) {
        const row = await findIntakeRow(deal).catch(() => null);
        const round = row && row.revisions ? row.revisions + 1 : 1;
        // A first cut when a cut is already with the brand (sent by the PM or by hand) is never re-sent: the brand is
        // reviewing. Only a revised cut (after they asked for changes) goes out while the deal is at Submitted or later.
        const alreadyWithBrand = !stageBefore(deal.stage, 'Submitted') && round === 1;
        // EDIT TRACKER first cuts only go out when Harsh switches them to Send to Brand (lib/brandsend.js). A revised cut
        // (the brand asked for changes, the editor wrote done and it is back In Review) gets its email drafted straight
        // away and shown on WhatsApp with Send, so the brand hears back without anyone retyping it (ZenBusiness, Nov 3)
        // Revised cuts (round 2+) no longer get a draft here: they go out through Send to Brand with no approval
        // (brandRoundsToSend + the n8n done listener, Harsh Nov 5)
        if (row && row.source !== 'tracker' && round === 1 && row.status === 'In Review' && row.frame && !alreadyWithBrand && !(await frameAlreadyShared(deal.id, row.frame, round > 1 ? row.changesAt : null))) {
          await draft('Draft video', deal, { video: deal.linkedVideo || row.url, why: `${row.editor || 'The editor'} finished ${round > 1 ? 'the revised cut (round ' + round + ')' : 'the first cut'} of "${row.title}".`, facts: { frame_io_link: row.frame, video_title: row.title, round, revised: round > 1 }, sameAs: row.frame });
        }
      }

      // 1c. Post date came: look for the post on the creator's own feeds and fill the links in (lib/postedlinks.js)
      if (video && (video.num === 10 || video.num === 11 || (video.num === 12 && !video.postedUrl && !deal.postedLinks) || (video.num === 12 && /youtube|shorts|\byt\b/i.test(deal.deliverables || '') && !/youtu/i.test(`${video.postedUrl || ''} ${deal.postedLinks || ''}`)))) {
        try {
          const { findPostedLinks } = await import('./postedlinks.js');
          const hit = await findPostedLinks(deal, video, report);
          if (hit) {
            video.num = 12; video.status = '12- Posted'; video.postedUrl = hit.found[0].url;
            const schema = await schemaOf(DS.deals);
            const p = {};
            setIf(schema, p, 'Posted Links', deal.postedLinks);
            if (Object.keys(p).length) await notion('PATCH', `/pages/${deal.id}`, { properties: p });
          }
        } catch (e) { report.errors.push(`posted links ${deal.brand}: ${String(e.message).slice(0, 120)}`); }
      }
      if (video && video.num === 12 && video.postedUrl && !String(deal.postedLinks || '').trim()) {
        try { const schema = await schemaOf(DS.deals); const p = {}; setIf(schema, p, 'Posted Links', video.postedUrl); if (Object.keys(p).length) { await notion('PATCH', `/pages/${deal.id}`, { properties: p }); deal.postedLinks = video.postedUrl; } } catch { /* next run */ }
      }
      await moveToPosted(deal, video);

      // 2. Video is live -> send the posted link
      if (video && video.num === 12 && !deal.linksSent) {
        const links = deal.postedLinks || video.postedUrl;
        // Links our side already emailed by hand count as sent (Upfluence x Duncan, Nov 24: Duncan's team sent video 1's
        // links on Nov 16 but Links Sent Date stayed empty, so a Posted links draft calling them "the second video" was
        // written 8 days later; system check Nov 24 afternoon). The date is filled in from that email instead.
        let sentBefore = '';
        if (links) { try { const { pageLines } = await import('./memory.js'); sentBefore = linksEmailedBefore(await pageLines(deal.id), links); } catch { /* draft as before */ } }
        if (sentBefore) {
          try { const schema = await schemaOf(DS.deals); const p = {}; setIf(schema, p, 'Links Sent Date', sentBefore); if (Object.keys(p).length) await notion('PATCH', `/pages/${deal.id}`, { properties: p }); deal.linksSent = sentBefore; } catch { /* next run */ }
        } else if (links) await draft('Posted links', deal, { why: `"${video.title}" is posted.`, facts: { links, video_title: video.title } });
      }

      // 3. Brand has gone quiet -> follow up (max 3, then hand to Harsh)
      // The card is the truth about whose move it is: at 5 (script with the brand) or 9 (video with the brand) we are
      // waiting on them, even if the deal stage or Next Action is stale ("Rudraksh revising the script" from last round)
      // A cut we emailed for approval that the brand never answered is waiting on them too, whatever the deal stage
      // says: reel 2 of a deal that is already Posted for reel 1 was never chased (Polar × Valeri, Nov 3)
      let cutSent = null;
      try {
        const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: deal.id } }, { property: 'Kind', select: { equals: 'Draft video' } }, { property: 'Status', select: { equals: 'Sent' } }] }, sorts: [{ property: 'Sent At', direction: 'descending' }] });
        const row = (r.results || [])[0]; const at = row?.properties?.['Sent At']?.date?.start;
        if (at && (!deal.lastBrand || String(deal.lastBrand).slice(0, 16) < String(at).slice(0, 16))) cutSent = at;
      } catch { /* no outbox info: fall back to the card */ }
      // Our newest sent email of any kind (a follow-up auto-sent earlier in this same run included)
      let anySent = null;
      try {
        const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: deal.id } }, { property: 'Status', select: { equals: 'Sent' } }] }, sorts: [{ property: 'Sent At', direction: 'descending' }] });
        anySent = (r.results || [])[0]?.properties?.['Sent At']?.date?.start || null;
      } catch { /* fall back to the deal's dates */ }
      // A cut sent by hand from Gmail leaves no outbox row: the deal memory still says the video waits on their approval
      // Polar x Valeri, Nov 14: video 1 was posted (stage Posted) and the revised cut of video 2 went out by hand on Nov 10,
      // but the memory said "final OK on the revised cut" and the Next Action "Waiting for the brand to review the video",
      // neither matched, so the deal counted as done and nobody chased Ushni for 4 days.
      if (!cutSent && deal.lastOur && (!deal.lastBrand || String(deal.lastBrand) < String(deal.lastOur)) && (cutAwaitsBrand(deal.memory) || /^waiting for the brand('s)? (to review|feedback on|to approve) the (video|cut|revised cut)/i.test(deal.nextAction || ''))) cutSent = deal.lastOur;
      const cardWaits = (video && (video.num === 5 || video.num === 9)) || !!cutSent;
      const agreedNotMoved = deal.stage === 'Negotiating' && weAcceptedAndAsked(deal.memory);
      const waitStage = cardWaits ? (video?.num === 5 && !cutSent ? 'Script Sent' : 'Submitted') : agreedNotMoved ? 'Price Agreed' : deal.stage;
      // "Waiting for Vera to send the contract and brief", "Waiting for AistLabs to confirm": the deal says the brand owes
      // us something, whatever its stage (Negotiating, Price Agreed...), so that gets chased too
      const owedText = /^waiting for\b/i.test(deal.nextAction || '') && !/payment|invoice/i.test(deal.nextAction || '') ? deal.nextAction : '';
      const done = ['Posted', 'Invoiced', 'Paid', 'Lost'].includes(deal.stage) && !cutSent;
      if ((WAITING_ON_BRAND.includes(deal.stage) || agreedNotMoved || ((cardWaits || owedText) && !done)) && deal.brandEmail) {
        // A cut emailed in this same run (or since the deal was loaded) is our newest email: the wait counts from it, not
        // from the stale Last Our Reply (Readdy x Lindsay, Nov 9: the cut went out at 17:44 UTC and a "no reply for 4 days"
        // follow-up was drafted a minute later, counted from our Nov 5 email)
        const ourLast = latestOurEmail(deal, cutSent, anySent);
        // The brand wrote last but promised something ("will send the brief") and has gone quiet for a week: count from
        // their message, and the nudge is the gentle "any update?" kind (see brandHolding below)
        const quietSinceBrand = owedText && deal.lastBrand && (!ourLast || String(deal.lastBrand).slice(0, 10) > String(ourLast).slice(0, 10)) && daysSince(deal.lastBrand) >= 7;
        const lastOur = quietSinceBrand ? deal.lastBrand : ourLast;
        const brandSilent = quietSinceBrand || (lastOur && (!deal.lastBrand || String(deal.lastBrand).slice(0, 10) <= String(lastOur).slice(0, 10)));
        const waited = elapsedDays(lastOur);
        // Don't chase the brand while the next move is ours (script being revised, editor making changes...)
        // A card still at 9 while the cut's EDIT TRACKER row is on Changes means the brand asked for changes and the
        // editor (or a reshoot) owes the next cut: never chase the brand then (CapCut x Chris, Nov 9)
        // ...but only changes asked for AFTER our latest cut: a row left on Changes from an older round, when the revised
        // cut has since gone out, doesn't make it our move (ZenBusiness × Lindsay, Nov 16: UGC 1 sat on Changes from Nov 2,
        // the round-3 cut went Nov 5, and nobody chased for 11 days)
        const changesOpen = cardWaits && brandSilent ? changesAfterCut(await findIntakeRows(deal).catch(() => []), ourLast) : false;
        const ourMove = changesOpen || saysWaitingOnUs(deal.nextAction) || (!cardWaits && ourMoveText(deal.nextAction, deal.creator));
        // Who actually wrote last in the thread? Dates alone tie when both sides wrote the same day. If the brand wrote
        // last ("shared it with the team, will let you know") they owe us the reply: no nudge for a week, and then a
        // gentle one about that, never a generic "checking in on our proposal".
        const lastMail = brandSilent && !ourMove ? await lastThreadEmail(deal.threadId) : null;
        const brandHolding = lastMail && lastMail.side === 'brand';
        // Waiting on their approval of a script or video we sent: "sending it to the client for review" gets a gentle
        // nudge after 3 days like any silence (Harsh, Nov 7: ElevenLabs x Duncan, Yulia passed the script on Nov 4).
        // Other promises ("will send the brief") still get a week.
        const holdDays = cardWaits || waitStage === 'Script Sent' || waitStage === 'Submitted' ? 3 : 7;
        const holdOk = !brandHolding || daysSince(lastMail.at) >= holdDays;
        // Waiting on the brand's OK on a script: 5 follow-ups, every 3 days, until they answer (Harsh, Nov 7)
        // ...and the same for a brief or contract the brand owes us after a deal is agreed (Harsh, Nov 13: "keep
        // following up until we get the brief and contract")
        const scriptWait = waitStage === 'Script Sent' || (waitStage === 'Price Agreed' && !ourMove) || /^waiting for\b[^\n]*\b(brief|contract)\b/i.test(owedText);
        // A video (first or revised cut) waiting on the brand's approval: chase every 3 days, weekends included, and never
        // stop until they approve, ask for changes or give the go-ahead to post (Harsh, Nov 14: Polar x Valeri sat 4 days)
        const cutWait = !!cutSent || (cardWaits && waitStage === 'Submitted') || (!scriptWait && waitStage === 'Submitted');
        // Harsh, Nov 17: "don't stop following up if the brand is interested". Once a deal is agreed, a script, brief or
        // contract the brand owes us is chased every 3 days until they answer, never handed back after 5
        const maxChase = cutWait || scriptWait ? Infinity : MAX_FOLLOW_UPS;
        const gapNow = cutWait || scriptWait ? SCRIPT_FOLLOW_GAP : followGap(deal.followUps || 0);
        if (brandSilent && !ourMove && holdOk && waited >= gapNow && (deal.followUps >= maxChase || cutWait || !isWeekend())) {
          if (deal.followUps >= maxChase) {
            if (!deal.needsCheck) {
              const schema = await schemaOf(DS.deals);
              const p = {};
              setIf(schema, p, 'Needs Check', true);
              setIf(schema, p, 'Next Action', `No reply after ${deal.followUps} follow-ups. Harsh to decide.`);
              await notion('PATCH', `/pages/${deal.id}`, { properties: p });
              await discord(`🙋 **Over to you: ${deal.brand} × ${deal.creator}**\nNo reply after ${deal.followUps} follow-ups (${waited} days). I've stopped chasing.`, 'pm');
              report.handed_to_harsh.push(deal.brand);
            }
          } else {
            // Price agreed but no contract yet: that's what we're chasing (a signed deal skips this stage)
            const contractOwed = waitStage === 'Price Agreed' && !/signed|contract (received|signed)/i.test(`${deal.agentNotes} ${deal.notes}`);
            const owedWhat = owedText && !/^waiting for\s+(null|none|undefined)\b/i.test(owedText) ? owedText.replace(/^waiting for\s+/i, '').replace(/\s*\(.*\)\s*$/, '') : ''; // never "waiting for null" (SpeakOn, Nov 19)
            // A video waiting on approval is chased every 3 days until they answer (Harsh, Nov 16: "keep sending the
            // follow-ups once the video is sent for approval"). A follow-up the second check held for a day blocked the
            // chase for good (ElevenLabs × Duncan, Nov 14): it is retired and a fresh one written, and the second check is
            // told the rule so it doesn't hold a 3-day check-in as "too soon".
            let replaces = false;
            if (cutWait) {
              const held = await pendingDraft(deal.id, 'Follow-up').catch(() => null);
              if (held && /^Needs you/i.test(plain(held.properties?.Why) || '') && Date.now() - Date.parse(held.created_time) > 24 * 36e5) {
                await notion('PATCH', `/pages/${held.id}`, { properties: { Status: { select: { name: 'Retired' } }, Error: { rich_text: [{ type: 'text', text: { content: 'Retired: held for a day, a fresh follow-up replaces it so the video keeps being chased' } }] } } }).catch(() => {});
                replaces = true;
              }
            }
            const rule = cutWait ? ` Harsh's rule: once a video is sent for approval, we follow up every 3 days until the brand approves it, asks for changes or gives the go-ahead to post; our last email was ${waited} days ago${deal.lastBrand ? `, theirs ${elapsedDays(deal.lastBrand)} days ago` : ''}.` : '';
            await draft('Follow-up', deal, { ...(replaces ? { replaces: true, sameAs: `chase-${new Date().toISOString().slice(0, 10)}` } : {}), why: `No reply for ${waited} days at ${waitStage}${owedWhat ? ` (waiting for ${owedWhat})` : ''} (follow-up ${deal.followUps + 1}${Number.isFinite(maxChase) ? ` of ${maxChase}` : ', until they answer'}).${rule}`, facts: { waiting_for: cardWaits ? (video?.num === 5 && !cutSent ? 'their approval of the script we sent' : 'their feedback on the video we sent') : owedWhat ? owedWhat : waitStage === 'Script Sent' ? 'their approval of the script we sent' : waitStage === 'Price Agreed' ? (contractOwed ? 'the contract (and the brief) so we can get started' : 'the brief and next steps') : 'their feedback on the video we sent', days_waiting: waited, follow_up_number: deal.followUps + 1, ...(brandHolding ? { their_last_message: lastMail.summary || 'they said they shared it with their team and would get back to us', note: 'They told us they are checking with their team or client. Acknowledge that and ask gently whether there is any feedback yet. Do not repeat what we sent.' } : {}), rule: 'Name exactly what we are waiting on (the script or the video). Never call it a proposal or an offer at this stage.' } });
          }
        }
      }

      // 4. Invoice unpaid -> chase on the same 3 / 5 / 9 weekday rhythm as the deal follow-ups, counted from the last
      //    email either side sent (the invoice itself, our last reminder, or the brand's last reply). Always a draft in
      //    Approvals, never sent on its own. Before the due date it's a soft "did it reach you", after it a real chase.
      if (deal.stage === 'Invoiced' && !deal.paidDate && deal.invoiceSent && !copiedInvoice(deal, deals)) {
        const since = [deal.invoiceSent, deal.lastOur, deal.lastBrand].filter(Boolean).map((d) => String(d).slice(0, 10)).sort().pop();
        const days = daysSince(since);
        const sentAgo = daysSince(deal.invoiceSent);
        const chases = deal.followUps;
        const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
        const beforeDue = deal.invoiceDue && String(deal.invoiceDue).slice(0, 10) >= today;
        // A gentle "is it on track for the due date" reminder written before the due date is wrong once the date passes:
        // retire it (not Rejected, so the cooldown doesn't block it) and write a real chase in its place
        if (!beforeDue && deal.invoiceDue) {
          const old = await pendingDraft(deal.id, 'Payment chase').catch(() => null);
          if (old && writtenBeforeDue(old.created_time, deal.invoiceDue)) {
            await notion('PATCH', `/pages/${old.id}`, { properties: { Status: { select: { name: 'Retired' } }, Error: { rich_text: [{ type: 'text', text: { content: 'Retired: written before the due date, which has now passed' } }] } } }).catch(() => {});
            await draft('Payment chase', deal, { sameAs: 'past-due', replaces: true, why: `Invoice was due ${String(deal.invoiceDue).slice(0, 10)} and is still unpaid. Replaces the earlier before-due reminder.`, facts: { invoice_sent: deal.invoiceSent, due: deal.invoiceDue, amount: deal.invoiceAmount || deal.finalRate, before_due_date: false, note: 'The due date has passed. Politely say the invoice is still open and ask when we can expect the payment.' } });
          }
        }
        // A chase held by the second check before rule 80 is retired after a day so a fresh one can go (Nov 25)
        let chaseReplaces = false;
        {
          const held = await pendingDraft(deal.id, 'Payment chase').catch(() => null);
          if (held && heldChaseToRetire(plain(held.properties?.Why), held.created_time)) {
            await notion('PATCH', `/pages/${held.id}`, { properties: { Status: { select: { name: 'Retired' } }, Error: { rich_text: [{ type: 'text', text: { content: 'Retired: held by the second check, which only logs on a payment chase (rule 80); a fresh reminder replaces it' } }] } } }).catch(() => {});
            chaseReplaces = true;
          }
        }
        // The brand told us when it pays (Payment Terms with days, a date): nothing is chased before that date, and the
        // first reminder goes the day after it (Harsh, Nov 26, Emergent: "15 days from the invoice")
        const brandDue = dueDateForBrand(deal);
        const waitForBrand = !!brandDue && String(brandDue).slice(0, 10) >= today;
        if (!waitForBrand && chases < MAX_FOLLOW_UPS && (days >= followGap(chases) || (brandDue && daysSince(String(brandDue).slice(0, 10)) === 1)) && !isWeekend()) {
          await draft('Payment chase', deal, { ...(chaseReplaces ? { replaces: true, sameAs: `chase-${new Date().toISOString().slice(0, 10)}` } : {}),
            why: `Invoice sent ${sentAgo} days ago, no payment yet${deal.invoiceDue ? ` (due ${String(deal.invoiceDue).slice(0, 10)})` : ''}. Reminder ${chases + 1} (until it is paid).`,
            facts: { invoice_sent: deal.invoiceSent, ...(dueDateForBrand(deal) ? { due: dueDateForBrand(deal) } : {}), amount: deal.invoiceAmount || deal.finalRate, reminder_number: chases + 1, before_due_date: !!beforeDue,
              ...(paymentClaimPending(deal) ? { brand_said_paid: 'They told us they paid: say it has not reached us yet and ask for the transfer confirmation.' } : brandAnsweredInvoice(deal, !!beforeDue) ? { brand_gave_date: 'They already told us when it will be paid: refer to that and ask if it is still on track.' } : {}),
              note: beforeDue ? (dueDateForBrand(deal) ? 'The invoice is not due yet. Keep it light: check the invoice reached them and ask them to confirm it is in line for payment by the due date. Do not ask them to pay now.' : 'The invoice is not due yet. Keep it light: check the invoice reached them and ask when the payment is planned. Never name a due date or a payment date: none was agreed with the brand. Do not ask them to pay now.') : 'The due date has passed (or none was set). Politely say the invoice is still open and ask when we can expect the payment.' },
          });
        } else if (chases >= MAX_FOLLOW_UPS && days >= followGap(chases) && !deal.needsCheck) {
          const schema = await schemaOf(DS.deals);
          const p = {};
          setIf(schema, p, 'Needs Check', true);
          await notion('PATCH', `/pages/${deal.id}`, { properties: p });
          await discord(`🙋 **Payment still missing: ${deal.brand} × ${deal.creator}** after ${chases} reminders (${days} days). Over to you.`, 'pm');
          report.handed_to_harsh.push(deal.brand);
        }
      }
    } catch (e) {
      report.errors.push(`${deal.brand}: ${String(e.message).slice(0, 150)}`);
    }
  }

  mark(nextDeal ? `Deal emails (${reached} of ${deals.length} deals, next: ${nextDeal.brand} × ${nextDeal.creator})` : `Deal emails (${deals.length} deals)`);

  // New sponsor videos added by hand or from the chat: tag the script writer once
  try { const A = await import('./actions.js'); const pinged = await A.pingNewSponsorCards(); if (pinged.length) report.drafts.push(...pinged.map((t) => `Rudraksh tagged: ${t}`)); } catch (e) { report.errors.push('New card pings: ' + String(e.message).slice(0, 120)); }

  // WhatsApp morning round-up (once a day, after WA_MORNING o'clock India time)
  try { const I = await import('./inbox.js'); const b = await I.runBriefQueue(); if (b.length) report.drafts.push(...b.map((t) => `Brief to Rudraksh: ${t}`)); } catch (e) { report.errors.push('Brief queue: ' + String(e.message).slice(0, 120)); }
  try { const I = await import('./inbox.js'); const sent = await I.runScriptNotesQueue(); if (sent.length) report.drafts.push(...sent.map((t) => `Script notes to Rudraksh: ${t}`)); } catch (e) { report.errors.push('Script notes queue: ' + String(e.message).slice(0, 120)); }
  // The creator inboxes are read by the /api/leads cron every 5 minutes. The heartbeat no longer reads them too: its
  // copy retried a failing email every run with no limit, paying the AI to read the same email again each time.
  // Brand Contacts: build the key from existing deals and leads the first time (a batch per heartbeat, then never again)
  try {
    const C = await import('./contacts.js');
    if (!(await C.loadContacts()).seeded) {
      const { queryAll } = await import('./notion.js');
      const all = await openDeals({ withClosed: true });
      const leadRows = await queryAll(DS.leads, undefined, { useCache: false }).catch(() => []);
      const leads = leadRows.map((p) => ({ brand: plain(p.properties?.Brand), creator: plain(p.properties?.Creator), brandEmail: plain(p.properties?.['Brand Email']), status: plain(p.properties?.Status) }));
      const r = await C.seedContacts({ deals: all.filter((d) => d.stage !== 'Lost'), leads });
      if (r.seeded) report.drafts.push(`Brand Contacts: built the key from ${r.seeded} existing deal and lead contacts`);
    }
  } catch (e) { report.errors.push('Brand Contacts: ' + String(e.message).slice(0, 120)); }
  // Backup for "Send to Brand" on EDIT TRACKER, in case n8n's call didn't reach us (rows switched 3+ min ago)
  if (!late()) { try { const B = await import('./brandsend.js'); const back = await B.brandRoundsToSend({ report }); if (back.length) report.steps.push({ name: `Brand-change cuts sent back: ${back.join(', ')}`, ms: 0, ok: true }); await B.sendCutsToBrands({ minAgeMin: 3, report }); } catch (e) { report.errors.push('Send to Brand: ' + String(e.message).slice(0, 120)); } }
  // Brand wiki: pages for brands whose deals changed, a few per run (lib/wiki.js)
  // Paused while the monthly API limit is tight (Harsh keeps it at $10, Nov 12): PM_WIKI_BUILD=on turns it back on. Reading pages costs nothing and stays on.
  if (process.env.PM_WIKI_BUILD === 'on' && !late()) { try { const { updateWiki } = await import('./wiki.js'); const { openDeals } = await import('./briefs.js'); const w = await updateWiki(await openDeals({ withClosed: true })); if (w.done.length) { report.steps.push({ name: `Brand wiki updated: ${w.done.join(', ')}${w.left ? ` (${w.left} to go)` : ''}`, ms: 0, ok: true }); (await import('./brain.js')).brainLog(`Brand pages updated from new emails: ${w.done.join(', ')}`).catch(() => {}); } } catch (e) { report.errors.push('brand wiki: ' + String(e.message).slice(0, 120)); } }
  // "Send to Script Writer" picked on a card: the brand's changes go to Rudraksh without anyone pasting them (Nov 13)
  // A deal past the brief with no video card means the script writer never got the brief (CodeRabbit x Chris, Nov 17: the
  // system check opened the deal on Nov 16 from an Oct 29 brief but no card was made, so Riya's "send the script quickly"
  // found nothing in progress). Harsh hears about each one, at most twice a day.
  try { for (const d of dealsWithoutCard(deals)) {
    if (!late()) {
      const v = cardToLink(await dealCards(d, null), d, allDeals);
      if (v) {
        try {
          const ds = await schemaOf(DS.deals); const pp = {}; setIf(ds, pp, 'Linked Video', v.url);
          if (Object.keys(pp).length) {
            await notion('PATCH', `/pages/${d.id}`, { properties: pp });
            d.linkedVideo = v.url;
            report.steps.push({ name: `Linked ${d.brand} × ${d.creator || '?'} to its card ${v.title}`.slice(0, 200), ms: 0, ok: true });
            await log({ event: `Linked video card: ${d.brand} × ${d.creator || '?'}`, outcome: 'Changed', deal: d, details: `The deal had no Linked Video but its card "${v.title}" (${v.status}) is on ${d.creator}'s board, so it was linked instead of alerting Harsh`, area: 'Brand deals' }).catch(() => {});
            continue;
          }
        } catch (e) { report.errors.push('link card: ' + String(e.message).slice(0, 120)); }
      }
    }
    await discord(`🗂️ ` + card(`${d.brand} × ${d.creator || '?'} · brief received but no video card`, ['The script writer has nothing to work from, so no script is in progress', 'Make the card (or tell me to) and link it in the deal\'s Linked Video'], d.url), 'pm').catch(() => {});
  } } catch (e) { report.errors.push('deals without a card: ' + String(e.message).slice(0, 120)); }
  try { const { runScriptPings } = await import('./scriptping.js'); const sent = await runScriptPings(deals); if (sent.length) report.steps.push({ name: `Sent to script writer: ${sent.join('; ')}`.slice(0, 300), ms: 0, ok: true }); } catch (e) { report.errors.push('script writer pings: ' + String(e.message).slice(0, 120)); }
  // The test bank gate (Harsh, Nov 13): after a deploy or a new lesson, run every saved case once in its own call
  try { const { maybeStartGate } = await import('./testbank.js'); const why = await maybeStartGate(); if (why) report.steps.push({ name: `Test bank started after a new ${why}`, ms: 0, ok: true }); } catch (e) { report.errors.push('test bank gate: ' + String(e.message).slice(0, 120)); }
  // A brief pasted onto a card that was waiting for it: to Script Draft and the script writer (lib/briefs.js)
  if (!late()) { try { const { briefsAddedToWaitingCards } = await import('./briefs.js'); const n = await briefsAddedToWaitingCards(); if (n.length) report.steps.push({ name: `Briefs sent to the script writer: ${n.join(', ')}`, ms: 0, ok: true }); } catch (e) { report.errors.push('briefs on waiting cards: ' + String(e.message).slice(0, 120)); } }
  // What editors typed in "For the brand" on a card goes to the brand (lib/toolaccess.js)
  if (!late() && (force || tickMin < 10)) { try { const { catchUpAccess } = await import('./toolaccess.js'); const n = await catchUpAccess(deals, { discord }); if (n.length) report.drafts.push(...n.map((b) => `Tool access steps: ${b}`)); } catch (e) { report.errors.push('tool access catch-up: ' + String(e.message).slice(0, 120)); } }
  if (every15 && !late()) { try { const { pickUpEditorReplies } = await import('./toolaccess.js'); const n = await pickUpEditorReplies(); if (n.length) report.steps.push({ name: `Editor replies picked up from Discord: ${n.join(', ')}`, ms: 0, ok: true }); } catch (e) { report.errors.push('editor replies: ' + String(e.message).slice(0, 120)); } }
  if (every15 && !late()) { try { const { sendForTheBrand } = await import('./toolaccess.js'); const { createDraft } = await import('./outbox.js'); const n = await sendForTheBrand(deals, { createDraft }); if (n.length) report.drafts.push(...n.map((b) => `For the brand: ${b}`)); } catch (e) { report.errors.push('for the brand: ' + String(e.message).slice(0, 120)); } }
  if (every15 && !late()) { try { const n = await nudgeToolAccess(deals); if (n.length) report.drafts.push(...n.map((b) => `Tool access nudge: ${b}`)); } catch (e) { report.errors.push('Tool access nudge: ' + String(e.message).slice(0, 120)); } }
  try { const O = await import('./outbox.js'); const gone = await O.sweepAnsweredDrafts(); if (gone.length) report.drafts.push(`Removed ${gone.length} draft(s) from Approvals, already answered by hand: ${gone.join(', ').slice(0, 300)}`); } catch (e) { report.errors.push('Answered drafts: ' + String(e.message).slice(0, 120)); }
  try { const E = await import('./editorthreads.js'); const posted = await E.postFeedbackToThreads(); if (posted.length) report.drafts.push(...posted.map((t) => `Brand changes posted in the editor's thread: ${t}`)); } catch (e) { report.errors.push('Editor threads: ' + String(e.message).slice(0, 120)); }
  try { const P = await import('./postdates.js'); const r = await P.fillPostDates(); if (r.filled.length) report.drafts.push(...r.filled.map((x) => `Post date set from the deal: ${x}`)); if (r.asked.length) report.handed_to_harsh.push(`post dates: ${r.asked.join(', ')}`.slice(0, 300)); } catch (e) { report.errors.push('post dates: ' + String(e.message).slice(0, 120)); }
  if (process.env.WA_TOKEN) { try { const W = await import('./whatsapp.js'); await W.morning(); } catch (e) { report.errors.push('WhatsApp morning: ' + String(e.message).slice(0, 120)); } }
  // 4a3. A sponsor script reached 5- Script Approval on a card no deal points to (ElevenLabs x Duncan - NOVEMBER, Nov 4:
  //      a repeat campaign whose deal was still last month's, so nothing went to the brand and nobody heard). Once per card.
  try {
    const { allVideos } = await import('./tools.js');
    const { videos } = await allVideos({ quick: true });
    const key = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
    const linked = new Set(deals.map((d) => key(d.linkedVideo)).filter(Boolean));
    for (const v of videos.filter((x) => parseInt(String(x.status || ''), 10) === 5 && x.sponsor && x.post_date && x.post_date >= new Date().toISOString().slice(0, 10) && !linked.has(key(x.url || x.id)) && !cardOfEmailDeal(x, deals))) {
      const mark = key(v.url || v.id);
      // WhatsApp deals often have several videos and only one card linked (Higgsfield x Lindsay, Nov 9): the script goes
      // to Harsh as a PDF on WhatsApp to pass on, instead of asking him to link a deal
      if (await scriptPdfToWhatsApp(v, null, v.creator, report)) continue;
      const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: 'Script ready, no deal' } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length).catch(() => 1);
      if (seen) continue;
      await discord(`🙋 **Script ready, but no deal to send it from: ${v.title} (${v.creator})**\nThe card is at Script Approval, but no deal is linked to it, so the PM can't email the brand. Tell me who gets it, or link the card to its deal (Linked Video) and it goes out.\n${v.url || ''}`, 'pm').catch(() => {});
      await log({ event: `Script ready, no deal: ${v.title}`.slice(0, 118), outcome: 'Alert', email: { messageId: '' }, details: mark, area: 'Brand deals', creator: v.creator }).catch(() => {});
      report.handed_to_harsh.push(`script ready with no deal: ${v.title}`);
    }
  } catch (e) { report.errors.push('orphan scripts: ' + String(e.message).slice(0, 120)); }
  // 4b. Invoices: ask brands for billing details, raise invoices in the creator's Stripe, notice payments
  if (late()) skipped.push('Invoices');
  else {
    try {
      const { runInvoicing } = await import('./invoicing.js');
      // Brands that asked for the invoice go first: the run often runs out of time inside this step, and the deals at the
      // end of the list never got their billing request (Manyfast x Chris, Nov 17: fee added, still nothing after 3 runs)
      const { invoiceOrder } = await import('./invoicing.js');
      report.invoicing = await runInvoicing(invoiceOrder(deals), { draft, say: (t) => discord(t, 'pm'), late });
      try { const { makePayLinks } = await import('./invoicing.js'); const links = await makePayLinks({ say: (t) => discord(t, 'pm') }); if (links.length) report.drafts.push(...links.map((t) => `Pay link made: ${t}`)); } catch (e) { report.errors.push('pay links: ' + String(e.message).slice(0, 150)); }
      // a blocked invoice is something Harsh has to add (fee, email, Stripe), not a crash: hand it over instead of failing the run
      for (const w of report.invoicing.waiting || []) if (!/not connected|out of time/.test(w)) report.handed_to_harsh.push('invoice ' + w);
    } catch (e) { report.errors.push('invoices: ' + String(e.message).slice(0, 150)); }
  }
  mark('Invoices');
  // One-time (per day) look at which creators' Stripe can take bank transfers: logged for Claude/Harsh to read
  try {
    const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { starts_with: `Stripe bank transfer check ${todayIST()}` } } }).then((r) => (r.results || []).length > 0).catch(() => true);
    if (!seen && process.env.PAYMENT_KEYS_SECRET) { const { bankTransferReport } = await import('./invoicing.js'); const rep = await bankTransferReport(); await log({ event: `Stripe bank transfer check ${todayIST()}`, outcome: 'Rule', email: { messageId: '' }, details: JSON.stringify(rep).slice(0, 1900), area: 'System' }).catch(() => {}); }
  } catch (e) { report.errors.push('bank transfer check: ' + String(e.message).slice(0, 100)); }
  // 4a2. Brand asks nobody answered (no draft waiting, brand wrote last): put each to Harsh once on WhatsApp
  try { const { sweepOwed } = await import('./owed.js'); const asked = await sweepOwed(deals); if (asked.length) report.handed_to_harsh.push(...asked.map((a) => `still owed: ${a}`)); } catch (e) { report.errors.push('Owed asks: ' + String(e.message).slice(0, 120)); }
  // 4b2. Approvals stay short: unsent first replies to brand pitches expire after 5 days
  if (every15 && !late()) {
    try {
      const { expireOldLeadDrafts } = await import('./outbox.js');
      const gone = await expireOldLeadDrafts();
      if (gone.length) { report.expired = gone; await discord(`🧹 **${gone.length} lead draft${gone.length === 1 ? '' : 's'} cleared from Approvals** (management replies to new brands, and unsent quotes expire after 5 days)\n` + gone.slice(0, 12).map((t) => '• ' + t).join('\n'), 'log').catch(() => {}); }
    } catch (e) { report.errors.push('expire drafts: ' + String(e.message).slice(0, 150)); }
  }
  // 4b3. Morning data check: placeholder titles, missing dates and deal fields that stop the automation (once a day)
  if (!late()) {
    try { const { morningDataCheck } = await import('./hygiene.js'); const r = await morningDataCheck(); if (r) report.dataCheck = r; }
    catch (e) { report.errors.push('data check: ' + String(e.message).slice(0, 150)); }
  }
  // 4c. Deal memory: open deals without a running record get one built from the PM's log (a few per run)
  if (!late()) {
    try { const { seedMissing } = await import('./memory.js'); report.memory = await seedMissing(deals, 4); }
    catch (e) { report.errors.push('memory: ' + String(e.message).slice(0, 150)); }
  }
  // 5a. Raw Footage folders made before they were shared: open them to anyone with the link (once a day, ~11:30 IST)
  if (!late() && istHour() === 11 && hourlyTailTick(tickMin)) {
    try { const { openRawFolders } = await import('./drive.js'); const n = await openRawFolders({ late }); if (n) report.rawFoldersOpened = n; } catch (e) { report.errors.push('raw folders: ' + String(e.message).slice(0, 150)); }
  }
  // 5a0. Chris's inbox: nudge brands that went quiet after our quote
  if (late()) skipped.push('Lead follow-ups');
  else if (every15) {
  try { const { catchUpUnanswered } = await import('./leads.js'); const c = await catchUpUnanswered(); if (c.length) report.leadCatchUp = c; } catch (e) { report.errors.push('lead catch-up: ' + String(e.message).slice(0, 150)); }
  try { const { leadFollowUps } = await import('./leads.js'); report.leadNudges = await leadFollowUps(); } catch (e) { report.errors.push('lead nudges: ' + String(e.message).slice(0, 150)); }
  // After Chris loops noocapcollab in: chase the contract and brief (2 follow-ups, 3 days apart, no AI)
  try { const { briefChases } = await import('./leads.js'); report.briefChases = await briefChases(); } catch (e) { report.errors.push('brief chases: ' + String(e.message).slice(0, 150)); }
  }

  mark('Lead follow-ups');
  // 5a-pool. Brand Pool: merge every brand that reached out to any creator into one row per brand (once an hour, no AI)
  if (late()) skipped.push('Brand pool');
  else if (force || hourlyTailTick(tickMin)) {
    try { const { syncBrandPool } = await import('./brandpool.js'); report.brandPool = await syncBrandPool({ late }); } catch (e) { report.errors.push('brand pool: ' + String(e.message).slice(0, 150)); }
  }
  mark('Brand pool');
  // Every hour: the queued "nothing needed from you" updates go to #pm-alerts as one list
  if (!late() && (force || hourlyTailTick(tickMin))) {
    try { const { flushFyi } = await import('./briefs.js'); const n = await flushFyi(); if (n) report.fyi = n; } catch (e) { report.errors.push('updates digest: ' + String(e.message).slice(0, 120)); }
  }
  // Once a morning: the deal records that slipped through (lib/looseends.js)
  if (!late() && istHour() >= 10 && istHour() < 20 && every15) {
    try { const { sendLooseEnds } = await import('./looseends.js'); report.looseEnds = await sendLooseEnds(); } catch (e) { report.errors.push('loose ends: ' + String(e.message).slice(0, 150)); }
  }
  if (force || istHour() >= 21) {
    try { report.autolog = await autopilotDigest(); } catch (e) { report.errors.push('autopilot digest: ' + String(e.message).slice(0, 150)); }
  }

  // 5b. Things we promised a brand ("I'll send the signed contract shortly"): remind Harsh once a day until sent
  const h = istHour();
  if (!late() && (force || (h >= 10 && h < 21))) {
    try { report.promises = await promiseReminders(); } catch (e) { report.errors.push('promises: ' + String(e.message).slice(0, 150)); }
  }

  mark('Promise reminders');
  // 6. Sponsor money: log posted sponsor videos, ping new ones, remind unpaid invoices (every heartbeat, ~10 minutes).
  // It used to also need "minute % 10 < 2", but the heartbeat runs at :04/:14/:24…, so it never ran (from Oct 22 on).
  if (!late()) {
    try {
      report.money = await syncMoney();
      for (const e of report.money.errors || []) report.errors.push('money ' + e);
    } catch (e) { report.errors.push('money: ' + String(e.message).slice(0, 150)); }
  }

  // 6b. Cuts waiting for the team's check (In Review) that nobody has looked at: remind, once a day per cut
  if (!late()) {
    try { const { remindWaitingReviews } = await import('./reviewwait.js'); const r = await remindWaitingReviews(); if (r.length) report.drafts.push(`Review reminder: ${r.join(', ')}`); } catch (e) { report.errors.push('review reminder: ' + String(e.message).slice(0, 150)); }
  }
  // 6c. "Fetch from inbox" requests (a file from a creator inbox only the PM can read, e.g. Lindsay's)
  if (!late()) {
    try { const { runInboxFetches } = await import('./inboxfetch.js'); const r = await runInboxFetches(); if (r.length) report.drafts.push(`Inbox fetch: ${r.join(', ')}`); } catch (e) { report.errors.push('inbox fetch: ' + String(e.message).slice(0, 150)); }
  }
  // 6c3. Reply templates learn from Harsh's own replies once a week (Sunday from 10:00 IST), see lib/replytemplates.js
  try {
    const ist = new Date(Date.now() + 5.5 * 36e5);
    if (!late() && ist.getUTCDay() === 0 && ist.getUTCHours() >= 10) {
      const tag = `Template learning ${ist.toISOString().slice(0, 10)}`;
      const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { starts_with: tag } } }).then((r) => (r.results || []).length > 0).catch(() => true);
      if (!seen) {
        await log({ event: tag, outcome: 'Rule', email: { messageId: '' }, details: 'started', area: 'System' }).catch(() => {});
        const R = await import('./replytemplates.js');
        const { claude, HAIKU } = await import('./claude.js');
        const W = await import('./whatsapp.js');
        const changed = await R.improveTemplates({ claude, HAIKU, notify: (t) => W.forward(t) });
        if (changed.length) report.drafts.push(`Reply templates updated: ${changed.join('; ')}`);
      }
    }
  } catch (e) { report.errors.push('template learning: ' + String(e.message).slice(0, 120)); }
  // 6c2. Contracts (Nov 14): one alert when a contract is still unsigned after 2 days (hourly check), and on Sundays the
  // sweep of Lindsay's mailbox (Gmail inboxes are swept by the n8n "Contract sweep" workflow into /api/inbox)
  if (!late() && hourlyTailTick(tickMin)) {
    try { const T = await import('./contracttrack.js'); const r = await T.staleContractAlerts(); if (r.length) report.drafts.push(`Unsigned contract alert: ${r.join(', ')}`); } catch (e) { report.errors.push('contract alerts: ' + String(e.message).slice(0, 120)); }
  }
  try {
    const ist = new Date(Date.now() + 5.5 * 36e5);
    if (!late() && ist.getUTCDay() === 0 && ist.getUTCHours() >= 9) {
      const tag = `Contract sweep ${ist.toISOString().slice(0, 10)}`;
      const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { starts_with: tag } } }).then((r) => (r.results || []).length > 0).catch(() => true);
      if (!seen) {
        await log({ event: tag, outcome: 'Rule', email: { messageId: '' }, details: 'started', area: 'System' }).catch(() => {});
        const M = await import('./mailbox.js');
        const T = await import('./contracttrack.js');
        const found = [];
        for (const creator of M.mailboxCreators()) {
          for (const word of ['contract', 'agreement', 'docusign']) {
            const hits = await M.findInMailbox(creator, word, { days: 30, max: 12 }).catch(() => []);
            // Oldest first, so our signed copy closes the contract it answers
            for (const h of hits.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
              const email = { from: h.from, to: h.to, subject: h.subject, date: h.date, text: `${h.text || ''}\n${(h.links || []).join(' ')}`, attachments: h.files || [], messageId: h.messageId || `sweep:${creator}:${h.subject}:${h.date}`, threadId: h.threadId || '' };
              const r = await T.sweepEmail(email, { inbox: 'Weekly sweep', creator }).catch(() => null);
              if (r?.created) found.push(`${creator}: ${h.subject}`.slice(0, 80));
            }
          }
        }
        if (found.length) report.drafts.push(`Contract sweep added ${found.length}: ${found.join('; ')}`.slice(0, 300));
      }
    }
  } catch (e) { report.errors.push('contract sweep: ' + String(e.message).slice(0, 120)); }
  // 6d. WhatsApp re-open template: make sure it exists (it's what lets alerts reach Harsh after a quiet day). Hourly.
  if (!late() && hourlyTailTick(tickMin)) {
    try {
      const W = await import('./whatsapp.js');
      if (W.waOn()) { const t = await W.ensureTemplate(); report.waTemplate = t.ok ? t.status : `not ready: ${t.status || ''} ${t.why || ''}`.trim().slice(0, 150); /* a note, not a run failure */ if (t.created) report.drafts.push('WhatsApp reopen template created (waiting for Meta approval)'); }
    } catch (e) { report.errors.push('whatsapp template: ' + String(e.message).slice(0, 150)); }
  }
  mark('Sponsor money');
  // 6e. Weekly scorecard: Monday from 10:00 IST, once
  try {
    const ist = new Date(Date.now() + 5.5 * 36e5);
    if (ist.getUTCDay() === 1 && ist.getUTCHours() >= 10) {
      const tag = `Scorecard ${ist.toISOString().slice(0, 10)}`;
      const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { starts_with: tag } } }).then((r) => (r.results || []).length > 0).catch(() => true);
      if (!seen) {
        const S = await import('./scorecard.js');
        const card = await S.buildScorecard();
        await discord(S.scorecardText(card), 'pm');
        await log({ event: tag, outcome: 'Rule', email: { messageId: '' }, details: JSON.stringify({ accuracy: card.accuracy, decisions: card.decisions, corrections: card.corrections, totals: card.totals, sr: card.sr, earned: card.earned }).slice(0, 1900), area: 'System' }).catch(() => {});
      }
    }
  } catch (e) { report.errors.push('scorecard: ' + String(e.message).slice(0, 120)); }
  // 7. Morning brief + money digest, once a day after 9am IST
  if (!late() && (force || istHour() >= 9)) report.brief = await morningBrief({ force });
  mark('Morning brief');
  if (skipped.length) report.steps.push({ name: 'Out of time, next tick picks up: ' + skipped.join(', '), ms: 0, ok: true });
  return report;
}

async function briefSentToday() {
  const res = await notion('POST', `/data_sources/${DS.agentLog}/query`, {
    page_size: 1,
    filter: { and: [{ property: 'Area', select: { equals: 'Briefs' } }, { property: 'Time', date: { equals: todayIST() } }] },
  });
  return (res.results || []).length > 0;
}

export async function morningBrief({ force = false } = {}) {
  if (!force && (await briefSentToday())) return 'already sent today';
  const today = todayIST();
  const yesterday = new Date(new Date(today).getTime() - 864e5).toISOString().slice(0, 10);
  const { buildHQ } = await import('./hq.js');
  const { moneyChase } = await import('./money.js');
  const [hq, m, team, deals] = await Promise.all([
    buildHQ({ fresh: true }),
    moneyChase().catch(() => null),
    runTool('editor_output', { from: yesterday, to: yesterday, include_videos: false }).catch(() => ({})),
    openDeals().catch(() => []),
  ]);
  const o = hq.overview || {};
  const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const short = (t, n = 60) => { const x = String(t || 'Untitled').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  const named = (v) => v.title && !/^untitled$/i.test(v.title);
  const day = new Date(today + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const L = [`☀️ **Morning brief · ${day}**`];

  // 1. Today: only what isn't ready yet
  const tp = o.today_posts || [];
  const notReady = tp.filter((v) => v.stage !== 'Ready' && v.stage !== 'Posted');
  if (tp.length) {
    L.push(`\n**Posting today: ${tp.length - notReady.length} of ${tp.length} ready**`);
    for (const v of notReady.filter(named).slice(0, 6)) L.push(`• ${v.creator}: ${short(v.title)} · still in ${v.stage}${v.editor ? ' with ' + v.editor : ''}`);
  } else L.push('\n**Nothing scheduled to post today.**');

  // 2. Late = past its date (last 7 days) and still in production. Ready-but-not-marked cards are one line, they just need a click
  const overdue = (hq.schedule?.overdue || []).filter(named);
  const stuck = overdue.filter((v) => v.stage !== 'Ready');
  const unmarked = overdue.filter((v) => v.stage === 'Ready');
  if (stuck.length) {
    L.push(`\n**Late and still in production (${stuck.length})**`);
    for (const v of stuck.slice(0, 6)) L.push(`• ${v.creator}: ${short(v.title)} · ${v.stage}, ${v.days_late}d late${v.editor ? ' · ' + v.editor : ''}`);
    if (stuck.length > 6) L.push(`• …and ${stuck.length - 6} more on the dashboard`);
  }
  if (unmarked.length) L.push(`\n📌 ${unmarked.length} video${unmarked.length === 1 ? ' is' : 's are'} Ready but past the post date: ${unmarked.slice(0, 4).map((v) => `${v.creator} · ${short(v.title, 35)}`).join('; ')}${unmarked.length > 4 ? ' …' : ''}. Mark them 12- Posted if they went out, or give them a new date.`);

  // 3. What only Harsh can do
  const needs = [];
  const nDrafts = hq.kpis?.approvals || 0;
  if (nDrafts) needs.push(`${nDrafts} email${nDrafts === 1 ? '' : 's'} waiting in Approvals`);
  for (const a of (hq.leads?.approvals || []).slice(0, 3)) needs.push(`Approve or decline ${a.brand} × ${a.creator} at ${usd(a.approval)}`);
  const promised = deals.filter((d) => !d.paused && /^Send /.test(d.nextAction || '') && d.nextActionDate && String(d.nextActionDate).slice(0, 10) <= today && String(d.nextActionDate).slice(0, 10) >= new Date(Date.parse(today) - 14 * 864e5).toISOString().slice(0, 10));
  for (const d of promised.slice(0, 3)) needs.push(`${d.brand} × ${d.creator || '?'}: ${short(d.nextAction.replace(/\s*\(promised.*\)$/, ''), 80)}`);
  for (const i of (hq.deals?.overdue_invoices || []).slice(0, 3)) needs.push(`${i.brand} invoice ${i.days_overdue}d overdue${i.amount ? ' · ' + usd(i.amount) : ''}`);
  try { const T = await import('./contracttrack.js'); const open = await T.openContracts(); if (open.length) { L.push(`\n📄 **Contracts to sign (${open.length})**`); for (const l of T.briefLines(open).slice(0, 8)) L.push('• ' + l); } } catch { /* the brief goes out without it */ }
  if (needs.length) { L.push('\n**Needs you**'); for (const n of needs) L.push('• ' + n); }

  // 3b. Follow-ups: who is being chased and whether it is working (full view on the HQ Follow-ups tab)
  try { const { followupsData, briefLine } = await import('./followups.js'); const line = briefLine(await followupsData()); if (line) L.push('\n↻ ' + line); } catch { /* the brief goes out without it */ }

  // 4. Money: only what to act on (invoices to collect from creators, brand payments that are late)
  if (m) {
    const toInvoice = (m.needs_invoice || []).filter((x) => (x.days ?? 0) <= 21);
    if (toInvoice.length) L.push(`\n🧾 **Ask for invoices (${toInvoice.length})**: ${toInvoice.slice(0, 6).map((x) => `${x.brand} × ${x.creator}`).join(', ')}${toInvoice.length > 6 ? ' …' : ''}`);
    const late = (m.awaiting_payment || []).filter((x) => (x.days ?? 0) > 21);
    if (late.length) L.push(`⏳ **Brand payments late (${late.length})**: ${late.slice(0, 5).map((x) => `${x.brand} × ${x.creator}${x.amount ? ' ' + usd(x.amount) : ''} (${x.days}d)`).join(', ')}`);
  }

  // 5. Yesterday's editing, one line
  const eds = (team.editors || []).filter((e) => e.delivered);
  if (eds.length) L.push(`\n✂️ Yesterday: ${eds.map((e) => `${e.editor} ${e.delivered}`).join(' · ')} (${team.totals?.delivered || 0} delivered)`);

  if (L.length === 2 && !tp.length) L.push('All clear ✅');
  const text = L.join('\n');
  // Discord caps a message at 2000 characters
  let ok = true, buf = '';
  for (const l of L) {
    if ((buf + '\n' + l).length > 1900) { ok = (await discord(buf, 'pm')) && ok; buf = ''; }
    buf = buf ? buf + '\n' + l : l;
  }
  if (buf) ok = (await discord(buf, 'pm')) && ok;
  const rt = (s) => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];
  try {
    await notion('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id: DS.agentLog },
      properties: {
        Event: { title: rt(`Morning brief ${today}`) },
        Time: { date: { start: today } },
        Area: { select: { name: 'Briefs' } },
        Outcome: { select: { name: ok ? 'Sent' : 'Error' } },
        Source: { select: { name: 'Schedule' } },
        Model: { select: { name: 'None' } },
        Details: { rich_text: rt(text) },
      },
    });
  } catch { /* ignore */ }
  return ok ? 'sent' : 'not sent (DISCORD_PM_WEBHOOK missing?)';
}

// Deals whose Next Action is a promised "Send …" that's now due. One Discord ping per deal per day.
export async function promiseReminders() {
  const today = todayIST();
  const due = (await openDeals()).filter((d) => !d.paused && /^Send /.test(d.nextAction || '') && d.nextActionDate && String(d.nextActionDate).slice(0, 10) <= today && String(d.lastReminder || '').slice(0, 10) !== today);
  for (const d of due) {
    const late = daysSince(d.nextActionDate);
    await discord(`📎 **${d.brand} × ${d.creator || '?'} · still to send**\n• ${d.nextAction.replace(/^Send /, '')}${late > 0 ? `\n• ${late} day${late === 1 ? '' : 's'} past when it was due` : ''}\n→ Reply in the thread with it attached and I'll mark it done${d.url ? ` · [deal](${d.url})` : ''}`, 'pm');
    const schema = await schemaOf(DS.deals);
    const p = {};
    setIf(schema, p, 'Last Reminder Sent', today);
    if (Object.keys(p).length) await notion('PATCH', `/pages/${d.id}`, { properties: p });
  }
  return { reminded: due.map((d) => d.brand) };
}

// Does this draft wait for Monday (New York time)? Follow-ups do, except a chase for a cut waiting on the brand's
// approval, which runs every 3 days weekends included (rule 50). The heartbeat already drafted cut chases on the
// weekend, but autopilot held every follow-up until Monday, so they sat in Approvals for up to two days
// (Polar x Valeri, ZenBusiness x Lindsay, Flova x Duncan, Nov 21-23; morning system check).
export function weekendHold(kind = '', why = '') {
  if (!/follow-up/i.test(kind || '')) return false;
  return !/once a video is sent for approval|cut chases? run every 3 days/i.test(why || '');
}

// Sends held auto-kind drafts once their hold is over. Skips (and retires) a nudge if the brand wrote after it was drafted.
export async function runAutopilot() {
  // Kinds Harsh switched on after they earned it on the scorecard (two clean weeks) join the standard ones
  let earned = [];
  try { const S = await import('./scorecard.js'); earned = (await S.autopilotKinds()).filter((k) => !S.NEVER_AUTO.includes(k) && !ALWAYS_ASK.includes(k)); } catch { /* standard kinds only */ }
  const kinds = [...new Set([...autoKindsNow(), ...earned])];
  if (!kinds.length) return { sent: [], skipped: [] };
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 20, filter: { and: [
    { property: 'Status', select: { equals: 'Draft' } },
    // A fixed reply from Reply Templates that is still a draft (its own send didn't go through, or it was added by hand)
    // goes too: these never need Harsh (Nov 26, "just send it directly from the template")
    { or: [...kinds.map((k) => ({ property: 'Kind', select: { equals: k } })), { property: 'Why', rich_text: { contains: '[template:' } }] },
  ] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
  const sent = [], skipped = [];
  const { autoSend } = await import('./outbox.js');
  for (const p of res.results || []) {
    if (p.in_trash) continue;
    if (ALWAYS_ASK.includes(plain(p.properties?.Kind)) || plain(p.properties?.['Stripe Invoice'])) continue; // never on autopilot
    const created = Date.parse(p.created_time);
    // Two minutes' slack: heartbeats run every 10 minutes, and a draft made a minute into one run was 29.9 minutes old
    // when the run 30 minutes later checked it, so it waited another full run (Fotor × Duncan, Nov 21: 40+ minutes)
    if (created < Date.parse(AUTOPILOT_FROM) || Date.now() - created < (AUTO_HOLD_MIN - 2) * 60e3) continue;
    const subject = plain(p.properties?.Subject) || '';
    const thread = plain(p.properties?.['Gmail Thread ID']) || '';
    // Follow-ups and nudges wait for Monday instead of landing on a weekend (cut chases excepted, rule 50)
    if (weekendHold(plain(p.properties?.Kind), plain(p.properties?.Why)) && isWeekend()) continue;
    // Anything flagged for Harsh (the brand asked something) never sends itself
    if (/^Needs you/i.test(plain(p.properties?.Why) || '')) continue;
    // A deal email with no brand thread to reply in would start a new conversation: never on autopilot
    if ((p.properties?.Deal?.relation || []).length && (!thread || !plain(p.properties?.['Reply To Message ID']))) { skipped.push(`${subject} (no email thread to reply in)`); continue; }
    // Brand (or anyone) wrote in this thread after the nudge was drafted: it's no longer needed
    // (Scripts are not nudges: a brand writing about something else, like last month's invoice, never stops a script)
    if (thread && !/^script$/i.test(plain(p.properties?.Kind) || '')) {
      const later = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Thread ID', rich_text: { equals: thread } }, { property: 'Email Date', date: { after: new Date(created).toISOString() } }] } }).catch(() => ({ results: [] }));
      if ((later.results || []).length) {
        await notion('PATCH', `/pages/${p.id}`, { properties: { Status: { select: { name: 'Rejected' } } } });
        skipped.push(subject);
        continue;
      }
    }
    try {
      const r = await autoSend(p.id);
      if (r?.held) { skipped.push(`${subject} (held for Harsh)`); continue; }
      sent.push(subject);
      await log({ event: `Auto-sent: ${subject}`, outcome: 'Sent', email: { messageId: '', threadId: thread }, details: `${plain(p.properties?.Kind)} to ${plain(p.properties?.To)} after the ${AUTO_HOLD_MIN}-minute hold` });
    } catch (e) {
      skipped.push(`${subject} (failed: ${String(e.message).slice(0, 80)})`);
    }
  }
  return { sent, skipped };
}

// Once an evening: what autopilot sent today
export async function autopilotDigest() {
  const today = todayIST();
  const done = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { equals: `Autopilot log ${today}` } }] } }).catch(() => ({ results: [] }));
  if ((done.results || []).length) return 'already sent';
  const since = new Date(Date.parse(today + 'T00:00:00+05:30')).toISOString();
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 50, filter: { and: [{ property: 'Event', title: { starts_with: 'Auto-sent:' } }, { timestamp: 'created_time', created_time: { on_or_after: since } }] } });
  const rows = (r.results || []).map((p) => plain(p.properties?.Event).replace(/^Auto-sent:\s*/, ''));
  if (rows.length) await discord(`🤖 **Sent on autopilot today (${rows.length})**\n` + rows.slice(0, 15).map((t) => '• ' + t).join('\n'), 'pm');
  await log({ event: `Autopilot log ${today}`, outcome: 'Rule', email: { messageId: '' }, details: rows.length ? rows.join('\n') : 'Nothing sent on autopilot today' });
  return rows.length;
}


// ---------- posting holds (Harsh, Nov 9) ----------
// The brand said "don't publish until we confirm" (ElevenLabs x Duncan: Huedini launch delayed). The deal carries it in
// Posting Hold until the brand gives the go-ahead. Meanwhile:
//  - the card reaching To Post, Ready or Posted warns Harsh once per status (the team posts by hand, so this is the stop)
//  - after a week with no word from the brand since the hold, one polite check-in asks whether there's news
// Markers at the end of Posting Hold ([warned 10], [checked in]) keep each of these to once.
export const HOLD_CHECKIN_DAYS = 7;
export function holdMarkers(text) { return { warned: (String(text || '').match(/\[warned (\d+)\]/g) || []).map((m) => Number(m.match(/\d+/)[0])), checkedIn: /\[checked in\]/.test(String(text || '')) }; }
async function markHold(deal, marker) {
  const text = `${deal.postingHold} ${marker}`.slice(0, 1900);
  await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Posting Hold': { rich_text: [{ type: 'text', text: { content: text } }] } } });
  deal.postingHold = text;
}
async function watchPostingHold(deal, video, draft, report) {
  const m = holdMarkers(deal.postingHold);
  const reason = String(deal.postingHold).replace(/\s*\[[^\]]+\]/g, '').trim();
  if (video && [10, 11, 12].includes(video.num) && !m.warned.includes(video.num)) {
    const what = video.num === 12 ? 'is marked POSTED' : video.num === 11 ? 'is Ready' : 'is at To Post';
    await discord(`⛔ **Don't post yet: ${deal.brand} × ${deal.creator}**\n"${video.title}" ${what}, but the brand hasn't cleared it for publishing (${reason}).${video.num === 12 ? ' If it is already live, check with the brand.' : ' Hold the post until they confirm.'}\nNotion: ${deal.linkedVideo}`, 'pm');
    await markHold(deal, `[warned ${video.num}]`);
    report.handed_to_harsh.push(`${deal.brand}: card ${what} during a posting hold`);
  }
  const since = deal.postingHoldSince ? String(deal.postingHoldSince).slice(0, 10) : null;
  const brandSince = deal.lastBrand && since && String(deal.lastBrand).slice(0, 10) > since;
  if (since && !m.checkedIn && !brandSince && daysSince(since) >= HOLD_CHECKIN_DAYS && !isWeekend() && deal.brandEmail) {
    const made = await draft('Follow-up', deal, { sameAs: 'posting-hold', why: `Posting has waited ${daysSince(since)} days for the brand's go-ahead (${reason}). One check-in.`, facts: { posting_hold: reason, days_waiting: daysSince(since), note: 'They asked us not to publish until they confirm. Ask warmly whether there is any news on timing and when we can go live. Say the video will be ready to go the moment they give the word. One short paragraph, no pressure, no new dates.' } });
    if (made) await markHold(deal, '[checked in]');
  }
}

// ---------- tool access (Harsh, Nov 9) ----------
// Once a brand approves a script the PM asks for access to their tool on noocaptools@gmail.com. If three days pass with
// no word from the brand, one nudge goes in the same thread. Never more than one.
export const TOOL_NUDGE_DAYS = 3;
async function nudgeToolAccess(deals) {
  if (isWeekend()) return [];
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { and: [{ property: 'Kind', select: { equals: 'Tool access' } }, { or: [{ property: 'Status', select: { equals: 'Sent' } }, { property: 'Status', select: { equals: 'Draft' } }] }] } }).catch(() => ({ results: [] }));
  const byDeal = new Map();
  for (const p of res.results || []) for (const r of p.properties?.Deal?.relation || []) { const a = byDeal.get(r.id) || []; a.push(p); byDeal.set(r.id, a); }
  const out = [];
  const { createDraft: make } = await import('./outbox.js');
  const { TOOL_ACCESS_EMAIL } = await import('./inbox.js');
  for (const [dealId, rows] of byDeal) {
    if (rows.length !== 1) continue; // already nudged (or a draft is still waiting)
    const r = rows[0];
    if (plain(r.properties?.Status) !== 'Sent') continue;
    const sentAt = r.properties?.['Sent At']?.date?.start;
    if (!sentAt || daysSince(sentAt) < TOOL_NUDGE_DAYS || daysSince(sentAt) > 21) continue;
    const deal = deals.find((d) => d.id.replace(/-/g, '') === dealId.replace(/-/g, ''));
    if (!deal || deal.channel === 'WhatsApp' || !deal.threadId) continue;
    if (deal.lastBrand && Date.parse(deal.lastBrand) > Date.parse(sentAt)) continue; // the brand wrote back: a person reads it
    const first = String(plain(r.properties?.Body) || '').match(/^Hi\s+([^,<\n]+)/i)?.[1] || 'there';
    const body = `Hi ${first},\n\nJust checking in on access to ${deal.brand} for ${TOOL_ACCESS_EMAIL}, so ${deal.creator || 'we'} can start recording the demo. Could you let us know once it has been given?\n\nBest,\n${deal.creator || 'The'}'s Team`;
    const d = await make({ kind: 'Tool access', deal, subject: plain(r.properties?.Subject) || `Re: ${deal.threadSubject || ''}`, body, notify: false, sameAs: 'nudge', why: `Tool access nudge: no word from ${deal.brand} ${daysSince(sentAt)} days after we asked for access on ${TOOL_ACCESS_EMAIL}. Sends on its own in 30 min unless you reject it.` }).catch(() => null);
    if (d?.created) out.push(`${deal.brand} × ${deal.creator}`);
  }
  return out;
}


// The script as a PDF on WhatsApp, once per card, for videos the PM can't email (WhatsApp deals, or a sponsor card no
// deal points to). Harsh: "it's better to share the PDF cause these are the WhatsApp deals" (Nov 9). Returns true when
// the PDF went out now or before.
export async function scriptPdfToWhatsApp(v, brand, creator, report = { drafts: [], errors: [] }) {
  if (!process.env.WA_TOKEN) return false;
  const key = (String(v.url || v.id || '').match(/[0-9a-f]{32}/i) || [String(v.id || '').replace(/-/g, '')])[0].toLowerCase();
  if (!key) return false;
  const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: 'Script PDF on WhatsApp' } }, { property: 'Details', rich_text: { contains: key } }] } }).then((r) => (r.results || []).length > 0).catch(() => true);
  if (seen) return true;
  let pdf;
  try { pdf = await (await import('./pdf.js')).buildScriptPdf({ pageId: key, brand, creator, title: v.title }); } catch (e) { report.errors?.push(`script PDF ${v.title}: ${String(e.message).slice(0, 100)}`); return false; }
  const W = await import('./whatsapp.js');
  const who = brand ? `${brand} × ${creator}` : `${v.title} (${creator})`;
  const r = await W.sendContract({ text: `📝 Script ready: ${who}\n"${v.title}" is at Script Approval. Here's the script as a PDF to send the brand on WhatsApp${creator ? ` (or ask ${creator}'s team to)` : ''}.\n${v.url || ''}`, files: [pdf], label: 'script' });
  if (!((r.sent || 0) + (r.queued || 0))) return false;
  await log({ event: `Script PDF on WhatsApp: ${v.title}`.slice(0, 118), outcome: 'Sent', email: { messageId: '' }, details: key, area: 'Brand deals', creator }).catch(() => {});
  report.drafts?.push(`Script PDF on WhatsApp: ${v.title}`);
  return true;
}

// The deal says we owe the brand a script: we promised the revised/updated script, or they asked for it and it hasn't
// gone (CapCut x Brad, Nov 25: "We'll share the revised script with you shortly", OPEN NOW "once shared by us"). Pure.
export function scriptOwedToBrand(deal) {
  const text = `${deal?.memory || ''}\n${deal?.nextAction || ''}`;
  const open = (String(deal?.memory || '').split(/OPEN NOW:/i)[1] || '');
  if (/waiting on brand:[^\n]*(feedback|approval|review)[^\n]*\bscript\b(?![^\n]*once shared by us)/i.test(open)) return false;
  return /\b(share|send)(ing)?\b[^.\n]{0,40}\b(revised|updated|new|adjusted)\s+script\b|\b(revised|updated|new)\s+script\b[^.\n]{0,30}\b(shortly|soon|once shared by us|to follow|coming)\b|once shared by us|waiting on us:[^\n]*\bscript\b|brand (asked|requested)[^.\n]{0,40}\b(revised|updated|new) script\b/i.test(text);
}

// The deal memory's OPEN NOW says a cut is with the brand for review/approval/sign-off.
export function cutAwaitsBrand(memory) {
  const open = String(memory || '').split(/OPEN NOW:/i)[1] || '';
  return /waiting on brand:[^\n]*\b(approval|feedback|ok|okay|sign[- ]?off|review|check|thumbs up)\b[^\n]*\b(video|cut|reel)\b|\b(video|cut|reel)\b[^\n.]*pending brand (approval|review|ok)/i.test(open);
}

// Why hasn't a script gone? Read only: runs a creator's deals through the same gates as the script step (Harsh, Nov 20:
// seven Chris cards at 5- Script Approval and no script emails)
export async function scriptGates(creator) {
  const { pendingDraft, recentlyDropped } = await import('./outbox.js');
  const lcs = (x) => String(x || "").toLowerCase(); const all = (await openDeals({ withClosed: true })).filter((d) => lcs(d.creator) === lcs(creator) && d.stage !== 'Lost');
  const out = [];
  for (const deal of all) {
    const video = deal.linkedVideo ? await videoInfo(deal.linkedVideo).catch(() => null) : null;
    const cards = await dealCards(deal, video).catch(() => []);
    const at5 = cards.filter((c) => c.num === 5);
    if (!at5.length) continue;
    const covered = await scriptCardsCovered(deal.id).catch(() => new Set());
    const owed = cards.filter((c) => cardScriptOwed(c, { covered, scriptSent: deal.scriptSent }));
    const upfrontOpen = ['Paid', 'Invoiced'].includes(deal.stage) && !deal.scriptSent;
    const stageOk = !['Posted', 'Invoiced', 'Paid'].includes(deal.stage) || upfrontOpen;
    const single = cards.length <= 1;
    const singleStageOk = ['Brief Received', 'Signed', 'Price Agreed', null, undefined, ''].includes(deal.stage) || upfrontOpen;
    const pend = await pendingDraft(deal.id, 'Script').catch(() => null);
    const dropped = await recentlyDropped({ dealId: deal.id, kind: 'Script', lastEmail: [deal.lastBrand, deal.lastOur] }).catch(() => null);
    const last = await lastSentOf(deal.id, 'Script').catch(() => null);
    const why = [];
    if (deal.paused) why.push('deal paused');
    if (deal.channel === 'WhatsApp') why.push('WhatsApp deal, never emailed');
    if (deal.stage === 'Paid' && !upfrontOpen) why.push('deal is Paid');
    if (!stageOk) why.push(`deal stage ${deal.stage} counts as past the script`);
    if (single && !singleStageOk && !(owed.length && stageOk)) why.push(`one card and deal stage ${deal.stage} is not Brief Received / Signed / Price Agreed, and the card's script is not new`);
    if (single && video && scriptSentFor(deal, video)) why.push(`deal Script Sent Date ${deal.scriptSent} is on or after the card was made`);
    if (!single && !owed.length) why.push('no card counts as owed (sent already, older than 14 days untouched, or covered)');
    if (!deal.threadId || !deal.messageRfc) why.push('no email thread: drafted as Needs you, never auto-sent');
    if (pend) why.push('a Script draft is waiting in Approvals');
    if (dropped) why.push('a Script draft was rejected or removed in the last 3 days');
    if (sentWithinHours(last, 12)) why.push(`a Script email went ${String(last).slice(0, 16)}`);
    if (/^On hold \(brand\)/i.test(deal.nextAction || '')) why.push('deal on hold');
    out.push({ deal: `${deal.brand} × ${deal.creator}`, stage: deal.stage, scriptSent: deal.scriptSent || null, cardsAt5: at5.map((c) => `${c.title} (made ${String(c.created || '').slice(0, 10)}, edited ${String(c.edited || '').slice(0, 10)})`), allCards: cards.length, owed: owed.map((c) => c.title), linked: video ? `${video.title} @${video.num}` : null, blocked: why.length ? why : ['nothing: it should go on the next run'] });
  }
  return out;
}
