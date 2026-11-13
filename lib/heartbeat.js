// PM · Heartbeat. n8n calls /api/tick every few minutes.
// Looks at deals and their videos, drafts the emails that are due, and sends the morning brief once a day.
import { notion, plain, titleOf } from './notion.js';
import { BOARDS, DS, todayIST, runTool, followGap, isWeekend } from './tools.js';
import { schemaOf, findProp } from './actions.js';
import { openDeals, setIf, discord, log } from './briefs.js';
import { createDraft, pendingDraft, writeEmail, stageBefore, OUTBOX_DS } from './outbox.js';
import { runDriveFolders } from './drive.js';
import { findIntakeRow, syncCardsFromIntake, syncBrandApprovalCards } from './intake.js';
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
export const ALWAYS_ASK = [];
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
export function latestOurEmail(deal, cutSent) {
  const base = deal.lastOur || deal.scriptSent || deal.confirmed || deal.teamCc || null;
  if (!cutSent) return base;
  return !base || String(cutSent).slice(0, 16) > String(base).slice(0, 16) ? cutSent : base;
}

export function ourMoveText(nextAction, creator) {
  const t = String(nextAction || '');
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
const MAX_FOLLOW_UPS = 3;
// Script approvals: up to 5 follow-ups, one every 3 days, then Harsh decides (Harsh, Nov 7)
const SCRIPT_FOLLOW_UPS = 5;
const SCRIPT_FOLLOW_GAP = 3;
const WAITING_ON_BRAND = ['Price Agreed', 'Script Sent', 'Submitted'];
const pageIdFromUrl = (u) => (String(u || '').match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1] || null;
const daysSince = (d) => (d ? Math.floor((new Date(todayIST()) - new Date(String(d).slice(0, 10))) / 864e5) : null);
const istHour = () => new Date(Date.now() + 5.5 * 36e5).getUTCHours();

export function scriptSentFor(deal, video) {
  if (!deal?.scriptSent) return false;
  if (!video?.created) return true;
  return String(deal.scriptSent).slice(0, 10) >= String(video.created).slice(0, 10);
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
      if (p.type === 'url' && /posted/.test(n) && p.url) postedUrl = p.url;
    }
    return { id, url: page.url, title: titleOf(page), status, num: parseInt(status, 10), postedUrl, postDate, edited: page.last_edited_time, created: page.created_time };
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

async function frameAlreadyShared(dealId, frame, since) {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [
    { property: 'Deal', relation: { contains: dealId } }, { property: 'Body', rich_text: { contains: frame.slice(0, 90) } },
    ...(since ? [{ timestamp: 'created_time', created_time: { after: new Date(since).toISOString() } }] : []),
    // a draft you rejected counts too: rejecting it means "don't send this cut", so it is never drafted again
    { or: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Status', select: { equals: 'Sent' } }, { property: 'Status', select: { equals: 'Rejected' } }] },
  ] } });
  return (res.results || []).length > 0;
}

// Vercel stops the function at 300s. Stop starting new work well before that so the run always finishes and
// writes its row (a killed run stays "Running" and n8n shows it as failed). Whatever was skipped runs next tick.
const TIME_BUDGET_MS = 170 * 1000;

export async function runHeartbeat({ force = false, report: given } = {}) {
  let last = Date.now();
  const T0 = Date.now();
  const late = () => Date.now() - T0 > TIME_BUDGET_MS;
  const skipped = [];
  // Slow, non-urgent parts run every 30 minutes instead of every 10, to go easy on Notion and Vercel usage
  const every15 = force || new Date().getUTCMinutes() % 15 < 5;
  const report = given || { drafts: [], handed_to_harsh: [], brief: null, errors: [], steps: [] };
  // Time each part of the tick for the Runs page
  const mark = (name) => { report.now = 'after ' + name; const errs = report.errors.length; report.steps.push({ name, ms: Date.now() - last, ok: errs === (mark.errs || 0) }); mark.errs = errs; last = Date.now(); };
  const deals = await openDeals();
  mark('Read brand deals');
  // The brand contacts on every sponsor card, copied from its deal. Hourly, and early in the run: at the end of the
  // tick it was skipped every time the run went past its time budget, so no card was ever filled (Harsh, Nov 10)
  if (force || new Date().getUTCMinutes() < 10) {
    try { const { syncBrandEmails } = await import('./brandemails.js'); const ch = await syncBrandEmails(deals.filter((d) => !['Lost'].includes(d.stage))); report.steps.push({ name: `Brand Email on cards: ${ch.length} updated`, ms: 0, ok: true }); if (ch.length) report.brand_emails = ch; } catch (e) { report.errors.push('brand emails on cards: ' + String(e.message).slice(0, 120)); }
  }
  // Editor said "done" on the CTAs (Video Intake To Post / Posted) but the board card stayed behind: catch it up
  try { const moved = await syncCardsFromIntake(); if (moved.length) { report.steps.push({ name: 'Cards caught up to To Post', ms: 0, ok: true }); report.cards_moved = moved; } } catch (e) { report.errors.push(`Card sync: ${String(e.message).slice(0, 120)}`); }
  try { const moved = await syncBrandApprovalCards(); if (moved.length) { report.steps.push({ name: 'Cards with the brand moved to 9- Approval', ms: 0, ok: true }); report.cards_moved = [...(report.cards_moved || []), ...moved]; } } catch (e) { report.errors.push(`Approval card sync: ${String(e.message).slice(0, 120)}`); }
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
    // A check-in or chase must answer the brand in its own thread. A deal added by hand with no thread would go out as a
    // brand-new email to whoever is in Brand Email (it happened with Bluehost): skip it and leave it to a person.
    if (['Follow-up', 'Payment chase'].includes(kind) && (!deal.threadId || !deal.messageRfc)) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, the deal has no email thread to reply in`]; return; }
    const skip = threadSays(deal, kind);
    if (skip) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, ${skip}`]; return; }
    if (!args.sameAs && await pendingDraft(deal.id, kind)) return; // sameAs: a cut for another video is its own email
    // Rejected, retired or expired in the last 3 days: don't pay the AI to write it again every 10 minutes
    // args.replaces: this draft replaces one the PM itself just retired (past-due chase), so the 3-day pause doesn't apply
    // (Zeely x Duncan, Nov 7: the before-due chase was retired at midnight and its replacement was blocked, so no chase went out)
    if (!args.replaces) { const { recentlyDropped } = await import('./outbox.js'); if (await recentlyDropped({ dealId: deal.id, kind })) { report.skipped = [...(report.skipped || []), `${deal.brand} × ${deal.creator}: no ${kind.toLowerCase()}, a draft was rejected or removed in the last 3 days`]; return; } }
    budget--;
    try {
      const mail = await writeEmail({ kind, deal, facts: args.facts || {} });
      // a link the email must carry (e.g. the Frame.io cut) goes in even if the writer forgot it
      const must = args.facts?.frame_io_link;
      if (must && !String(mail.body).includes(must)) mail.body = String(mail.body).replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\nReview link: ${must}\n${sig}`);
      if (must && !String(mail.body).includes(must)) mail.body += `\n\nReview link: ${must}`;
      // The Stripe pay link is filled in when Harsh approves; make sure the email has a place for it
      if (args.stripeInvoice && !String(mail.body).includes('{{invoice_link}}')) mail.body = String(mail.body).replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\nYou can pay here: {{invoice_link}}\n${sig}`);
      if (args.stripeInvoice && !String(mail.body).includes('{{invoice_link}}')) mail.body += `\n\nYou can pay here: {{invoice_link}}`;
      // Without the brand's thread and message ID the email would start a NEW conversation (Weglot × Lindsay script,
      // Nov 1): it never sends itself, it waits in Approvals marked "Needs you" (autopilot skips those)
      const noThread = !deal.threadId || !deal.messageRfc;
      const auto = !noThread && AUTO_KINDS.includes(kind) && !['Invoice', 'Billing details'].includes(kind);
      const why = noThread ? `Needs you: no email thread on file for this deal, so this would go out as a NEW email instead of a reply. Send it from the brand's thread yourself, or reject it. · ${args.why}` : auto ? `${args.why} Sends on its own in ${AUTO_HOLD_MIN} min unless you reject it.` : args.why;
      const r = await createDraft({ kind, deal, subject: mail.subject, body: mail.body, stripeInvoice: args.stripeInvoice, attach: args.attach || 'None', video: args.video || deal.linkedVideo, why, notify: !auto, sameAs: args.sameAs });
      if (r.created) report.drafts.push(`${kind}: ${deal.brand} × ${deal.creator}`);
      if (r.created && kind === 'Draft video') { const { retireRepliesFor } = await import('./outbox.js'); const n = await retireRepliesFor(deal.threadId, r.id).catch(() => 0); if (n) report.drafts.push(`${deal.brand}: ${n} older reply draft(s) replaced by the cut email`); }
      if (r.created && auto && kind === 'Script' && !/^Needs you/i.test(why)) await discord(`📝 **Script going to ${deal.brand} · ${deal.creator}** in ${AUTO_HOLD_MIN} min\n• "${args.facts?.video_title || 'script'}" with the PDF attached, replying in their email thread. Reject it in Approvals to stop it`, 'pm');
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

  for (const deal of deals) {
    if (late()) { skipped.push('rest of the deal emails'); break; }
    report.now = 'deal emails: ' + deal.brand;
    if (deal.paused) continue;
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
              await draft('Follow-up', deal, { why: `On hold for ${waited} days (${reason}). Check-in ${deal.followUps + 1} of ${MAX_FOLLOW_UPS} so the deal doesn't go cold.`, facts: { on_hold: true, waiting_for: reason, days_waiting: waited, follow_up_number: deal.followUps + 1, note: 'They asked us to pause the work until this is confirmed. Check in warmly: ask whether there is any update on it, say we are ready to pick the work back up the moment they give the go-ahead. Do not push or sound impatient, and do not send any script or video.' } });
            }
          }
        }
        continue;
      }

      // 1. Script is ready (video at 5- Script Approval). Harsh sends scripts himself, so by default the PM only flags it
      //    (Next Action + one Discord ping) and notices his email when it goes out. PM_SCRIPT_EMAILS=on brings back the drafted email.
      // A Script Sent Date older than this card belongs to an earlier reel of the same deal, so this card's script
      // has not gone out (SpeakOn x Chris reel 2 sat at 5 from Nov 5 because reel 1's Oct 14 date was still on the deal)
      if (video && video.num === 5 && !/\bhold\b/i.test(video.title || '') && ['Brief Received', 'Signed', 'Price Agreed', null, undefined].includes(deal.stage) && !scriptSentFor(deal, video)) {
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

      // 1a. Revised script: the brand asked for changes (PM moved the card back to Script Draft and set "Rudraksh revising"),
      //     and the card is back at 5- Script Approval. Drafted for Harsh to check, never sent on its own.
      if (video && video.num === 5 && deal.stage === 'Script Sent' && /revising the script/i.test(deal.nextAction || '') && SCRIPT_EMAILS) {
        const made = await draft('Script', deal, { attach: 'Script PDF', video: video.url, why: `Revised script for "${video.title}" is back at Script Approval, so it goes back to the brand (Harsh, Nov 4: scripts go out without approval).`, facts: { video_title: video.title, revised: true, note: 'This is the revised script after their feedback. Say the updated script is attached with their notes worked in, and ask them to confirm.' } });
        // once per revision: the Next Action moves on, so a rejected draft isn't written again
        // (only when the draft really exists: out of budget or paused this run means try again next run)
        if (made || await pendingDraft(deal.id, 'Script').catch(() => null)) try { const schema = await schemaOf(DS.deals); const p = {}; setIf(schema, p, 'Next Action', 'Revised script going to the brand'); await notion('PATCH', `/pages/${deal.id}`, { properties: p }); } catch { /* next run */ }
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

      await moveToPosted(deal, video);

      // 2. Video is live -> send the posted link
      if (video && video.num === 12 && !deal.linksSent) {
        const links = deal.postedLinks || video.postedUrl;
        if (links) await draft('Posted links', deal, { why: `"${video.title}" is posted.`, facts: { links, video_title: video.title } });
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
      // A cut sent by hand from Gmail leaves no outbox row: the deal memory still says the video waits on their approval
      if (!cutSent && deal.lastOur && (!deal.lastBrand || String(deal.lastBrand) < String(deal.lastOur)) && /waiting on brand:[^\n]*\b(approval|feedback)\b[^\n]*\b(video|cut|reel)\b|\b(video|cut|reel)\b[^\n.]*pending brand approval/i.test(String(deal.memory || '').split(/OPEN NOW:/i)[1] || '')) cutSent = deal.lastOur;
      const cardWaits = (video && (video.num === 5 || video.num === 9)) || !!cutSent;
      const waitStage = cardWaits ? (video?.num === 5 && !cutSent ? 'Script Sent' : 'Submitted') : deal.stage;
      // "Waiting for Vera to send the contract and brief", "Waiting for AistLabs to confirm": the deal says the brand owes
      // us something, whatever its stage (Negotiating, Price Agreed...), so that gets chased too
      const owedText = /^waiting for\b/i.test(deal.nextAction || '') && !/payment|invoice/i.test(deal.nextAction || '') ? deal.nextAction : '';
      const done = ['Posted', 'Invoiced', 'Paid', 'Lost'].includes(deal.stage) && !cutSent;
      if ((WAITING_ON_BRAND.includes(deal.stage) || ((cardWaits || owedText) && !done)) && deal.brandEmail) {
        // A cut emailed in this same run (or since the deal was loaded) is our newest email: the wait counts from it, not
        // from the stale Last Our Reply (Readdy x Lindsay, Nov 9: the cut went out at 17:44 UTC and a "no reply for 4 days"
        // follow-up was drafted a minute later, counted from our Nov 5 email)
        const ourLast = latestOurEmail(deal, cutSent);
        // The brand wrote last but promised something ("will send the brief") and has gone quiet for a week: count from
        // their message, and the nudge is the gentle "any update?" kind (see brandHolding below)
        const quietSinceBrand = owedText && deal.lastBrand && (!ourLast || String(deal.lastBrand).slice(0, 10) > String(ourLast).slice(0, 10)) && daysSince(deal.lastBrand) >= 7;
        const lastOur = quietSinceBrand ? deal.lastBrand : ourLast;
        const brandSilent = quietSinceBrand || (lastOur && (!deal.lastBrand || String(deal.lastBrand).slice(0, 10) <= String(lastOur).slice(0, 10)));
        const waited = daysSince(lastOur);
        // Don't chase the brand while the next move is ours (script being revised, editor making changes...)
        // A card still at 9 while the cut's EDIT TRACKER row is on Changes means the brand asked for changes and the
        // editor (or a reshoot) owes the next cut: never chase the brand then (CapCut x Chris, Nov 9)
        const changesOpen = cardWaits && brandSilent ? (await findIntakeRow(deal).catch(() => null))?.status === 'Changes' : false;
        const ourMove = changesOpen || (!cardWaits && ourMoveText(deal.nextAction, deal.creator));
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
        const scriptWait = waitStage === 'Script Sent';
        const maxChase = scriptWait ? SCRIPT_FOLLOW_UPS : MAX_FOLLOW_UPS;
        const gapNow = scriptWait ? SCRIPT_FOLLOW_GAP : followGap(deal.followUps || 0);
        if (brandSilent && !ourMove && holdOk && waited >= gapNow && (deal.followUps >= maxChase || !isWeekend())) {
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
            const owedWhat = owedText ? owedText.replace(/^waiting for\s+/i, '').replace(/\s*\(.*\)\s*$/, '') : '';
            await draft('Follow-up', deal, { why: `No reply for ${waited} days at ${waitStage}${owedWhat ? ` (waiting for ${owedWhat})` : ''} (follow-up ${deal.followUps + 1} of ${maxChase}).`, facts: { waiting_for: cardWaits ? (video?.num === 5 && !cutSent ? 'their approval of the script we sent' : 'their feedback on the video we sent') : owedWhat ? owedWhat : waitStage === 'Script Sent' ? 'their approval of the script we sent' : waitStage === 'Price Agreed' ? (contractOwed ? 'the contract (and the brief) so we can get started' : 'the brief and next steps') : 'their feedback on the video we sent', days_waiting: waited, follow_up_number: deal.followUps + 1, ...(brandHolding ? { their_last_message: lastMail.summary || 'they said they shared it with their team and would get back to us', note: 'They told us they are checking with their team or client. Acknowledge that and ask gently whether there is any feedback yet. Do not repeat what we sent.' } : {}), rule: 'Name exactly what we are waiting on (the script or the video). Never call it a proposal or an offer at this stage.' } });
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
          if (old && String(old.created_time).slice(0, 10) <= String(deal.invoiceDue).slice(0, 10)) {
            await notion('PATCH', `/pages/${old.id}`, { properties: { Status: { select: { name: 'Retired' } }, Error: { rich_text: [{ type: 'text', text: { content: 'Retired: written before the due date, which has now passed' } }] } } }).catch(() => {});
            await draft('Payment chase', deal, { sameAs: 'past-due', replaces: true, why: `Invoice was due ${String(deal.invoiceDue).slice(0, 10)} and is still unpaid. Replaces the earlier before-due reminder.`, facts: { invoice_sent: deal.invoiceSent, due: deal.invoiceDue, amount: deal.invoiceAmount || deal.finalRate, before_due_date: false, note: 'The due date has passed. Politely say the invoice is still open and ask when we can expect the payment.' } });
          }
        }
        if (chases < MAX_FOLLOW_UPS && days >= followGap(chases) && !isWeekend() && !brandAnsweredInvoice(deal, !!beforeDue)) {
          await draft('Payment chase', deal, {
            why: `Invoice sent ${sentAgo} days ago, no payment yet${deal.invoiceDue ? ` (due ${String(deal.invoiceDue).slice(0, 10)})` : ''}. Reminder ${chases + 1} of ${MAX_FOLLOW_UPS}.`,
            facts: { invoice_sent: deal.invoiceSent, ...(dueDateForBrand(deal) ? { due: dueDateForBrand(deal) } : {}), amount: deal.invoiceAmount || deal.finalRate, reminder_number: chases + 1, before_due_date: !!beforeDue,
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

  mark(`Deal emails (${deals.length} deals)`);

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
  // The test bank gate (Harsh, Nov 13): after a deploy or a new lesson, run every saved case once in its own call
  try { const { maybeStartGate } = await import('./testbank.js'); const why = await maybeStartGate(); if (why) report.steps.push({ name: `Test bank started after a new ${why}`, ms: 0, ok: true }); } catch (e) { report.errors.push('test bank gate: ' + String(e.message).slice(0, 120)); }
  // A brief pasted onto a card that was waiting for it: to Script Draft and the script writer (lib/briefs.js)
  if (!late()) { try { const { briefsAddedToWaitingCards } = await import('./briefs.js'); const n = await briefsAddedToWaitingCards(); if (n.length) report.steps.push({ name: `Briefs sent to the script writer: ${n.join(', ')}`, ms: 0, ok: true }); } catch (e) { report.errors.push('briefs on waiting cards: ' + String(e.message).slice(0, 120)); } }
  // What editors typed in "For the brand" on a card goes to the brand (lib/toolaccess.js)
  if (!late() && (force || new Date().getUTCMinutes() < 10)) { try { const { catchUpAccess } = await import('./toolaccess.js'); const n = await catchUpAccess(deals, { discord }); if (n.length) report.drafts.push(...n.map((b) => `Tool access steps: ${b}`)); } catch (e) { report.errors.push('tool access catch-up: ' + String(e.message).slice(0, 120)); } }
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
    for (const v of videos.filter((x) => parseInt(String(x.status || ''), 10) === 5 && x.sponsor && x.post_date && x.post_date >= new Date().toISOString().slice(0, 10) && !linked.has(key(x.url || x.id)))) {
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
      report.invoicing = await runInvoicing(deals, { draft, say: (t) => discord(t, 'pm') });
      try { const { makePayLinks } = await import('./invoicing.js'); const links = await makePayLinks({ say: (t) => discord(t, 'pm') }); if (links.length) report.drafts.push(...links.map((t) => `Pay link made: ${t}`)); } catch (e) { report.errors.push('pay links: ' + String(e.message).slice(0, 150)); }
      // a blocked invoice is something Harsh has to add (fee, email, Stripe), not a crash: hand it over instead of failing the run
      for (const w of report.invoicing.waiting || []) if (!/not connected/.test(w)) report.handed_to_harsh.push('invoice ' + w);
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
  if (!late() && istHour() === 11 && new Date().getUTCMinutes() < 10) {
    try { const { openRawFolders } = await import('./drive.js'); const n = await openRawFolders(); if (n) report.rawFoldersOpened = n; } catch (e) { report.errors.push('raw folders: ' + String(e.message).slice(0, 150)); }
  }
  // 5. Drive folders for videos that reached 6- To Film
  if (late() || !every15) { if (late()) skipped.push('Drive folders'); } else try {
    report.drive = await runDriveFolders();
    const made = report.drive.made || [];
    const newF = made.filter((m) => !m.rawOnly); // Raw Footage backfills stay quiet
    if (newF.length) await discord(`📁 **Drive folders ready (${newF.length})**\n` + newF.map((m) => `• ${m.creator} · ${m.title} → [folder](${m.folder})${m.shared ? '' : ' ⚠️ share by hand'}`).join('\n'), 'log');
    for (const e of report.drive.errors || []) report.errors.push('drive ' + e);
  } catch (e) { report.errors.push('drive: ' + String(e.message).slice(0, 150)); }

  mark('Drive folders');
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
  else if (force || new Date().getUTCMinutes() < 10) {
    try { const { syncBrandPool } = await import('./brandpool.js'); report.brandPool = await syncBrandPool({ late }); } catch (e) { report.errors.push('brand pool: ' + String(e.message).slice(0, 150)); }
  }
  mark('Brand pool');
  // 5a. Autopilot: send held drafts whose 30 minutes are up (evening log lists them)
  if (late()) skipped.push('Autopilot sends');
  else if (autoKindsNow().length) {
    try { report.autopilot = await runAutopilot(); } catch (e) { report.errors.push('autopilot: ' + String(e.message).slice(0, 150)); }
  }
  // Every hour: the queued "nothing needed from you" updates go to #pm-alerts as one list
  if (!late() && (force || new Date().getUTCMinutes() < 10)) {
    try { const { flushFyi } = await import('./briefs.js'); const n = await flushFyi(); if (n) report.fyi = n; } catch (e) { report.errors.push('updates digest: ' + String(e.message).slice(0, 120)); }
  }
  // Once a morning: the deal records that slipped through (lib/looseends.js)
  if (!late() && istHour() >= 10 && istHour() < 20 && every15) {
    try { const { sendLooseEnds } = await import('./looseends.js'); report.looseEnds = await sendLooseEnds(); } catch (e) { report.errors.push('loose ends: ' + String(e.message).slice(0, 150)); }
  }
  if (force || istHour() >= 21) {
    try { report.autolog = await autopilotDigest(); } catch (e) { report.errors.push('autopilot digest: ' + String(e.message).slice(0, 150)); }
  }

  mark('Autopilot sends');
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
  // 6d. WhatsApp re-open template: make sure it exists (it's what lets alerts reach Harsh after a quiet day). Hourly.
  if (!late() && new Date().getUTCMinutes() < 10) {
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

// Sends held auto-kind drafts once their hold is over. Skips (and retires) a nudge if the brand wrote after it was drafted.
export async function runAutopilot() {
  // Kinds Harsh switched on after they earned it on the scorecard (two clean weeks) join the standard ones
  let earned = [];
  try { const S = await import('./scorecard.js'); earned = (await S.autopilotKinds()).filter((k) => !S.NEVER_AUTO.includes(k) && !ALWAYS_ASK.includes(k)); } catch { /* standard kinds only */ }
  const kinds = [...new Set([...autoKindsNow(), ...earned])];
  if (!kinds.length) return { sent: [], skipped: [] };
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 20, filter: { and: [
    { property: 'Status', select: { equals: 'Draft' } },
    { or: kinds.map((k) => ({ property: 'Kind', select: { equals: k } })) },
  ] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
  const sent = [], skipped = [];
  const { approveAndSend } = await import('./outbox.js');
  for (const p of res.results || []) {
    if (p.in_trash) continue;
    const created = Date.parse(p.created_time);
    if (created < Date.parse(AUTOPILOT_FROM) || Date.now() - created < AUTO_HOLD_MIN * 60e3) continue;
    const subject = plain(p.properties?.Subject) || '';
    const thread = plain(p.properties?.['Gmail Thread ID']) || '';
    // Follow-ups and nudges wait for Monday instead of landing on a weekend
    if (/follow-up/i.test(plain(p.properties?.Kind) || '') && isWeekend()) continue;
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
      await approveAndSend(p.id);
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
