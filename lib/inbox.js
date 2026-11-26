// PM · Inbox brain. Every new noocapcollab email lands here (from n8n).
// Code filters obvious noise, Haiku reads the rest, then the right deal / video / outbox action happens.
import { dueFromTerms, billingEmailIn, withBillingEmail, billingFromText, readBilling, billingFromFiles, BILLING_ASK } from './invoicing.js';
import { notion, plain, clearCache, queryAll, pageIdOf } from './notion.js';
import { BOARDS, DS, todayIST, istStamp } from './tools.js';
import { schemaOf, findProp, CREATOR_KEY } from './actions.js';
import { claude, HAIKU, costOf } from './claude.js';
import { openDeals, threadCcFrom, readDocLink, alreadyHandled, fileBrief, sameDealParty,uploadToNotion, setIf, discord, card, log, tag, LINK_RE, DOC_LINK, noMoneyList, noMoney } from './briefs.js';
import { createDraft, writeEmail, stageBefore, STAGES, OUTBOX_DS, pendingDraft } from './outbox.js';
import { findIntakeRow, findIntakeRows, findIntakeRowByBrand, setIntake, addLateImages } from './intake.js';
import { threadSubject } from './mime.js';
import { contactOf, handles, learnContact } from './contacts.js';
import { rememberEmail, readTranscript } from './memory.js';
import { CREATOR_DOMAINS } from './creatordomains.js';
import { teamWorkOnly, owedMark } from './owed.js';
import { loadTemplates, fillTemplate, templateBlock, sentRecently, templateField } from './replytemplates.js';

const lc = (s) => String(s ?? '').toLowerCase().trim();
const ROSTER = BOARDS.map((b) => b.creator);
const pageIdFromUrl = (u) => pageIdOf(u);
const ageH0 = (email) => (email.date ? (Date.now() - Date.parse(email.date)) / 36e5 : 0);
const domainOf = (s) => (String(s || '').match(/@([\w.-]+\.\w+)/) || [])[1]?.toLowerCase() || '';

const SIGNALS = /\b(video|good to go|looks? great|love (it|the)|ad ?codes?|spark ?codes?|whitelist|usage rights|brief|guideline|talking points?|script|approv|looks good|lgtm|feedback|changes?|revision|edit|invoice|payment|paid|wire|transfer|remit|rate|price|budget|fee|agreed|confirm|contract|agreement|docusign|e-?sign|deal|go[- ]live|posted|link|deliverable|draft|campaign|sponsor)/i;
const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|icloud|proton|protonmail|aol|live)\./;

export function gate(email, deals) {
  const from = lc(email.from);
  if (from.includes('noocapcollab')) return { ok: false, why: 'sent by us' };
  if (/@(accounts\.google\.com|google\.com|googlemail\.com|notion\.so|mail\.notion\.so|vercel\.com|github\.com|discord\.com|railway\.app|n8n\.io|anthropic\.com)>?$/i.test(from.trim()) || /mailer-daemon|postmaster@/i.test(from)) return { ok: false, why: 'system email' };
  const text = `${email.subject || ''}\n${email.text || ''}`;
  const dom = domainOf(email.from);
  const knownBrand = dom && !FREE_MAIL.test(dom) && deals.some((d) => domainOf(d.brandEmail) === dom);
  if (knownBrand) return { ok: true };
  // A reply in a real conversation is never a newsletter, even if the brand's email tool adds an unsubscribe footer
  const isReply = /^\s*(re|fwd?|aw|回复|答复)\s*[:：]/i.test(email.subject || '') || deals.some((d) => d.threadId && d.threadId === email.threadId);
  if (!isReply && /unsubscribe|view in browser|newsletter/i.test(text) && !/brief|invoice|script|sponsor|collab|partner|paid/i.test(email.subject || '')) return { ok: false, why: 'newsletter' };
  const hasFile = (email.attachments || []).length > 0;
  if (SIGNALS.test(text) || hasFile) return { ok: true };
  return { ok: false, why: 'no deal signals' };
}

// The brand approved the script and sent their final version (Faved: "Approved Idea, Script", "validated version",
// next step "Draft video - waiting on creator submission")
export function isApprovedWithEdits(text = '') {
  const t = String(text);
  const approved = /\b(approved (idea|script)|script (is |has been )?approved|validated (version|script)|final (approved )?script|approved[^.\n]{0,40}\bscript)\b/i.test(t)
    || /next step[:\s-]*(draft video|waiting on creator submission|film|record)/i.test(t);
  const notYet = /\b(not approved|rejected|please (revise|rework|rewrite)|needs? (another|more) (revision|changes)|send (us )?(a |the )?revised script)\b/i.test(t);
  return approved && !notYet;
}

// The brand says the invoice will be paid later (queued, scheduled, approved for payment) and not that it was paid
export function isPaymentScheduled(text = '') {
  const t = String(text);
  const later = /\b(payment (queue|run|cycle|schedule)|scheduled (for|to be) pa(y|id)|due to be paid|will be paid|to be paid on|will (pay|process|release)|approved for payment|processing (the|your) (invoice|payment)|in (the|our) queue)\b/i.test(t);
  const done = /\b(has been paid|have paid|we('ve| have)? (just )?(sent|paid|transferred|wired)|payment (has been |was )?(sent|made|completed|processed|done)|paid today|transfer(red)? (today|yesterday))\b/i.test(t);
  return later && !done;
}
// A brand saying the money already went out ("we have already paid the 50% advance") is a payment claim, which the
// code then checks against Stripe or proof. The AI sometimes filed it as a plain brand_reply, so the claim was never
// checked (test bank case zeely-claimed-paid failed on Nov 5). A claim never marks a deal Paid on its own.
// System check Nov 17 night: "the second half of the payment was also sent" (Zeely x Duncan, test bank
// zeely-second-half-sent-no-proof-nov13) slipped past "was sent" because of the word "also", so the case flipped to brand_reply
// whenever the AI reader did. An adverb between "was / has been" and "sent" is still a claim (checked for proof, never Paid).
export function isPaymentClaimed(text = '') {
  const t = String(text);
  const done = /\b(has (already )?been paid|(we|i)('ve| have)? (already |just )*(sent|paid|transferred|wired|made) (the |your |our )?(payment|invoice|advance|transfer|money|deposit|\d+%)|(we|i)('ve| have) (already |just )*paid\b|payment[^.?!\n]{0,30}\b(has (already |also )?been|was (also |already )?)\s*(sent|made|completed|processed|done)|payment (sent|made|completed|done)\b|paid today|transfer(red)? (today|yesterday))/i.test(t);
  return done && !isPaymentScheduled(t);
}
const EVENTS = ['brief', 'price_agreed', 'script_approved', 'script_changes', 'video_feedback', 'invoice_from_creator', 'payment_confirmed', 'brand_reply', 'not_relevant'];

const READ_TOOL = {
  name: 'record_email',
  description: 'Record what this email means for NOOCAP brand deals.',
  input_schema: {
    type: 'object',
    properties: {
      event: { type: 'string', enum: EVENTS, description: `brief = brand sends/updates the content brief for content not scripted yet, including creative direction without a formal brief doc (example or reference videos, inspiration links, angles or use cases to cover, or asking for concepts/scripts before filming) (if the brand is giving notes on a script or video we already sent, it is script_changes or video_feedback, even when the email also links a brief for another deliverable); price_agreed = brand confirms the rate/deal; script_approved = brand approves the script, including "looks great, just a couple of notes for filming and editing" (notes on how to shoot or edit an approved script are filming_notes, not script changes); script_changes = brand wants script changes; video_feedback = brand comments on or approves the edited video; invoice_from_creator = a creator (or their team) sends their invoice for a deal, either to the brand with NOOCAP copied or to NOOCAP; payment_confirmed = brand says the money has actually been SENT or the invoice is paid (an invoice that is received, approved, "in our payment queue", "scheduled" or "will be paid on <date>" is NOT paid yet: that is brand_reply) (a brand asking for bank, PayPal or payment details so it can pay is brand_reply with needs_reply true, not payment_confirmed); brand_reply = any other message in a deal thread (from the brand, the creator's team or NOOCAP); not_relevant = anything else` },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string' },
      from_role: { type: 'string', enum: ['brand', 'creator', 'noocap', 'other'] },
      brand: { type: 'string', description: 'The company whose product the video promotes. The subject line usually names it (e.g. "Creator Partnership Opportunity — Pine AI" means Pine AI). Do not take it from CC addresses: people from other companies or agencies are often copied. When an agency thread covers several brands, the brand is the one THIS latest message is about, even if the subject names another (subject "ZEELY AI campaign" but the message prices a new CapCut video: brand = CapCut).' },
      creator: { type: ['string', 'null'], enum: [...ROSTER, null], description: 'The creator this deal is for, only when the email or quoted thread clearly says so (their name, channel or handle) or it matches an open deal. null when unsure: never guess.' },
      deal_number: { type: ['integer', 'null'], description: 'Number of the matching open deal from the list, or null. Agencies (Mediacube, talent networks) run several brands for us in ONE email thread: read the latest message carefully and pick the deal of the brand it is actually about (e.g. the invoice for the Zeely video goes to the Zeely deal, a new pricing question about CapCut goes to the CapCut deal). If it is about a brand that has no deal yet, this is a new deal: null.' },
      summary: { type: 'array', items: { type: 'string' }, description: 'Key points of the LATEST message only (not the quoted history), max 6' },
      deal_stage: { type: ['string', 'null'], enum: [...STAGES, null], description: 'Where the whole deal stands after this email, judged from this email and the quoted thread: Negotiating (talking price), Price Agreed (rate confirmed), Brief Received (brief shared), Script Sent / Script Approved, In Production (filming/editing), Submitted (edited video sent to brand), Approved (brand approved the video), Posted (video live), Invoiced, Paid. null if unclear.' },
      we_promised: { type: ['array', 'null'], items: { type: 'string' }, description: 'Only when the latest message is from NOOCAP or the creator/their team: things it tells the brand WE will send later (e.g. "signed contract", "invoice", "posted links", "revised script"). Things we ask the BRAND to send ("you can share the contract", "send us the brief") are not our promises and never go here. Short nouns. null if nothing is promised.' },
      delivers: { type: ['array', 'null'], items: { type: 'string' }, description: 'Things the latest message actually sends now, as attachments or links (e.g. "signed contract", "invoice"). null if none.' },
      needs_reply: { type: 'boolean', description: 'True only if the brand asks a question or requests something that NOOCAP must answer by email. False for thanks, acknowledgements, confirmations ("sounds good", "Stripe works", "great, thanks"), for instructions about where or how to submit things ("please submit on the campaign link"), for a request for the invoice (the invoice itself is the answer), and for anything the creator or their team already answered later in the thread.' },
      amount: { type: ['number', 'null'], description: 'The TOTAL agreed fee for the whole deal in this thread, or the invoice amount, if stated. Read the whole thread: when several videos are agreed ("$700 per reel, 2 reels"), give the total ($1,400), never one video\'s price or a figure from an earlier offer that was later changed.' },
      currency: { type: ['string', 'null'] },
      paid_date: { type: ['string', 'null'], description: 'Only for payment_confirmed: the date the brand says it paid, as YYYY-MM-DD (work out words like Friday from the email Date); null if not stated' },
      video_approved: { type: ['boolean', 'null'], description: 'For video_feedback: true only if they approved the video exactly as it is, with no change requested. "Looks great, just one small note: hold this part longer" is NOT approved: put the note in feedback.' },
      feedback: { type: 'string', description: 'Whenever the brand asks for changes to a script or video we sent (whatever the event), the exact requested changes in their LATEST message. Never repeat changes from earlier, quoted messages: if the latest message asks for no new change, leave this empty. Notes that only say how to film or edit a script they are happy with go in filming_notes instead.' },
      approved_script: { type: ['string', 'null'], description: 'When the brand APPROVES the script and sends back their own final / validated version of it (with their small edits applied), that script exactly as they wrote it, every line and timestamp in order. null otherwise.' },
      filming_notes: { type: ['string', 'null'], description: 'When the brand is happy with the script but gives notes on how to film or edit it (what to show on screen, shot format, split screen, length of a section, pacing), those notes from their LATEST message, kept close to their words. null if none.' },
      asks_for_invoice: { type: 'boolean', description: 'true when the latest message asks us to send the invoice ("please send over your invoice so we can process payment"). false otherwise.' },
      billing_details: { type: ['object', 'null'], description: 'Only when the latest message gives the company details to put on an invoice (e.g. after we asked for billing details). null otherwise.', properties: {
        company_name: { type: 'string', description: 'Registered company name to bill' }, contact_name: { type: ['string', 'null'] }, email: { type: ['string', 'null'], description: 'Where the invoice should go' },
        address: { type: ['string', 'null'], description: 'Full billing address on one line' }, country_code: { type: ['string', 'null'], description: 'Two-letter country code of the address, e.g. US' }, tax_id: { type: ['string', 'null'], description: 'VAT / EIN / GST / tax ID if given' },
      }, required: ['company_name'] },
      payment_terms: { type: ['string', 'null'], description: 'Only when the latest message or attached contract states how the fee is paid, in a few words, e.g. "50% upfront on signing, 50% on publish" or "100% net 30 after posting". null otherwise.' },
      we_owe: { type: ['string', 'null'], description: 'Only when the latest message is from the brand: what NOOCAP or the creator now has to send or do because of it, as one short line with any deadline, e.g. "Send the second script; both videos due by 29 Oct" or "Send Lindsay\'s media kit". null if they need nothing from us (thanks, acknowledgements, payment sent).' },
      needs_our_info: { type: 'boolean', description: 'True whenever the brand wants ANYTHING from us that is not already written in this thread or deal: a file, code, link, login or account email, analytics or screenshots, a date or timeline, a confirmation or decision, an answer to a question about the creator, a signature, details or numbers. A reply that could only say "we will get back to you / share it shortly" means this is true. False only when the reply can be fully written from what the thread already says (thanks, acknowledging, repeating a date we already gave).' },
      info_needed: { type: ['string', 'null'], description: 'If needs_our_info: exactly what to get from the team, in a few words, e.g. "TikTok and Instagram ad codes for the posted video". null otherwise.' },
      on_hold: { type: 'boolean', description: 'True only if the latest message asks us to STOP WORKING (scripting, filming or editing) until they confirm something, e.g. "please pause the scripting for now, we are waiting for the brand". "Don\'t publish without checking with me", "the launch may be delayed so the posting date could move" or "no need to rush, but it is up to you" is NOT a hold: the work carries on, only the posting waits (put that in posting_hold). False otherwise.' },
      posting_hold: { type: ['string', 'null'], description: 'If the brand says not to POST or publish yet (launch delayed, wait for their OK before going live) while the work itself can carry on: what the posting waits for, in a few words. Otherwise null.' },
      hold_reason: { type: ['string', 'null'], description: 'If on_hold: what they are waiting for, in a few words.' },
      due_by: { type: ['string', 'null'], description: 'If the latest message asks for something by a date (drafts, the video, the script, posting, an invoice), that date as YYYY-MM-DD. Work it out from the email Date: "end of week" or "EOW" is that Friday, "tomorrow" is the next day. null if no deadline.' },
      due_what: { type: ['string', 'null'], description: 'What they want by due_by, in a few words, e.g. "draft videos" or "revised script". null if no deadline.' },
      // brief fields
      is_update: { type: 'boolean' },
      brief_links: { type: 'array', items: { type: 'string' } },
      brief_text: { type: 'string', description: 'For briefs: the brief itself, cleaned, with "- " bullets and "## " headings. Empty if only a link.' },
      deliverables: { type: 'string' },
      go_live_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      draft_due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      must_mention: { type: 'array', items: { type: 'string' } },
      brand_notes: { type: ['array', 'null'], items: { type: 'string' }, description: 'Only when the latest message is from the brand: the instructions the team must follow when filming, posting or delivering that a teammate could miss later. Required CTA wording, must and suggested hashtags, tracking / UTM / bio links (and how long the bio link stays), accounts to tag, ad codes or spark codes and how long they run, rules about posting time (e.g. no other posts within a day after this one), spelling or capitalisation rules, disclosure (#ad) and caption rules, what to send after posting (live link, story screenshot, analytics after N days). One instruction per item, copying their exact wording, links and hashtags. Only what the LATEST message says, never the quoted history. Never prices, fees or payment. null when there are none.' },
    },
    required: ['event', 'confidence', 'reason', 'from_role', 'brand', 'creator', 'deal_number', 'summary', 'needs_reply'],
  },
};

// The fixed-reply templates (lib/replytemplates.js) are read from Notion each time, so one added there is recognised
async function withTemplates(tool) {
  const list = await loadTemplates().catch(() => []);
  return { ...tool, input_schema: { ...tool.input_schema, properties: { ...tool.input_schema.properties, template: templateField(list) } } };
}

export async function readEmail(email, deals, docText) {
  const dealList = deals.map((d, i) => `${i + 1}. ${d.brand} | creator: ${d.creator || '?'} | stage: ${d.stage || '?'} | video card: ${d.linkedVideo ? 'yes' : 'no'}${d.brandEmail ? ' | brand email: ' + d.brandEmail : ''}`).join('\n') || '(no open deals)';
  const content = [];
  // PDFs go in as their text only (see pdftext.js): far cheaper than sending the file itself
  const pdfs = await (await import('./pdftext.js')).attachmentText(email.attachments);
  // The whole earlier conversation of the deal this thread belongs to, word for word, so the email is read in context
  const likely = threadDeal(deals, email);
  // 10k characters of the conversation (was 16k): older background now comes from the brand wiki (Nov 12 cost review)
  const convo = likely ? await (await import('./memory.js')).readTranscript(likely.id, 10000).catch(() => '') : '';
  // An email whose message is a picture (a transfer receipt, a screenshot of notes) is read from the picture: Katlas sent
  // Dreamina × Chris's $3,000 ACH receipt as an image with no text (Nov 19), the reader saw only the quoted thread, called
  // it a new brief and the deal was never marked Paid
  for (const a of messageImages(email)) content.push({ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.data } });
  const lessons = await (await import('./lessons.js')).lessonsFor(`${email.subject || ''}\n${String(email.text || '').slice(0, 3000)}`).catch(() => '');
  // The brand's wiki page, so the email is read knowing how this brand works (lib/wiki.js)
  const wikiText = likely ? await (await import('./wiki.js')).wikiFor(likely.brand).catch(() => '') : '';
  content.push({
    type: 'text',
    text: `NOOCAP creators: ${ROSTER.join(', ')} (Valeri may be spelled Valerie, David Iya may be just David). NOOCAP's team mailbox is noocapcollab.

Open brand deals:
${dealList}
${(() => { const dom = domainOf(email.from); const d = threadDeal(deals, email) || (dom && !FREE_MAIL.test(dom) && deals.find((x) => domainOf(x.brandEmail) === dom)); return d?.memory ? `\nWhat has happened so far in the deal this thread most likely belongs to (${d.brand} × ${d.creator || '?'}). Use it to judge what the latest message really changes, what they already sent us, and whether anything is still owed:\n${d.memory}\n` : ''; })()}
${lessons ? `\n${lessons}\n` : ''}${wikiText ? `\nWhat NOOCAP knows about this brand from every past deal (brand wiki):\n${wikiText.slice(0, 6000)}\n` : ''}${convo ? `\nThe full earlier conversation in this deal (oldest first, word for word). Read the new email against it: what was agreed, what was already sent or paid, and who owes the next move:\n${convo}\n` : ''}
Email
From: ${email.from || ''}
To: ${email.to || ''}
Cc: ${email.cc || ''}
Date: ${email.date || ''}
Subject: ${email.subject || ''}
Attachments: ${(email.attachments || []).map((a) => a.filename).join(', ') || 'none'}${messageImages(email).length ? ' (the picture(s) above are this email\'s attachments and ARE the message: read them. A bank or payment-app transfer screenshot showing an amount sent to the creator, with status Sent, Completed or Paid, is payment_confirmed)' : ''}

${String(email.text || '').slice(0, 9000)}
${docText ? `\n--- Text of the linked brief doc ---\n${docText.slice(0, 10000)}` : ''}${pdfs ? `\n\n${pdfs}` : ''}

Classify the latest message in this email (ignore quoted older replies unless needed for context) and record it.
Exception: NOOCAP is often copied into a thread late. If the matching deal has no video card yet (or there is no deal yet) and this email OR the quoted earlier messages contain the brand's brief (a brief doc link, talking points, deliverables, key messages), set event = brief and take the brief fields from wherever they appear in the thread. Match the deal by brand name, sender domain and creator; if nothing matches clearly, deal_number is null.`,
  });
  const out = await claude({
    _job: 'inbox',
    model: HAIKU,
    max_tokens: 3000,
    system: 'You file incoming emails for NOOCAP Media, an agency that makes sponsored videos for creators and handles their brand deals. Be precise and never invent details that are not in the email or attachments.',
    tools: [await withTemplates(READ_TOOL)],
    tool_choice: { type: 'tool', name: 'record_email' },
    messages: [{ role: 'user', content }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  const x = call?.input || { event: 'not_relevant', confidence: 'low', reason: 'no answer', summary: [] };
  normalizeRead(x);
  return { x, usage: out.usage };
}

async function patchDeal(deal, fill) {
  const schema = await schemaOf(DS.deals);
  const p = {};
  fill((field, value) => setIf(schema, p, field, value));
  if (Object.keys(p).length) await notion('PATCH', `/pages/${deal.id}`, { properties: p });
}

const clearNextDate = (deal) => notion('PATCH', `/pages/${deal.id}`, { properties: { 'Next Action Date': { date: null } } }).catch(() => {});

// Script changes requested on a card: its status step, and a mark in the AGENT LOG so that when the card comes back to
// 5 the PM knows the script there is a revised one (Harsh, Nov 20)
export const SCRIPT_CHANGES = '4.8';
export async function markScriptChanges(videoUrl, deal = null) {
  const id = String(pageIdFromUrl(videoUrl) || '').replace(/-/g, '');
  if (!id) return;
  await log({ event: `Script changes on card: ${deal?.brand || 'card'}${deal?.creator ? ' × ' + deal.creator : ''}`.slice(0, 118), outcome: 'Changed', email: { messageId: '' }, deal: deal?.id ? deal : null, details: `card ${id}`, area: 'Briefs', creator: deal?.creator }).catch(() => {});
}

async function setVideoStatus(videoUrl, statusNumber) {
  const id = pageIdFromUrl(videoUrl);
  if (!id) return null;
  const page = await notion('GET', `/pages/${id}`);
  const dsId = page.parent?.data_source_id || page.parent?.database_id;
  const board = BOARDS.find((b) => b.ds.replace(/-/g, '') === String(dsId || '').replace(/-/g, ''));
  if (!board) return null;
  const schema = await schemaOf(board.ds);
  const found = findProp(schema, 'status');
  if (!found) return null;
  const opts = found[1].select?.options || found[1].status?.options || [];
  // A number picks "N- …"; a string like '4.8' picks that exact step ("4.8- Script Changes"), falling back to its whole number
  const opt = typeof statusNumber === 'string'
    ? (opts.find((o) => String(o.name).startsWith(statusNumber + '-')) || opts.find((o) => parseInt(o.name, 10) === parseInt(statusNumber, 10) && !/\./.test(String(o.name).split('-')[0])))
    : opts.find((o) => parseInt(o.name, 10) === statusNumber && !/\./.test(String(o.name).split('-')[0]));
  if (!opt) return null;
  await notion('PATCH', `/pages/${id}`, { properties: { [found[0]]: found[1].type === 'status' ? { status: { name: opt.name } } : { select: { name: opt.name } } } });
  return opt.name;
}

// A card someone deleted can't take a note: skip it, never fail the whole brand email over it (Virash AI x Chris, Nov 19:
// the approval email errored on the deleted card before anyone heard the brand wants the video posted today)
export async function addNoteToVideo(videoUrl, label, lines) {
  const id = pageIdFromUrl(videoUrl);
  if (!id) return;
  const kids = noMoneyList(lines).slice(0, 60).map((l) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: String(l).slice(0, 1900) } }] } }));
  try {
    await notion('PATCH', `/blocks/${id}/children`, { children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: label } }], children: kids.length ? kids : [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }] } }] });
  } catch (e) {
    if (/is archived|in_trash|archived block/i.test(String(e.message))) { console.error('note skipped, card deleted', id); return 'card deleted'; }
    throw e;
  }
}

// Brand notes on the deal's open cards (Harsh, Nov 24): a "Brand Notes" field on each card (newest first, deduped, no
// money) and a dated note inside the card. Open = every card of this deal's brand and creator up to 12- Posted (after
// posting the brand still wants the live link, ad code and analytics: CapCut x Chris (2), Nov 24), plus the linked card. Returns a short line for the log, or ''.
export function mergeBrandNotes(old, lines, day) {
  const seen = new Set(String(old || '').split('\n').map((l) => l.replace(/^[•\-\s]+/, '').trim().toLowerCase()).filter(Boolean));
  const fresh = lines.map((l) => String(l).trim()).filter((l) => l && !seen.has(l.toLowerCase()));
  if (!fresh.length) return null;
  return [`${day}:`, ...fresh.map((l) => `• ${l}`), String(old || '').trim()].filter(Boolean).join('\n').slice(0, 1990);
}
export async function saveBrandNotes(deal, notes) {
  const lines = noMoneyList(notes.map((l) => String(l).trim()).filter(Boolean)).slice(0, 25);
  if (!lines.length) return '';
  const { allVideos } = await import('./tools.js');
  const { videos } = await allVideos().catch(() => ({ videos: [] }));
  const linked = (String(deal.linkedVideo || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
  const b = normBrand(deal.brand);
  const cards = videos.filter((v) => {
    const id = String(v.id || '').replace(/-/g, '').toLowerCase();
    if (id === linked) return true;
    const n = parseInt(String(v.status || ''), 10);
    return b.length >= 3 && normBrand(v.title).includes(b) && String(v.creator || '').toLowerCase().slice(0, 4) === String(deal.creator || '').toLowerCase().slice(0, 4) && n >= 1 && n <= 12;
  }).slice(0, 6);
  if (!cards.length && linked) cards.push({ id: linked });
  const day = todayIST();
  let done = 0;
  for (const c of cards) {
    const id = String(c.id).replace(/-/g, '');
    try {
      const page = await notion('GET', `/pages/${id}`);
      const ds = page.parent?.data_source_id;
      if (ds && !page.properties?.['Brand Notes']) await notion('PATCH', `/data_sources/${ds}`, { properties: { 'Brand Notes': { rich_text: {} } } });
      const old = (page.properties?.['Brand Notes']?.rich_text || []).map((t) => t.plain_text).join('');
      const merged = mergeBrandNotes(old, lines, day);
      if (!merged) continue;
      await notion('PATCH', `/pages/${id}`, { properties: { 'Brand Notes': { rich_text: [{ type: 'text', text: { content: merged } }] } } });
      await addNoteToVideo(id, `📌 Brand notes ${day}`, lines).catch(() => {});
      done++;
    } catch (e) { console.error('brand notes card', id, e.message); }
  }
  return done ? `brand notes saved on ${done} card${done > 1 ? 's' : ''}` : '';
}

// The deal's cards still at scripting (status 5 or lower). The linked card is the deal's first video; once it is past
// scripting, later scripts belong to its siblings ("CapCut × Chris (2)", "(3)").
const SENT_OUT = ['With Brand', 'Send to Brand', 'In Review', 'Editor review'];
async function dealCardsOf(deal) {
  const H = await import('./heartbeat.js');
  const linked = deal.linkedVideo ? await H.videoInfoOf(deal.linkedVideo) : null;
  return H.dealCardsOf(deal, linked);
}
// A script approval or notes email reaches Harsh on WhatsApp only when it asks something he alone can answer. "Start
// filming and send the first draft" is the team's work, never a swipe-reply ask (CapCut x Chris, Nov 21: Mia's script 2
// approval became "is asking for: an answer to: Second script approved; start filming video two"; rule 12, lesson
// "A WhatsApp ask names only what Harsh alone can give" seen twice; night system check). Pure.
export function feedbackNeedsHarsh(x = {}) {
  if (!x.needs_reply || !['script_changes', 'video_feedback', 'script_approved'].includes(x.event)) return false;
  // A video approval ("These are approved") is the team's next step (To Post, then the live link), never a swipe-reply
  // ask, unless it also asks for something only Harsh has (ZenBusiness x Lindsay, Nov 23-24: Natalie's approval of the
  // three videos reached Harsh as "is asking for: an answer to: Natalie Swanson approved the three videos"; rule 12,
  // morning system check Nov 24)
  if (x.event === 'script_approved' || x.video_approved) return !!x.needs_our_info;
  return true;
}
export function pickScriptCards(cards, text = '') {
  const all = (cards || []).filter(Boolean);
  if (!all.length) return [];
  const linked = all[0];
  if (!(linked.num > 5)) return [linked.url];
  const open = all.slice(1).filter((c) => c.num >= 1 && c.num <= 5);
  // Several scripts waiting: the one the brand names as approved goes first ("the second script has been approved"),
  // never just the first card found (CapCut x Chris, Nov 21: Mia approved script 2 and called script 3 incorrect; card 3
  // went to To Film with her rejection as its "approved script" and card 2 stayed at 5; night system check)
  const n = approvedScriptNumber(text);
  if (n && open.length > 1) open.sort((a, b) => (cardNumber(b.title) === n) - (cardNumber(a.title) === n));
  return open.map((c) => c.url);
}
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };
// The number of the card: "CapCut × Chris (3)" is 3, a title without a number is video 1
export const cardNumber = (title) => Number((String(title || '').match(/\((\d+)\)\s*$/) || [])[1] || 1);
// Which script the brand approved, from "the second script has been approved" / "script 2 is approved". Pure.
export function approvedScriptNumber(text) {
  const t = String(text || '').toLowerCase();
  // Either order: "the second script has been approved" and "our team has approved the second script" (CapCut x
  // Lindsay, Nov 20: the second form wasn't read, so card 3, whose script still needed changes, went to To Film)
  const m = t.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:script|video)\b[^.!?\n]{0,40}\bapprov/) || t.match(/\b(?:script|video)\s*#?\s*(\d)\b[^.!?\n]{0,40}\bapprov/)
    || t.match(/\bapprov\w*\s+(?:the\s+|your\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:script|video)\b/) || t.match(/\bapprov\w*\s+(?:the\s+)?(?:script|video)\s*#?\s*(\d)\b/);
  if (!m) return null;
  return ORDINALS[m[1]] || Number(m[1]) || null;
}
async function scriptCardsOf(deal, text = '') {
  if (!deal.linkedVideo) return [];
  try { return pickScriptCards(await dealCardsOf(deal), text); } catch (e) { console.error('script cards', e.message); return []; }
}
async function scriptCardOf(deal, text = '') { return (await scriptCardsOf(deal, text))[0] || null; }

// The brand approved a video in an email that was mostly about something else: the EDIT TRACKER row that is with the
// brand goes to To Post (the editor's To Post thread starts from there) and its card follows
async function approveVideoToo(deal) {
  const rows = (await findIntakeRows(deal).catch(() => [])).filter((r) => SENT_OUT.includes(r.status));
  if (rows.length > 1) throw new Error(`${rows.length} videos of this deal are with the brand (${rows.map((r) => r.title).join(', ')}), not sure which one`);
  const row = rows[0];
  if (!row) return null;
  await setIntake(row, 'To Post');
  const st = row.videoId ? await setVideoStatus(`https://www.notion.so/${row.videoId}`, 10).catch(() => null) : null;
  await patchDeal(deal, (set) => { if (stageBefore(deal.stage, 'Approved')) set('Deal Stage', 'Approved'); }).catch(() => {});
  return `video approved: ${row.title} set to To Post${st ? `, card ${st}` : ''}`;
}

function openDealShape(p) {
  const get = (n) => plain(p.properties?.[n]);
  return { id: p.id, url: p.url, brand: get('Brand Name') || 'Untitled', creator: get('Creator'), stage: get('Deal Stage'), brandEmail: creatorSide(get('Brand Email')) ? null : get('Brand Email'), linkedVideo: get('Linked Video'), threadId: get('Thread ID'), messageRfc: get('Message ID'), threadSubject: get('Thread Subject'), threadCc: get('Thread CC') || '', agentNotes: get('Agent Notes') || '', finalRate: get('Final Rate USD'), invoiceAmount: get('Invoice Amount'), followUps: Number(get('Follow-ups Sent') || 0), deliverables: get('Deliverables'), postedLinks: get('Posted Links'), needsCheck: get('Needs Check') === true, paused: get('Paused') === true, nextAction: get('Next Action') || '', memory: get('Deal Memory') || '', notes: get('Notes') || '', invoiceSent: get('Invoice Sent Date') || '', postingHold: get('Posting Hold') || '' };
}

async function createDealFor(x, email, board) {
  const schema = await schemaOf(DS.deals);
  const props = { 'Brand Name': { title: [{ type: 'text', text: { content: (x.brand || 'Unknown brand').slice(0, 200) } }] } };
  setIf(schema, props, 'Creator', board.creator);
  setIf(schema, props, 'Deal Source', 'Auto-captured');
  // A deal found on an old thread whose video is already invoiced or paid starts at Posted: the invoicing step then
  // checks Stripe and the thread instead of trusting the AI that money has moved
  const firstStage = MONEY_STAGES.includes(x.deal_stage) ? 'Posted' : x.deal_stage;
  const sure = firstStage && x.confidence === 'high' && STAGES.includes(firstStage);
  setIf(schema, props, 'Needs Check', !sure || firstStage !== x.deal_stage);
  if (sure) setIf(schema, props, 'Deal Stage', firstStage);
  // Only the brand's own address goes in Brand Email (the creator or NOOCAP forwarding a thread isn't the brand)
  if (x.from_role === 'brand') setIf(schema, props, 'Brand Email', (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0]);
  // A handover (the creator's team adding noocapcollab) is written TO the brand: its first brand-side address is the
  // contact. Panda Security x Chris and Valchy AI x Valeri were opened with no Brand Email on Nov 5, so nothing could
  // reply to them until the brand wrote again (system check, Nov 5)
  else if (isHandover(email, x)) setIf(schema, props, 'Brand Email', handoverBrandEmail(email));
  setIf(schema, props, 'Thread ID', email.threadId);
  setIf(schema, props, 'Message ID', email.messageId);
  setIf(schema, props, 'Thread Subject', threadSubject(email.subject));
  setIf(schema, props, 'Thread CC', threadCcFrom(email));
  // Same thread already has a deal (e.g. two emails of one thread arriving together)? Use that one.
  const sameThread = async () => (email.threadId ? (await notion('POST', `/data_sources/${DS.deals}/query`, { page_size: 10, filter: { property: 'Thread ID', rich_text: { equals: email.threadId } }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] })).results || [] : [])
    .filter((p) => plain(p.properties?.['Deal Stage']) !== 'Lost');
  const existing = (await sameThread())[0];
  if (existing) return { reused: true, ...openDealShape(existing) };
  const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.deals }, properties: props });
  // A parallel request may have created one at the same moment: keep the oldest, close ours as a duplicate
  const all = await sameThread();
  if (all.length > 1 && all[0].id !== page.id) {
    await notion('PATCH', `/pages/${page.id}`, { properties: { 'Deal Stage': { select: { name: 'Lost' } }, 'Agent Notes': { rich_text: [{ type: 'text', text: { content: 'Duplicate of another deal on the same email thread, closed automatically.' } }] } } }).catch(() => {});
    return { reused: true, ...openDealShape(all[0]) };
  }
  return { id: page.id, url: page.url, brand: x.brand || 'Unknown brand', creator: board.creator, stage: sure ? firstStage : null, needsCheck: !sure || firstStage !== x.deal_stage, agentNotes: '', followUps: 0, brandEmail: props['Brand Email']?.email || null, threadId: email.threadId, messageRfc: email.messageId, threadSubject: threadSubject(email.subject), threadCc: threadCcFrom(email) };
}

const money = (n, c) => (n == null ? '' : `${c && c !== 'USD' ? c + ' ' : '$'}${Number(n).toLocaleString('en-US')}`);

const normBrand = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
// One thread, several deals of the same brand (a repeat campaign: ElevenLabs x Duncan October is being paid while
// November's script is in progress, same thread). Money talk goes to the deal waiting on money; everything else goes to
// the newest deal still in the work, so a new brief or script never lands on last month's finished deal.
const MONEY_TALK = /\b(invoice|payment|paid|pay\b|remittance|wire|transfer|finance team|billing)/i;
export function threadDeal(deals, email, text = '') {
  if (!email?.threadId) return null;
  const on = deals.filter((d) => d.stage !== 'Lost' && d.threadId && d.threadId === email.threadId);
  if (on.length < 2) return on[0] || null;
  // Different brands on one agency thread (Zeely and CapCut): the brand decides, not this
  if (new Set(on.map((d) => normBrand(d.brand))).size > 1) return on[0];
  const working = on.filter((d) => stageBefore(d.stage, 'Posted')).sort((a, b) => Date.parse(b.created || 0) - Date.parse(a.created || 0));
  const owed = on.filter((d) => ['Posted', 'Invoiced'].includes(d.stage));
  const body = `${email.subject || ''} ${latestText(text || email.text || '')}`;
  if (MONEY_TALK.test(body) && owed.length) return owed[0];
  return working[0] || on[0];
}

export function matchDealIndex(deals, email, x) {
  const live = (d) => d.stage !== 'Lost';
  const b = normBrand(x.brand);
  // One agency thread can carry several brands (Mediacube runs Zeely and CapCut for Duncan in one thread): the deal
  // whose brand this email is about wins over the first deal on the thread
  const onThread = email.threadId ? deals.map((d, k) => [d, k]).filter(([d]) => live(d) && d.threadId && d.threadId === email.threadId) : [];
  if (onThread.length > 1 && b) { const hit = onThread.find(([d]) => normBrand(d.brand) === b) || onThread.find(([d]) => normBrand(d.brand).includes(b) || b.includes(normBrand(d.brand))); if (hit) return hit[1]; }
  if (onThread.length > 1) { const t = threadDeal(deals, email); const k = deals.indexOf(t); if (k >= 0) return k; }
  if (onThread.length) return onThread[0][1];
  if (!b) return -1;
  const same = deals.map((d, k) => [d, k]).filter(([d]) => live(d) && normBrand(d.brand) === b && (!x.creator || !d.creator || CREATOR_KEY(d.creator) === CREATOR_KEY(x.creator)));
  // prefer an unpaid deal when there are several for the same brand
  const pick = same.find(([d]) => d.stage !== 'Paid') || same[0];
  return pick ? pick[1] : -1;
}

// The sponsor video a deal is about: the linked card, else a SPONSOR card on the creator's board named after the brand
// Which creator is this brand working with? The one creator with a SPONSOR card named after the brand that was
// touched in the last 30 days. Two creators with recent cards (or none) = don't guess.
async function creatorFromCards(brand) {
  const b = normBrand(brand);
  if (!b || b.length < 3) return null;
  const since = Date.now() - 30 * 864e5;
  const hits = new Set();
  await Promise.all(BOARDS.map(async (board) => {
    let pages = [];
    try { pages = await queryAll(board.ds); } catch { return; }
    for (const p of pages) {
      const t = Object.values(p.properties || {}).find((v) => v.type === 'title');
      if (!normBrand(plain(t)).includes(b)) continue;
      const pd = Object.entries(p.properties || {}).find(([n, v]) => v.type === 'date' && /post/i.test(n))?.[1]?.date?.start;
      const recent = Math.max(new Date(p.last_edited_time || 0).getTime(), pd ? new Date(pd).getTime() : 0) >= since;
      if (recent) hits.add(board.creator);
    }
  }));
  return hits.size === 1 ? [...hits][0] : null;
}

async function findDealVideo(deal) {
  const linked = pageIdFromUrl(deal.linkedVideo);
  if (linked) { try { return await notion('GET', `/pages/${linked}`); } catch { /* fall through */ } }
  const board = BOARDS.find((b) => CREATOR_KEY(b.creator) === CREATOR_KEY(deal.creator || ''));
  const b = normBrand(deal.brand);
  if (!board || !b) return null;
  const pages = await queryAll(board.ds, undefined, { useCache: false });
  const hits = pages.filter((p) => {
    const t = Object.values(p.properties || {}).find((v) => v.type === 'title');
    return normBrand(plain(t)).includes(b);
  });
  const status = (p) => parseInt(plain(Object.entries(p.properties || {}).find(([n]) => n.toLowerCase() === 'status')?.[1]) || '', 10);
  hits.sort((a, c) => (status(c) || 0) - (status(a) || 0));
  return hits.length === 1 || (hits.length > 1 && status(hits[0]) >= 12 && status(hits[1]) < 12) ? hits[0] : (hits.length ? { ambiguous: hits.length } : null);
}

// Payment in: tick (or create) the row in Sponsor Video Revenue so the revenue dashboard shows it paid
// The brand's proof of payment (a receipt screenshot or PDF), as Notion uploads for the revenue row's Payment Proof.
// Each row gets its own upload. Tiny images (signature logos) are skipped.
// The pictures that carry an email's message: only when the sender wrote next to nothing of their own (an image-only reply)
export const messageImages = (email) => latestText(email.text || '').replace(/\[cid:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().length > 200 ? []
  : (email.attachments || []).filter((a) => a.data && /^image\/(png|jpe?g|gif|webp)$/i.test(a.mimeType || '') && Buffer.byteLength(a.data, 'base64') > 15000 && Buffer.byteLength(a.data, 'base64') < 4.5e6)
    .map((a) => ({ ...a, mimeType: String(a.mimeType).toLowerCase().replace('jpg', 'jpeg') })).slice(0, 2);
export const proofFilesOf = (email) => (email.attachments || []).filter((a) => a.data && ((/^image\//i.test(a.mimeType || '') && Buffer.byteLength(a.data, 'base64') > 15000) || /pdf/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || ''))).slice(0, 4);
async function proofProp(files) {
  const out = [];
  for (const f of files || []) { const id = await uploadToNotion(f).catch(() => null); if (id) out.push({ type: 'file_upload', file_upload: { id }, name: String(f.filename || 'payment-proof').slice(0, 90) }); }
  return out.length ? { 'Payment Proof': { files: out } } : {};
}
export async function markRevenuePaid(deal, x, proof = []) {
  const paidOn0 = x.paid_date && /^\d{4}-\d{2}-\d{2}/.test(x.paid_date) ? x.paid_date.slice(0, 10) : todayIST();
  // One payment often covers several videos invoiced together (HOLO 1 + HOLO 2): tick every invoiced, unpaid row
  const key = dealKey(deal.brand);
  if (key.length >= 3) {
    const all = await queryAll(DS.revenue, undefined, { useCache: false });
    const open = all.filter((r) => {
      const g = (n) => plain(r.properties?.[n]);
      if (g('Paid') === true || !g('Invoice Sent')) return false;
      if (deal.creator && g('Creator') && CREATOR_KEY(g('Creator')) !== CREATOR_KEY(deal.creator)) return false;
      const title = plain(Object.values(r.properties || {}).find((v) => v.type === 'title')) || '';
      return rowIsBrand(g('Brand'), title, key);
    });
    if (open.length) {
      for (const r of open) await notion('PATCH', `/pages/${r.id}`, { properties: { Paid: { checkbox: true }, 'Payment Received': { date: { start: paidOn0 } }, ...(await proofProp(proof)) } });
      clearCache();
      return `revenue marked paid for ${open.map((r) => `"${plain(Object.values(r.properties || {}).find((v) => v.type === 'title')) || deal.brand}"`).join(', ')}`;
    }
  }
  const video = await findDealVideo(deal);
  if (!video) return 'no sponsor video found on the board';
  if (video.ambiguous) return `${video.ambiguous} videos match "${deal.brand}", so I didn't guess which one`;
  const vid = video.id.replace(/-/g, '');
  const rows = await queryAll(DS.revenue, undefined, { useCache: false });
  const row = rows.find((r) => pageIdFromUrl(plain(r.properties?.['Video Link'])) === vid);
  const usd = (!x.currency || /usd|\$/i.test(x.currency)) && Number(x.amount) > 0 ? Number(x.amount) : Number(deal.finalRate || deal.invoiceAmount) || null;
  const paidOn = x.paid_date && /^\d{4}-\d{2}-\d{2}/.test(x.paid_date) ? x.paid_date.slice(0, 10) : todayIST();
  const title = plain(Object.values(video.properties || {}).find((v) => v.type === 'title')) || deal.brand;
  if (row) {
    const p = { Paid: { checkbox: true }, 'Payment Received': { date: { start: paidOn } }, ...(await proofProp(proof)) };
    if (usd && !plain(row.properties?.['Amount USD'])) p['Amount USD'] = { number: usd };
    await notion('PATCH', `/pages/${row.id}`, { properties: p });
  } else {
    const rt = (t) => [{ type: 'text', text: { content: String(t).slice(0, 1900) } }];
    const props = {
      'Video Title': { title: rt(title) }, 'Video Link': { url: video.url }, Paid: { checkbox: true },
      'Payment Received': { date: { start: paidOn } }, Notes: { rich_text: rt(`Marked paid by the PM from ${deal.brand}'s email${usd ? '' : '. Amount to confirm.'}`) },
      ...(await proofProp(proof)),
    };
    if (deal.creator) props.Creator = { select: { name: deal.creator } };
    if (usd) props['Amount USD'] = { number: usd };
    await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.revenue }, properties: props });
  }
  if (!deal.linkedVideo) { try { await patchDeal(deal, (set) => set('Linked Video', video.url)); } catch { /* ignore */ } }
  return `revenue marked paid for "${title}"${usd ? ` ($${usd})` : ' (add the amount on the revenue dashboard)'}`;
}

// Creator invoiced the brand directly: stamp Invoice Sent on the sponsor video's revenue row
export async function markRevenueInvoiced(deal, x) {
  const video = await findDealVideo(deal);
  if (!video) return 'no sponsor video found on the board';
  if (video.ambiguous) return `${video.ambiguous} videos match "${deal.brand}", set Invoice Sent by hand`;
  const vid = video.id.replace(/-/g, '');
  const rows = await queryAll(DS.revenue, undefined, { useCache: false });
  const row = rows.find((r) => pageIdFromUrl(plain(r.properties?.['Video Link'])) === vid);
  const usd = (!x.currency || /usd|\$/i.test(x.currency)) && Number(x.amount) > 0 ? Number(x.amount) : null;
  const title = plain(Object.values(video.properties || {}).find((v) => v.type === 'title')) || deal.brand;
  const p = { 'Invoice Sent': { date: { start: todayIST() } } };
  if (row) {
    if (usd && !plain(row.properties?.['Amount USD'])) p['Amount USD'] = { number: usd };
    await notion('PATCH', `/pages/${row.id}`, { properties: p });
  } else {
    const rt = (t) => [{ type: 'text', text: { content: String(t).slice(0, 1900) } }];
    Object.assign(p, { 'Video Title': { title: rt(title) }, 'Video Link': { url: video.url }, Paid: { checkbox: false }, Brand: { rich_text: rt(deal.brand) } });
    if (deal.creator) p.Creator = { select: { name: deal.creator } };
    if (usd) p['Amount USD'] = { number: usd };
    await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.revenue }, properties: p });
  }
  if (!deal.linkedVideo) { try { await patchDeal(deal, (set) => set('Linked Video', video.url)); } catch { /* ignore */ } }
  return `Invoice Sent stamped on "${title}"`;
}

// ---------- replies sent by hand from Gmail ----------
// n8n also sweeps the Sent folder. When NOOCAP replies in a thread (by hand or through Approvals), we note it, retire any
// draft still waiting for that thread, and never draft a reply to a brand email we've already answered.
// Each creator's own email domain. Used to tell their team from the brand, and to know whose deal a thread is:
// a thread copying collab@automateaiconsulting.com is Lindsay's. Override with CREATOR_DOMAINS="domain:Creator,..."
const CREATOR_DOMAIN = Object.fromEntries(String(CREATOR_DOMAINS).split(',').map((p) => p.split(':').map((x) => x.trim())).filter(([d, c]) => d && c).map(([d, c]) => [d.toLowerCase(), c]));
const CREATOR_SIDE = [...new Set([...Object.keys(CREATOR_DOMAIN), ...String(process.env.CREATOR_SIDE_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)])];
// The creator whose own address is on the thread (From, To or Cc), if exactly one is
function creatorFromAddresses(email) {
  const doms = (`${email.from || ''} ${email.to || ''} ${email.cc || ''}`.match(/@([\w.-]+)/g) || []).map((a) => a.slice(1).toLowerCase());
  const found = new Set();
  for (const d of doms) for (const [dom, c] of Object.entries(CREATOR_DOMAIN)) if (d === dom || d.endsWith('.' + dom)) found.add(c);
  if (found.size === 1) return [...found][0];
  // Several creators copied (one agency runs deals for both): the creator named in the subject decides,
  // "[PAID] (valeridoesai)X(tripo)" is Valeri's even with Lindsay's inbox on the Cc
  if (found.size > 1) { const s = creatorFromSubject(email.subject); if (s && found.has(s)) return s; }
  return null;
}
function creatorFromSubject(subject) {
  const s = String(subject || '').toLowerCase();
  const hits = [...new Set(Object.values(CREATOR_DOMAIN))].filter((c) => new RegExp(`(^|[^a-z])${c.toLowerCase()}`).test(s));
  return hits.length === 1 ? hits[0] : null;
}
const creatorSide = (from) => { const d = (String(from || '').match(/@([\w.-]+)/) || [])[1]; return !!d && CREATOR_SIDE.some((c) => d.toLowerCase() === c || d.toLowerCase().endsWith('.' + c)); };
const ourAddress = (from) => lc(from).includes('noocapcollab');
// Only our own inboxes speak for NOOCAP. An outside company address the reader calls "noocap" is the brand's side:
// Nicole at Quil Media (PromoCut's agency) wrote "the script is under review" and "we are waiting for the client's
// approval"; both were filed as our own emails, so PromoCut's deal kept Nov 4 as the brand's last word and the
// follow-ups were counted from it (system check, Nov 10). Free mailboxes stay as read (a creator may write from Gmail).
// "We're unable to open the link", "the link gives a 404", "could you re-share the link"
export function linkBroken(text) {
  const t = String(text || '');
  return /\b(unable|can'?t|cannot|couldn'?t|could not|not able|having trouble|trouble)\b[^.!?\n]{0,40}\b(open|access|load|view|play)\b[^.!?\n]{0,40}\b(link|video|cut|draft|file)\b|\b(link|video|draft)\b[^.!?\n]{0,60}\b(404|doesn'?t (seem to )?(load|open|work)|does not (load|open|work)|isn'?t (loading|working|opening)|broken|expired|not found)\b|\bre-?(share|send)\b[^.!?\n]{0,20}\b(the )?(video )?link\b/i.test(t);
}
async function lastLinkSent(deal) {
  if (!deal?.id) return null;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 15, filter: { and: [{ property: 'Deal', relation: { contains: deal.id } }, { property: 'Status', select: { equals: 'Sent' } }] }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }).catch(() => ({ results: [] }));
  for (const p of r.results || []) {
    const m = plain(p.properties?.Body).match(/https?:\/\/(?:f\.io|(?:next|app)\.frame\.io|drive\.google\.com|www\.loom\.com|youtu\.be|(?:www\.)?youtube\.com|we\.tl|wetransfer\.com)\/[^\s<>")\]]+/i);
    if (m) return m[0].replace(/[.,;:!?)\]']+$/, '');
  }
  return null;
}
export function sideOf(from, role) {
  if (role !== 'noocap') return role;
  const d = domainOf(from);
  if (!d || ourAddress(from) || creatorSide(from) || FREE_MAIL.test(d)) return role;
  return 'brand';
}
const emailTime = (email) => { const t = Date.parse(email.date || ''); return Number.isFinite(t) ? t : Date.now(); };

// Has any newer message in this thread been seen (from anyone)? Then this email isn't the latest and needs no reply of its own.
async function laterInThread(email) {
  if (!email.threadId || !email.date) return false;
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 5, filter: { and: [
    { property: 'Thread ID', rich_text: { equals: email.threadId } },
    { property: 'Email Date', date: { after: new Date(emailTime(email)).toISOString() } },
  ] } }).catch(() => ({ results: [] }));
  return (r.results || []).some((p) => plain(p.properties?.['Message ID']) !== String(email.messageId || '').slice(0, 1900));
}

// The mark on an email the PM left for Harsh: the thread and which fixed reply (if any) it looked like, so his own
// reply in that thread is learned from (learnFromOurReply)
const unreadTag = (email, deal, x) => `[unread thread:${email.threadId || deal.threadId || ''} template:${x.template || 'none'}]`;

// Fixed replies for the brand messages that keep coming back (lib/replytemplates.js). Returns what happened.
// Which fixed reply answers a brand chasing team work, when the reader didn't name one
export function templateForWork(need) {
  const t = String(need || '');
  if (/\bscripts?\b/i.test(t)) return 'script_eta';
  if (/\b(revis\w*|changes?|fix(es)?|cover|caption|thumbnail)\b/i.test(t)) return 'revision_eta';
  if (/\b(cut|video|draft|edit)\b/i.test(t)) return 'video_eta';
  return null;
}

async function templateReply(email, deal, x) {
  const threadId = email.threadId || deal.threadId;
  if (await weRepliedAfter(email)) return 'Template skipped: we already replied after this message';
  const stage = x.deal_stage || deal.stage;
  const { etaPromised, statusAckFor } = await import('./replytemplates.js');
  // A template the stage doesn't allow on a plain status update: the stage's own acknowledgement instead
  { const all = await loadTemplates(); const t0 = all.find((y) => y.key === x.template && y.active);
    const alt = statusAckFor(stage);
    if (t0 && !t0.stages.includes(stage) && alt && alt !== x.template && !x.needs_our_info) x.template = alt; }
  const t = (await loadTemplates()).find((y) => y.key === x.template && y.active);
  const block = templateBlock(t, { stage, deadline: x.due_by || deal.deadline, today: todayIST(), sentRecently: await sentRecently(OUTBOX_DS, threadId, x.template, { since: new Date(emailTime(email)).toISOString() }), etaPromised: /_eta$/.test(x.template || '') ? await etaPromised(OUTBOX_DS, threadId) : '' });
  if (block) return `Template ${x.template} not sent: ${block}`;
  // The billing ask on approval only goes when we have no company details yet, haven't asked, and the creator invoices
  // through Stripe (Brad is invoiced by hand, WhatsApp deals are Harsh's)
  if (x.template === 'billing_on_approval') {
    const { readBilling: rb, NO_STRIPE } = await import('./invoicing.js');
    if (rb(deal.billing) || deal.billingRequested || deal.channel === 'WhatsApp' || NO_STRIPE.includes(String(deal.creator || '').toLowerCase())) return `Template ${x.template} not sent: billing details already in or asked for`;
  }
  const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
  const here = { ...(email.threadId ? { ...deal, threadId: email.threadId, messageRfc: email.messageId || deal.messageRfc, threadSubject: threadSubject(email.subject) || deal.threadSubject } : deal), ...(sender && !creatorSide(sender) ? { brandEmail: sender } : {}) };
  const { cardPostDate } = await import('./replytemplates.js');
  const postDate = /\{post_date\}/.test(t.body) ? await cardPostDate(deal) : '';
  if (/\{post_date\}/.test(t.body) && !postDate) return `Template ${x.template} not sent: no upcoming POST DATE on the video card (none, or it has passed)`;
  let body = fillTemplate(t.body, { from: email.from, deal, postDate, text: latestText(email.text || '') });
  // No promise of a script that already went (Topview AI x Lindsay contract_ack, Nov 22)
  { const { dropSentScriptPromise } = await import('./replytemplates.js'); body = dropSentScriptPromise(body, deal); }
  // A fixed opening line for a second thing in the same email (the video was approved too: "we'll publish it and share
  // the live link"), put after the greeting. No date in it: the posting date is Harsh's (CapCut x Chris, Nov 18)
  if (x.leadLine) body = body.replace(/^(Hi [^\n]*\n\n)/, `$1${x.leadLine}\n\n`);
  const r = await createDraft({ kind: 'Reply', deal: here, subject: `Re: ${here.threadSubject || deal.brand}`, body, video: deal.linkedVideo, notify: false, why: `Fixed reply (sends on its own) [template:${x.template}] [from:${new Date(emailTime(email)).toISOString()}]: ${deal.brand} × ${deal.creator}` });
  if (!r?.created || !r.id) return `Template ${x.template} not sent: ${r?.reason || 'draft not made'}`;
  const { autoSend } = await import('./outbox.js');
  const sent = await autoSend(r.id); if (sent?.held) return `Template ${x.template} held for Harsh: ${sent.why}`;
  if (x.template === 'billing_on_approval') await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Billing Request Sent': { date: { start: todayIST() } }, 'Billing Reminders Sent': { number: (deal.billingReminders || 0) + 1 } } }).catch(() => {});
  return `Sent the fixed reply "${x.template}" to ${here.brandEmail}`;
}

// Stripe shows the brand's payment arrived: thank them in their thread with the fixed reply, no ask to Harsh (Harsh,
// Nov 19, ElevenLabs x Duncan: "don't ask me if you think it's paid, just send them the email"). Only on real money
// (Stripe paid or a receipt), once per thread, and only when the brand wrote about the payment or we asked for proof.
// true when the deal was already fully paid (stage Paid with a Paid Date) before a payment email arrives: Harsh heard it
// then, so the brand's "finance has paid" only updates the deal (ElevenLabs x Duncan, Nov 19: Stripe's "Payment received"
// at 18:17 IST, then a second "Paid: no proof, please check it has landed" from the email 7 minutes later). Pure.
export const paidAlready = (deal = {}) => deal.stage === 'Paid' && !!deal.paidDate;

// Another deal of the same brand and creator whose Stripe invoices are all paid, paid within the last 14 days
export async function paidSiblingDeal(deal) {
  const k = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const all = await openDeals({ withClosed: true });
  const sibs = all.filter((d) => d.id !== deal.id && k(d.brand) === k(deal.brand) && k(d.creator) === k(deal.creator) && d.stripeInvoices);
  const I = await import('./invoicing.js');
  for (const d of sibs) {
    if (d.paidDate && Date.now() - Date.parse(d.paidDate) > 14 * 864e5) continue;
    const st = await I.stripeState(d).catch(() => ({ known: false }));
    if (st.known && st.allPaid) return d;
  }
  return null;
}
export async function paymentThanks(deal, email = null) {
  const e = email || { threadId: deal.threadId, from: deal.brandEmail, messageId: deal.messageRfc, subject: deal.threadSubject || deal.brand, date: new Date().toUTCString() };
  if (!e.threadId) return 'Payment thanks not sent: no brand thread on the deal';
  return templateReply(e, deal, { template: 'payment_received_thanks', deal_stage: 'Paid' });
}

async function weRepliedAfter(email) {
  if (!email.threadId) return false;
  if (await laterInThread(email)) return true;
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 20, filter: { and: [
    { property: 'Area', select: { equals: 'Brand deals' } },
    { property: 'Event', title: { starts_with: 'Our ' } },
    { property: 'Details', rich_text: { contains: `thread:${email.threadId}` } },
  ] } }).catch(() => ({ results: [] }));
  const when = emailTime(email);
  return (r.results || []).some((p) => { const m = (plain(p.properties?.Details) || '').match(/at:(\S+)/); return m && Date.parse(m[1]) > when; });
}

// Anyone on our side replying in the thread (NOOCAP, the creator or their team) makes older drafts in that thread stale
async function retireStaleDrafts(email, at) {
  const stale = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 20, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Gmail Thread ID', rich_text: { equals: email.threadId } }] } }).then((r) => r.results || []).catch(() => []);
  // Was this one of the PM's own emails (sent from PM OUTBOX a few minutes ago)? Then it only answers its own kind.
  const pmSent = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Status', select: { equals: 'Sent' } }, { property: 'Gmail Thread ID', rich_text: { equals: email.threadId } }, { property: 'Sent At', date: { on_or_after: new Date(Date.parse(at) - 30 * 60e3).toISOString() } }] } }).then((r) => (r.results || [])[0] || null).catch(() => null);
  const pmKind = pmSent ? plain(pmSent.properties?.Kind) || null : null;
  const retired = [];
  for (const d of stale) {
    const src = ((plain(d.properties?.Why) || '').match(/\[from:([^\]]+)\]/) || [])[1];
    if (Date.parse(d.created_time) >= Date.parse(at) && !(src && Date.parse(src) < Date.parse(at))) continue;
    if (!retiredByOurEmail(plain(d.properties?.Kind), pmKind)) continue;
    await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
    retired.push(plain(d.properties?.Subject) || 'draft');
  }
  return retired;
}

// A reply for this exact email is already waiting in Approvals (an earlier try drafted it, then the run was cut
// off before it could finish): don't draft and ping again
async function draftedFor(email, threadId) {
  if (!threadId) return false;
  const since = new Date(emailTime(email)).toISOString();
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 5, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Kind', select: { equals: 'Reply' } }, { property: 'Gmail Thread ID', rich_text: { equals: threadId } }, { timestamp: 'created_time', created_time: { on_or_after: since } }] } }).catch(() => ({ results: [] }));
  return (r.results || []).length > 0;
}

async function replaceOlderReplies(threadId) {
  if (!threadId) return;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 10, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Kind', select: { equals: 'Reply' } }, { property: 'Gmail Thread ID', rich_text: { equals: threadId } }] } }).catch(() => ({ results: [] }));
  for (const d of r.results || []) await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
}

// The model sometimes returns one string instead of a list. System check Nov 11: Runway x Chris's inbox job failed with
// "(x.we_promised || []).filter is not a function" because we_promised came back as a string, so the email was never filed.
export function normalizeRead(x) {
  for (const k of ['summary', 'we_promised', 'delivers']) if (k in x || k === 'summary') x[k] = asList(x[k]);
  return x;
}

export const asList = (v) => (Array.isArray(v) ? v : v ? String(v).split(/\n|•|;\s/).map((t) => t.replace(/^[-*\s]+/, '').trim()).filter(Boolean) : []);

// A brief that only sits in the quoted history: the brand sent it to the creator alone and NOOCAP was copied back in
// on the creator's reply, so every email the PM reads on the thread quotes the brief but is "about" something else
// (Dreamina x Chris BD-77, Nov 11-12: Jenny's brief with the feishu link, deliverables and "Script Submission: 11/11"
// came in quoted under Chris's reply; the PM read the next email as a brand reply and no card or script writer ever
// saw it, on an urgent video). Returns the quoted brief (money lines out) or ''.
export function quotedBrief(text) {
  const t = String(text || '');
  const latest = latestText(t);
  const quoted = t.length > latest.length ? t.slice(latest.length) : '';
  if (!quoted) return '';
  const lines = quoted.split('\n').map((l) => l.replace(/^\s*(?:>\s*)+/, '').trimEnd());
  const body = lines.join('\n');
  const link = /\bbrief\b[^\n]{0,40}\n?\s*https?:\/\/\S+/i.test(body) || (/https?:\/\/\S*(?:feishu|larksuite|docs\.google|notion\.(?:so|site))\S*/i.test(body) && /\bbrief\b/i.test(body));
  const fields = [/\bdeliverables?\s*:/i, /\bcontent\s+direction\s*:/i, /\bscript\s+(?:submission|deadline|due)\s*:/i, /\b(?:video\s+production|posting|publish(?:ing)?\s+date|go[- ]live)\s*:/i, /\bkey\s+(?:messages?|points)\s*:/i, /\btalking\s+points\s*:/i].filter((r) => r.test(body)).length;
  if (!(link && fields >= 1) && fields < 3) return '';
  // no money ever reaches the card or the script writer
  return noMoney(body).split('\n').filter((l) => !/\b(?:budget|fee|rate|price|cost|compensation|payment|paid|invoice)\b|[$€£¥]\s?\d|\d\s?(?:usd|eur|gbp|rmb)\b/i.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

// The brand's latest message itself, without the quoted history under it
export function latestText(text) {
  const lines = String(text || '').split(/\r?\n/);
  // Zoho's "---- On … wrote ---" and Outlook's "发件人:" too (system check Nov 19, CapCut x Brad)
  const cut = lines.findIndex((l) => /^\s*(On .{4,200}wrote:|-{2,}\s*On .{4,200}wrote\b|-{2,}\s*Original Message|From:\s.+|发件人\s*[:：]|Sent from my|>)/i.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim().slice(0, 2500);
}

// Our side handing the script over ("here's the script draft:", "script attached"), not just talking about it ("so we can
// start working on the script", "when can you expect the script"). Shared by NOOCAP's own emails and the creator's team.
export function handsOverScript(mine) {
  const t = String(mine || '');
  return /(here(?:'s| is| are)|attached|attaching|sharing|please find|sending (?:over|you)|find below|linked below)[^.?!\n]{0,60}\bscripts?\b|\bscripts?\b[^.?!\n]{0,40}\b(attached|below|linked|for (?:your )?(?:review|approval))/i.test(t)
    && !/(start|begin|working on|work on|expect|when can|share the (?:brand )?brief)[^.?!\n]{0,40}\bscripts?\b/i.test(t.match(/[^.?!\n]*\bscripts?\b[^.?!\n]*/i)?.[0] || '');
}

// The script itself, pasted or attached by the creator's team, is the script delivered. It used to be read as a
// promise ("reminder set: send script"), so the deal kept "Send CapCut the script" with no Script Sent Date or
// Last Our Reply after Chris's team had pasted it into Mia's thread (CapCut x Chris, system check Nov 8 night).
export function scriptPromiseKept(promised, fromRole, latest) {
  const handed = fromRole !== 'brand' && handsOverScript(latest);
  // "Send over the contract and brief and we will get started on the script" waits on the BRAND: the script is not
  // owed until the brief arrives, so it is never a "Send <brand> the Script (promised today)" reminder (Fotor x Chris,
  // system check Nov 13: the deal said "We owe: contract and brief" and Harsh was told to send a script)
  const waits = fromRole !== 'brand' && waitsOnBrandForBrief(latest);
  return { handed, promised: handed || waits ? (promised || []).filter((p) => !/\bscripts?\b/i.test(String(p))) : (promised || []) };
}

export function waitsOnBrandForBrief(text) {
  const t = String(text || '');
  return /\b(?:send|share|forward)\s+(?:over\s+|us\s+)?(?:the\s+|your\s+)?(?:contract|(?:content\s+|brand\s+)?brief)[\s\S]{0,160}?\b(?:and|then|so)\s+(?:we\s+(?:will|'ll|can)\s+)?(?:get\s+started|start|begin)\b[\s\S]{0,40}?\bscript/i.test(t)
    || /\bonce\s+(?:we\s+(?:have|receive|get)|you\s+(?:send|share))\b[\s\S]{0,60}?\b(?:brief|contract)\b/i.test(t);
}

async function recordOurSide(email, who) {
  if (!email.threadId) return;
  const at = new Date(emailTime(email)).toISOString();
  // Dates on the deal are India dates (brand emails are too): a reply at 4 AM IST must not land on the day before
  const atDay = new Date(Date.parse(at) + 5.5 * 36e5).toISOString().slice(0, 10);
  const retired = await retireStaleDrafts(email, at);
  await log({ event: `Our side: ${who} replied · ${email.subject || ''}`, outcome: 'Rule', email, details: `thread:${email.threadId} at:${at}${retired.length ? ` · retired ${retired.length} waiting draft(s), already answered` : ''}` });
}

// The brand contact of an email our side wrote: the first To, then Cc, address that is neither ours, the creator's,
// nor a no-reply robot (system check, Nov 5)
export function handoverBrandEmail(email) {
  const all = [...(String(email.to || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || []), ...(String(email.cc || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || [])];
  return all.find((a) => !ourAddress(a) && !creatorSide(a) && !/^(no-?reply|donotreply|do-not-reply|notifications?|mailer-daemon)@/i.test(a)) || null;
}

// Proof of payment already on the deal (memory history or notes). A dated memory line counts only when it is on or after
// the deal's Invoice Sent Date, so proof for an earlier payment (a first half, an old invoice) never marks a new invoice
// paid; undated notes count only when no invoice date is known (Zeely AI x Duncan, Nov 13)
export function earlierProof(memory = '', notes = '', invoiceSent = '') {
  // Only proof that was really sent counts. The memory also records what the brand SAID ("brand stated finance
  // confirmed invoice paid"), and that claim matched "invoice paid" and marked ElevenLabs x Duncan Paid on Yulia's
  // word alone (Nov 19): a claim line never counts, and "invoice paid" is not proof by itself
  const re = /(transfer|payment) confirmation (?:attached|sent|shared|received)|confirmation attached|receipt attached|proof attached|transaction proof|sent (?:the |a )?(?:receipt|transfer confirmation|payment proof)/i;
  const claim = /\b(stat(?:es|ed)|says?|said|claim(?:s|ed)?|told|reports?|asks?|asked)\b/i;
  const since = String(invoiceSent || '').slice(0, 10);
  const lines = String(memory || '').split(/<br\s*\/?>|\n|(?<=\.)\s+(?=20\d\d-)/i);
  for (const l of lines) {
    if (!re.test(l) || (claim.test(l) && !/attached|receipt|proof/i.test(l))) continue;
    const d = (l.match(/\b(20\d\d-\d\d-\d\d)\b/) || [])[1];
    if (!since || (d && d >= since)) return true;
  }
  return !since && re.test(String(notes || ''));
}

// The reply to a loop-in: we confirm we're taking it over and ask only for what's missing (brief, contract)
// Harsh's wording (Nov 13): the same copy for every brand, only the sign-off changes with the creator. Nov 20 (Topview x
// Lindsay): the brand had already sent the brief in the thread, so the reply asks only for what is still missing.
export function handoverAckText({ name, brand, creator, briefShared = false, contractShared = false }) {
  const greet = name && /^[A-Z][a-z'-]{1,20}$/.test(name) ? `Hi ${name},` : `Hi ${brand ? brand + ' team' : 'there'},`;
  const ask = briefShared && contractShared ? "Thanks for the brief and the contract, we'll go through both and start on the script straight away."
    : briefShared ? "Thanks for the brief. Could you share the contract in this thread? Once we have it, we'll start on the script straight away."
    : contractShared ? "Thanks for the contract. Could you share the brief in this thread? Once we have it, we'll start on the script straight away."
    : "Could you share the brief and the contract in this thread? Once we have them, we'll start on the script straight away.";
  return `${greet}\n\nThanks for the introduction. We'll take this collaboration forward from here, so feel free to send everything to this thread.\n\n${ask}\n\nBest,\n${creator}'s Team`;
}
// What the thread already holds: a brief link or file, a contract attached
export function handoverHas(email = {}) {
  const text = String(email.text || '');
  const files = (email.attachments || []).map((a) => a.filename || '').join(' ');
  const briefShared = /\bbrief\b[^\n]{0,120}https?:\/\/|https?:\/\/\S*brief/i.test(text) || /brief/i.test(files);
  const contractShared = /contract|agreement/i.test(files);
  return { briefShared, contractShared };
}

async function ackHandover(deal, email, x) {
  const to = handoverBrandEmail(email) || deal.brandEmail;
  if (!to || !deal.threadId) return null;
  const local = to.split('@')[0];
  const name = /^(info|hello|hi|team|business|partner(ship)?s?|marketing|collab(oration)?s?|creators?|support|contact|admin|bd|influencers?|pr|growth)\b/i.test(local) ? '' : (local.split(/[._-]/)[0] || '').replace(/^./, (c) => c.toUpperCase());
  const body = handoverAckText({ name, brand: deal.brand || x.brand, creator: deal.creator, ...handoverHas(email) }).replace(/\n/g, '<br />');
  return createDraft({ kind: 'Follow-up', deal: { ...deal, brandEmail: to }, to, body, notify: false,
    why: `Loop-in reply: ${deal.creator}'s team handed ${deal.brand || x.brand} to us; confirming we take it from here and asking for the brief and contract` });
}

// Does this brand email still need someone to answer it? Yes when the brand asked for something (needs_reply) or we owe
// them something, and nothing went out or was drafted for them in this handling
export function keepUnread(x = {}, did = '') {
  const asked = !!x.needs_reply || (!!x.we_owe && !/^(nothing|none|n\/a)\b/i.test(String(x.we_owe)));
  if (!asked) return false;
  return !/(sent|reply drafted|drafted|fixed reply|template|loop-in|in approvals|asked harsh|whatsapp ask|left unread)/i.test(String(did || ''));
}

// The creator's team handing a thread to NOOCAP: noocapcollab is on the email and the text asks to add or loop us in
export function isHandover(email, x) {
  // The creator's own team address counts as the creator even when the reader calls it ours (HubSpot x Duncan, Nov 20:
  // collab@buildroom.ai was read as "ours" and the loop-in got no reply)
  if (!x || !x.brand || !(x.from_role === 'creator' || (x.from_role !== 'brand' && creatorSide(email.from)))) return false;
  const onIt = /noocapcollab@/i.test(`${email.to || ''} ${email.cc || ''}`);
  // Igniters Media x Chris, Nov 18: "I have also looped in noocapcollab@gmail.com to take it over" was missed (past tense)
  // Fotor x Chris, Nov 13: "please send over the contract and content brief to noocapcollab@gmail.com (cc'd here)" is a
  // handover too: the brand is told to send the paperwork to us, so we take it from here
  const ask = /(add|added|adding|loop(ed|ing)? in|cc(ing|'?d)?|copy(ing)?|copied|include|included|including)\b[^.\n]{0,40}noocapcollab|noocapcollab@\S*\s*\((cc'?d|cc|copied|added|looped)\b|\b(send|share|forward|email)\b[^.\n]{0,80}\bto noocapcollab|take (it |this )?over|taking (it |this )?over|in the loop|take (things|it|this) forward|from here on|handl(e|ing) (it|this|the collab)|will handle|(my|our) (team|manager|management) (will|is)/i.test(latestText(email.text));
  return onIt && ask;
}

const dealKey = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
// Is this revenue row this brand's? The Brand field must be the brand ("Pine" is not "Pinecone"); with no Brand field,
// the title must start with the brand followed by a number or the end ("PINE AI 2" yes, "PINECONE" no)
const rowIsBrand = (brandField, title, key) => {
  if (brandField) return dealKey(brandField) === key;
  const t = String(title || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return t.replace(/ /g, '').startsWith(key) && new RegExp('^' + key.split('').join(' ?') + '(?: |$|\\d)').test(t);
};
async function stampInvoiceSent(deal, day) {
  const key = dealKey(deal.brand);
  if (key.length < 3) return [];
  const rows = await queryAll(DS.revenue, undefined, { useCache: false });
  const done = [];
  for (const r of rows) {
    const g = (n) => plain(r.properties?.[n]);
    if (g('Paid') === true || g('Invoice Sent')) continue;
    if (deal.creator && g('Creator') && CREATOR_KEY(g('Creator')) !== CREATOR_KEY(deal.creator)) continue;
    const title = plain(Object.values(r.properties || {}).find((v) => v.type === 'title')) || '';
    if (!rowIsBrand(g('Brand'), title, key)) continue;
    await notion('PATCH', `/pages/${r.id}`, { properties: { 'Invoice Sent': { date: { start: day } } } });
    done.push({ title: title || deal.brand, amount: Number(g('Amount USD')) || 0 });
  }
  if (done.length) clearCache();
  return done;
}

const mine0 = (email) => latestText(email.text || '');
// "due October 12, 2026" / "due by Oct 12" / "due 2026-10-12" in our invoice email
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dueFromText(t) {
  const iso = String(t).match(/\bdue\b[^\n]{0,20}?(\d{4}-\d{2}-\d{2})/i);
  if (iso) return iso[1];
  const m = String(t).match(/\bdue\b[^\n]{0,20}?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  if (!m) return null;
  const now = new Date(Date.now() + 5.5 * 36e5);
  let y = Number(m[3]) || now.getUTCFullYear();
  const mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3));
  let d = new Date(Date.UTC(y, mo, Number(m[2])));
  if (!m[3] && d < now - 60 * 864e5) d = new Date(Date.UTC(y + 1, mo, Number(m[2])));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// What our own email (sent by hand) leaves us waiting for, so the deal says it. "Here's the topic, once you approve
// we'll script" means the brand has the ball even though the video card still sits at script draft.
export function ourAskText(w) {
  const t = String(w ?? '').trim().replace(/^waiting (for|on)\s+/i, '').trim();
  return t && !/^(null|none|nothing|n\/a|undefined|-)\.?$/i.test(t) ? t.slice(0, 160) : null;
}
async function ourAsk(text, deal) {
  const t = String(text || '').trim().slice(0, 2500);
  if (!t) return null;
  try {
    const out = await claude({ _job: 'inbox-ours', model: HAIKU, max_tokens: 120, tools: [{ name: 'ask', description: 'What this email from us leaves us waiting on the brand for', input_schema: { type: 'object', properties: {
      waiting_for: { type: ['string', 'null'], description: `If our email asks ${deal.brand} to approve, answer, decide or send something before we can move on, a short phrase naming who and what, e.g. "Iddo to approve the topic" or "the brand to send the contract". A follow-up chasing an earlier ask names that earlier ask. null if we only shared an update, thanked them, or delivered something with nothing asked.` },
    }, required: ['waiting_for'] } }], tool_choice: { type: 'tool', name: 'ask' },
      messages: [{ role: 'user', content: `Our email to ${deal.brand} (latest message only):\n\n${t}` }] });
    const w = out.content?.find((c) => c.type === 'tool_use')?.input?.waiting_for;
    // The model sometimes answers the text "null" (SpeakOn x Chris, Nov 16-19: Next Action "Waiting for null" and a
    // follow-up "waiting for null"; system check Nov 19)
    return ourAskText(w);
  } catch { return null; }
}

// Our email makes the waiting drafts in its thread stale. One written by hand answers whatever was waiting; one the PM
// sent itself only answers its own kind. Gamut x Lindsay, Nov 10: the auto-sent "Tool access" email rejected the waiting
// "Needs you" reply carrying Iddo's question (new date for the draft cut), so the question never reached Harsh.
export function retiredByOurEmail(draftKind, pmKind) {
  if (!pmKind) return true;
  return String(draftKind || '') === String(pmKind);
}
// Links to a live post in an email we sent (Instagram reel/post, TikTok video, YouTube Short, Facebook reel)
export function livePostLinks(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>()"']+/g) || [];
  return [...new Set(urls.map((u) => u.replace(/[.,;:!*\]]+$/, '')).filter((u) => /instagram\.com\/(reel|p)\/|tiktok\.com\/@[^/]+\/video\/|youtube\.com\/shorts\/|youtu\.be\/|facebook\.com\/(reel|share\/r)\/|fb\.watch\//i.test(u)))];
}

async function handleOurReply(email, deals) {
  if (!email.threadId) return { action: 'skipped', why: 'sent by us' };
  const at = new Date(emailTime(email)).toISOString();
  // India date of our email (a 4 AM IST email is not the day before). Without it a hand-sent script was never recorded.
  const atDay = new Date(Date.parse(at) + 5.5 * 36e5).toISOString().slice(0, 10);
  // Drafts for this thread made before this reply went out are now stale
  const stale = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 20, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Gmail Thread ID', rich_text: { equals: email.threadId } }] } }).then((r) => r.results || []).catch(() => []);
  const retired = [];
  for (const d of stale) {
    const src = ((plain(d.properties?.Why) || '').match(/\[from:([^\]]+)\]/) || [])[1];
    if (Date.parse(d.created_time) >= Date.parse(at) && !(src && Date.parse(src) < Date.parse(at))) continue;
    await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
    retired.push(plain(d.properties?.Subject) || 'draft');
  }
  const sentFiles = (email.attachments || []).length > 0;
  // The deal: same Gmail thread, or (an invoice sent in a fresh email) the deal whose brand address is on this email
  const recipientDomains = (`${email.to || ''} ${email.cc || ''}`.match(/@([\w.-]+\.\w+)/g) || []).map((a) => a.slice(1).toLowerCase()).filter((d) => !/gmail|outlook|yahoo|hotmail|icloud|noocap/.test(d) && !CREATOR_SIDE.includes(d));
  let deal = threadDeal(deals, email);
  if (!deal && recipientDomains.length) {
    const byDomain = deals.filter((d) => d.stage !== 'Lost' && d.brandEmail && recipientDomains.includes(domainOf(d.brandEmail)));
    const creatorHint = creatorFromAddresses(email);
    // Exactly one match, or it stays unlinked: two creators with the same brand must not get each other's invoice
    const fit = byDomain.filter((d) => !creatorHint || CREATOR_KEY(d.creator || '') === CREATOR_KEY(creatorHint));
    deal = fit.length === 1 ? fit[0] : null;
  }
  // Our "it's live, here are the links" email marks the deal Posted with its links, so the invoice step can run
  // (Emergent x Chris, Nov 21: "The video has been successfully published! Here's the link" left the deal at Approved
  // with no posted links, and the invoice was never raised)
  if (deal) {
    const live = livePostLinks(latestText(email.text || ''));
    if (live.length && /\b(live|published|posted|went up|is up)\b/i.test(latestText(email.text || ''))) {
      try {
        const have = String(deal.postedLinks || '');
        const add = live.filter((u) => !have.includes(u.replace(/[?#].*$/, '')));
        const ds = await schemaOf(DS.deals); const pp = {};
        if (add.length) setIf(ds, pp, 'Posted Links', [have.trim(), ...add].filter(Boolean).join('\n').slice(0, 1900));
        if (stageBefore(deal.stage, 'Posted')) setIf(ds, pp, 'Deal Stage', 'Posted');
        if (Object.keys(pp).length) { await notion('PATCH', `/pages/${deal.id}`, { properties: pp }); deal = { ...deal, postedLinks: pp['Posted Links'] ? [have, ...add].join('\n') : deal.postedLinks, stage: pp['Deal Stage'] ? 'Posted' : deal.stage }; }
      } catch (e) { console.error('posted links from our email', e.message); }
    }
  }
  const cleared = deal && sentFiles && /^Send /.test(deal.nextAction || '');
  // An invoice sent by hand (PDF named like an invoice) moves the deal to Invoiced so the PM chases the payment
  const invoiceSent = sentFiles && ((email.attachments || []).some((a) => /invoice|\binv[-_ ]?\d/i.test(a.filename || '')) || /invoice/i.test(`${email.subject || ''} ${latestText(email.text || '')}`));
  // Every posted, unpaid video of this brand × creator gets "Invoice Sent" (one email can carry the invoices for
  // HOLO 1 and HOLO 2), so they leave "Invoice to send" and the PM starts chasing the payment instead
  let stamped = [];
  if (deal && invoiceSent) stamped = await stampInvoiceSent(deal, at.slice(0, 10)).catch(() => []);
  // Repeat business: the deal was Paid for an earlier video and this invoice covers new ones, so it opens again
  const reopened = deal && invoiceSent && deal.stage === 'Paid' && stamped.length > 0;
  const invoiced = deal && invoiceSent && (stageBefore(deal.stage, 'Invoiced') || reopened);
  const billed = stamped.reduce((sum, r) => sum + (r.amount || 0), 0);
  const dueDay = dueFromText(`${email.subject || ''} ${mine0(email)}`) || new Date(Date.now() + 5.5 * 36e5 + 21 * 864e5).toISOString().slice(0, 10); // ~14 business days
  // A script sent by hand (script file, or a doc link in a message about the script) moves the deal to Script Sent,
  // so the PM waits for approval and follows up if the brand goes quiet
  const mine = latestText(email.text || '');
  const scriptFile = (email.attachments || []).some((a) => /script/i.test(a.filename || '') && !/contract|agreement|invoice|w-?9|nda/i.test(a.filename || ''));
  // Only when we're actually handing the script over ("here's the script", "script attached"), not when the word just
  // comes up ("so we can start working on the script", "when can you expect the script")
  const sharing = handsOverScript(mine);
  const scriptLink = sharing && (scriptFile || /docs\.google\.com|notion\.(so|site)|drive\.google\.com/i.test(mine) || (email.attachments || []).some((a) => /\.(pdf|docx?)$/i.test(a.filename || '') && !/contract|agreement|invoice|w-?9|nda/i.test(a.filename || '')));
  const scriptSent = deal && !invoiced && (scriptFile || scriptLink) && stageBefore(deal.stage, 'Script Sent') && !['Inbound', 'Negotiating'].includes(deal.stage);
  const in3 = new Date(Date.now() + 5.5 * 36e5 + 3 * 864e5).toISOString().slice(0, 10);
  // A cut shared by hand (Frame.io link in our own message) moves the deal to Submitted, so the PM never sends the cut again
  const cutLink = (mine.match(/https?:\/\/(?:[\w-]+\.)*(?:frame\.io|f\.io)\/[^\s<>")]+/i) || [])[0];
  const cutShared = deal && !invoiced && !scriptSent && cutLink && stageBefore(deal.stage, 'Submitted') && !['Inbound', 'Negotiating'].includes(deal.stage);
  // Nothing else told us what this email was for: ask what it leaves us waiting on (only before filming starts)
  const waitFor = deal && !cleared && !cutShared && !scriptSent && !invoiced && stageBefore(deal.stage, 'In Production') && !['Inbound', 'Negotiating'].includes(deal.stage) ? await ourAsk(mine, deal) : null;
  if (deal) await patchDeal(deal, (set) => {
    set('Last Our Reply', istStamp(Date.parse(at)));
    if (waitFor) { set('Next Action', `Waiting for ${waitFor}`); set('Next Action Date', in3); }
    if (cleared) set('Next Action', `Sent (${(email.attachments || []).map((a) => a.filename).join(', ').slice(0, 150)})`);
    if (cutShared) { set('Deal Stage', 'Submitted'); set('Follow-ups Sent', 0); set('Next Action', "Waiting for the brand's feedback on the cut"); set('Next Action Date', in3); }
    if (scriptSent) { set('Deal Stage', 'Script Sent'); set('Script Sent Date', atDay); set('Follow-ups Sent', 0); set('Next Action', 'Waiting for the brand to approve the script'); set('Next Action Date', in3); }
    if (invoiced) { set('Deal Stage', 'Invoiced'); set('Invoice Sent Date', atDay); if (!deal.invoiceDue || reopened) set('Invoice Due Date', dueDay); if (billed) set('Invoice Amount', billed); set('Next Action', 'Waiting for payment'); set('Follow-ups Sent', 0); if (email.threadId && email.threadId !== deal.threadId) { set('Thread ID', email.threadId); set('Thread Subject', email.subject); set('Message ID', email.messageId); } }
  }).catch(() => {});
  // A script we hand over (first or revised) means the card waits on the brand: 5- Script Approval, only forward from
  // 2-4. A revised script sent by hand on a deal already at Script Sent left the card on 4- Script Draft for weeks while
  // the brand reviewed it (Tripo 3D x Lindsay, revised script Oct 21, card still at 4 on Nov 13)
  // Our side sending the signed contract back closes it in CONTRACTS (by thread, else by deal)
  try { const T = await import('./contracttrack.js'); if (T.signedCopyIn(email)) await T.markSigned({ threadId: email.threadId, dealId: deal?.id, at, how: 'Signed copy sent back in the brand thread' }); } catch (e) { console.error('contract signed', e.message); }
  let cardMoved = null;
  if (deal && !invoiced && (scriptFile || scriptLink) && deal.linkedVideo) {
    const videoId = (String(deal.linkedVideo).match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
    if (videoId) { const { moveCardFor } = await import('./intake.js'); cardMoved = await moveCardFor({ videoId, title: deal.brand, creator: deal.creator }, 5, [2, 3, 4]); }
    // the card shows the day the script went to the brand (Harsh, Nov 24)
    if (videoId && scriptSent) { const { stampScriptToBrand } = await import('./intake.js'); await stampScriptToBrand(videoId, atDay); }
  }
  if (deal) await rememberEmail(deal, { who: 'us (NOOCAP)', date: email.date || at, subject: email.subject, text: mine + ((email.attachments || []).length ? `\n[attached: ${(email.attachments || []).map((a) => a.filename).join(', ')}]` : '') }).catch((e) => console.error('memory', e.message));
  if (reopened) await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Paid Date': { date: null } } }).catch(() => {});
  if (cleared && !scriptSent && !cutShared) await clearNextDate(deal);
  // Harsh answering an email the PM left unread teaches the fixed replies (lib/replytemplates.js)
  let learned = '';
  try { const R = await import('./replytemplates.js'); learned = await R.learnFromReply({ threadId: email.threadId, ourText: mine, agentLogDs: DS.agentLog }); } catch (e) { console.error('template learning', e.message); }
  await log({ event: `Our reply: ${email.subject || ''}`, outcome: 'Rule', email, deal, details: `thread:${email.threadId} at:${at}${retired.length ? ` · retired ${retired.length} waiting draft(s), you already replied` : ''}${cleared ? ' · pending "send" action marked done' : ''}${invoiced ? ' · invoice sent, deal moved to Invoiced' : ''}${reopened ? ' (deal reopened from Paid for the new videos)' : ''}${stamped.length ? ` · Invoice Sent stamped on ${stamped.map((r) => r.title).join(', ')}` : ''}${scriptSent ? ' · script sent, deal moved to Script Sent' : ''}${cutShared ? ` · cut shared by hand (${cutLink}), deal moved to Submitted` : ''}${cardMoved ? ` · card ${cardMoved}` : ''}${waitFor ? ` · now waiting for ${waitFor}` : ''}${learned ? ` · reply ${learned}` : ''}` });
  return { action: 'recorded', why: 'our reply noted', retired: retired.length };
}

// ---------- contracts go to WhatsApp as the actual file ----------
// A brand sending a contract (a PDF that says contract/agreement, an e-sign link, or "contract attached" with a file)
// lands on Harsh's and Pratham's WhatsApp with the file itself. The PM only passes it on: it never signs or agrees.
const SIGN_LINK = /https?:\/\/[^\s<>"')\]]*(?:docusign\.(?:net|com)|pandadoc\.com|hellosign\.com|dropboxsign\.com|sign\.dropbox\.com|adobesign\.com|echosign\.com|documents\.adobe\.com|signnow\.com|ironcladapp\.com|contractbook\.com|sign\.zoho\.|yousign\.com|signwell\.com|boldsign\.com)[^\s<>"')\]]*/gi;
// A brand's own signing page on its own domain ("agreements.houseofmarketers.com/sign/…", Runway x Chris, Nov 17: Natalie's
// new-campaign contract never reached anyone because only known e-sign services counted). Counted only when the email
// talks about a contract or signing.
const OWN_SIGN_LINK = /https?:\/\/(?:(?:agreements?|contracts?|sign|esign|legal)\.[^\s<>"')\]\/]+|[^\s<>"')\]\/]+\/(?:sign|esign|signature|contract|agreement)s?\/)[^\s<>"')\]]*/gi;
const SIGN_TALK = /\b(sign|signature|countersign)\b[^.\n]{0,40}\b(contracts?|agreements?|documents?)\b|\b(contracts?|agreements?)\b[^.\n]{0,40}\bsign/i;
export function ownSignLinks(text) {
  const t = String(text || '');
  if (!SIGN_TALK.test(t) && !/\b(contracts?|agreements?)\b/i.test(t)) return [];
  return [...new Set((t.match(OWN_SIGN_LINK) || []).map((u) => u.replace(/[.,;:!?)]+$/, '')))].slice(0, 2);
}
const CONTRACT_FILE = /contract|agreement|addendum|\bsow\b|statement.of.work|insertion.order|\bnda\b|\bterms\b/i;
const CONTRACT_TALK = /\b(contracts?|agreements?|addendum|statement of work|SOW|insertion order|docusign|e-?sign(ature)?)\b/i;
// The email calls the attachment a brief, or says the contract is still to come
const BRIEF_NOT_CONTRACT = /\bnot (?:the |a )?(?:final |formal )?(?:contract|agreement)\b|\b(?:will|shall|'ll|going to)\s+(?:then\s+)?(?:share|send|forward|provide|issue|prepare)\s+(?:you\s+|over\s+)?(?:the\s+|a\s+|our\s+)?(?:formal\s+|final\s+|official\s+)?(?:contract|agreement)\b|\b(?:attached|enclosed|attachment|document)\b[^.\n]{0,60}\b(?:is|as)\s+(?:the\s+|our\s+|a\s+)?(?:campaign\s+|creative\s+)?brief\b/i;
// Google Docs / Drive / Dropbox links that ARE the contract (the words "contract" or "agreement" right next to the link)
const DOC_HOST = /https?:\/\/(?:docs\.google\.com\/document\/d\/|drive\.google\.com\/(?:file\/d\/|open\?id=)|www\.dropbox\.com\/|dropbox\.com\/)[^\s<>"')\]]+/gi;
export function contractDocLinks(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(DOC_HOST)) {
    const around = t.slice(Math.max(0, m.index - 160), m.index + m[0].length + 60);
    if (/\b(contracts?|agreements?|addendum|statement of work|SOW|insertion order|terms)\b/i.test(around) && !/\bbrief\b[^\n]{0,25}$/i.test(t.slice(Math.max(0, m.index - 40), m.index))) out.push(m[0].replace(/[.,;:!?)]+$/, ''));
  }
  return [...new Set(out)].slice(0, 2);
}
export function contractIn(email) {
  const docs = (email.attachments || []).filter((a) => (/pdf|msword|wordprocessing/i.test(a.mimeType || '') || /\.(pdf|docx?)$/i.test(a.filename || '')) && !/invoice|\binv[-_ ]?\d|w-?9|receipt/i.test(a.filename || ''));
  const latest = latestText(email.text || '');
  const links = [...new Set([...(`${latest} ${email.html || ''}`.match(SIGN_LINK) || []), ...ownSignLinks(latest)])].slice(0, 2);
  const docLinks = contractDocLinks(`${latest}\n${String(email.html || '').replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, ' $2 $1 ')}`);
  const named = docs.filter((a) => CONTRACT_FILE.test(a.filename || ''));
  // A brief and a contract in one email: the contract is the one named like a contract; the brief stays with the brief
  if (named.length) return { files: named, links, docLinks };
  // A brief whose email only says the agreement comes LATER ("once you confirm the 23rd Nov, I will share the formal
  // agreement", "this is the campaign brief, not the contract") is no contract: Emergent x Chris, Nov 18, the brief PDF
  // was filed as a contract and the auto "thanks for sending the contract, we'll sign it" went to Karan (system check, Nov 19)
  if (CONTRACT_TALK.test(latest) && BRIEF_NOT_CONTRACT.test(latest) && !links.length && !docLinks.length) return null;
  if (CONTRACT_TALK.test(latest) && (docs.length || links.length || docLinks.length)) return { files: docs.filter((a) => !/\bbrief\b/i.test(a.filename || '')), links, docLinks, maybe: docs.length > 0 };
  if (links.length || docLinks.length) return { files: [], links, docLinks };
  // Unnamed PDFs ("Collaboration.pdf") are read (free, no AI) in contractToWhatsApp for contract wording
  if (docs.some((a) => a.data && /pdf/i.test(`${a.mimeType} ${a.filename}`))) return { files: [], links: [], docLinks: [], unnamed: docs.filter((a) => a.data && !/\bbrief\b/i.test(a.filename || '')) };
  return null;
}

// A contract link turned into a PDF the creator can open on WhatsApp. Google Docs export as PDF, Drive and Dropbox files
// download as they are; only links shared as "anyone with the link" can be fetched. null when it can't be fetched.
export async function linkToPdf(url) {
  let get = url, name = 'contract.pdf';
  const gdoc = url.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  const gfile = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/);
  if (gdoc) get = `https://docs.google.com/document/d/${gdoc[1]}/export?format=pdf`;
  else if (gfile) get = `https://drive.google.com/uc?export=download&id=${gfile[1]}`;
  else if (/dropbox\.com/.test(url)) get = url.replace(/([?&])dl=0/, '$1dl=1') + (/[?&]dl=/.test(url) ? '' : (url.includes('?') ? '&' : '?') + 'dl=1');
  try {
    const r = await fetch(get, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!/pdf|msword|wordprocessing|octet-stream/i.test(type)) return null; // a sign-in page, not the file
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 800 || buf.length > 15 * 1024 * 1024) return null;
    const cd = r.headers.get('content-disposition') || '';
    const fn = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1];
    if (fn) name = decodeURIComponent(fn);
    if (!/\.(pdf|docx?)$/i.test(name)) name = name.replace(/\.[^.]*$/, '') + '.pdf';
    return { filename: name, mimeType: /pdf/i.test(type) || gdoc ? 'application/pdf' : type, data: buf.toString('base64') };
  } catch { return null; }
}
// The contract in an email, files resolved: unnamed PDFs kept only when their text reads like a contract, and contract
// links on Google Docs / Drive / Dropbox turned into PDFs where they are shared publicly. null when there is none.
export async function resolveContract(email) {
  const c = contractIn(email);
  if (!c) return null;
  // Unnamed PDFs: a contract only if its text reads like one ("this agreement", "the parties", "in witness whereof")
  if (c.unnamed) {
    const { pdfText } = await import('./pdftext.js');
    const { looksLikeContract } = await import('./contracts.js');
    for (const a of c.unnamed.slice(0, 3)) { const t = await pdfText(a.data, 6000).catch(() => null); if (t && looksLikeContract('', t) && !/\bbrief\b/i.test(t.slice(0, 300))) c.files.push(a); }
    if (!c.files.length) return null;
  }
  // A contract shared as a Google Docs / Drive / Dropbox link comes to WhatsApp as a PDF; if it can't be fetched (not
  // shared publicly), the link itself is sent
  c.openLinks = [];
  for (const u of c.docLinks || []) { const f = await linkToPdf(u); if (f) c.files.push(f); else c.openLinks.push(u); }
  return c;
}

// Is this our own side sending a contract back signed? Only when it comes from us or the creator. A brand's own email is
// never "signed back": Fotor x Duncan (Nov 19) sent its agreement with "Please check that.", the AI tagged it "signed
// contract", and the PDF was skipped as if it were ours (not saved to CONTRACTS, not sent to WhatsApp, no ack)
export const signedBack = (x = {}) => x.from_role === 'noocap' || (x.from_role !== 'brand' && (x.delivers || []).some((d) => /signed/i.test(d)));

// An agreement the brand accepts by an email reply, with no signature ("reply 'Agree with the Influencer Cooperation
// Rules'... a written email reply is sufficient and no need to sign the agreement"), is never answered with "we'll review
// and sign it", and Harsh is not told to sign it: agreeing is his reply to write (KooKo AI x Valeri, Nov 26: the
// contract_ack told Sophia we would sign it and she had to repeat that no signature is needed; system check)
export function agreeByReply(text) {
  const t = String(text || '');
  return /\bno\s+need\s+to\s+sign\b|\bno\s+(?:physical\s+|wet\s+)?signature\s+(?:is\s+)?(?:needed|required|necessary)\b|\b(?:written\s+)?(?:e-?mail\s+)?reply\s+is\s+(?:sufficient|enough)\b|\bwithout\s+(?:a\s+)?sign(?:ing|ature)\b/i.test(t)
    || /\breply\s+(?:with\s+)?["“'‘]\s*(?:i\s+|we\s+)?agree\b/i.test(t);
}

// What makes two contract emails the same contract: the sign link (without tracking bits), else the file names in that thread
export function contractKey(c = {}, email = {}) {
  const link = (c.links || []).map((u) => String(u).toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '')).sort()[0];
  if (link) return link.replace(/^https?:\/\//, '');
  const files = (c.files || []).map((f) => String(f.filename || f.name || '').toLowerCase()).filter(Boolean).sort().join('+');
  return files && email.threadId ? `${email.threadId}:${files}` : '';
}
export async function contractToWhatsApp(email, x, deal) {
  const c = await resolveContract(email);
  if (!c) return '';
  // Every contract is kept in CONTRACTS (with the file) and announced on Discord, whatever happens on WhatsApp: a closed
  // WhatsApp chat meant contracts never reached anyone (CapCut x Lindsay, Panda x Chris, Nov 13)
  let tracked = '';
  if (!signedBack(x)) {
    try { const T = await import('./contracttrack.js'); const r = await T.recordContract({ email, contract: c, deal, brand: deal?.brand || x.brand, creator: deal?.creator || x.creator, inbox: 'noocapcollab' }); if (r?.created) tracked = ' · contract saved to CONTRACTS'; } catch (e) { console.error('record contract', e.message); }
  }
  if (signedBack(x)) return tracked; // our side sending it back signed
  // A copy the brand sends back already signed by both sides is filed (recordContract closes the open row) and nothing
  // else: no "we'll review and sign it" ack to the brand and no "read it and sign it yourself" card for Harsh (rule 75,
  // Emergent x Chris, Nov 22-23: Karan's countersigned agreement came with billing details after the video was live and
  // produced a sign-it-yourself contract card next to the invoice ask)
  try { const T = await import('./contracttrack.js'); if (T.isFullySigned(latestText(email.text || ''), c.files)) return tracked + ' · fully signed copy filed, nothing to sign'; } catch (e) { console.error('fully signed check', e.message); }
  // The brand hears back the same minute that we have the contract (Harsh, Nov 17: Anita's PandaDoc and Natalie's
  // Runway contract both sat with no reply). Fixed text, no date promised; signing stays with Harsh and the creator.
  const byReply = agreeByReply(latestText(email.text || ''));
  if (byReply) tracked += ' · agreed by email reply, no signing: no contract_ack';
  if (deal && x.from_role === 'brand' && !byReply && !(email.date && (Date.now() - Date.parse(email.date)) / 36e5 > 36)) {
    try { tracked += ` · ${await templateReply(email, deal, { ...x, template: 'contract_ack' })}`; } catch (e) { tracked += ` · contract ack failed: ${String(e.message).slice(0, 80)}`; }
  }
  if (email.date && (Date.now() - Date.parse(email.date)) / 36e5 > 36) return tracked; // catch-up of old mail
  return tracked + (await contractWhatsApp({ email, c, who: `${deal?.brand || x.brand || 'A brand'}${deal?.creator || x.creator ? ' × ' + (deal?.creator || x.creator) : ''}`, gist: (x.summary || [])[0], byReply }));
}

// Send a contract to the NOOCAP MEDIA WhatsApp group, once. Used by noocapcollab and by the creators' own inboxes
// (Noxinfluencer x Chris, Nov 20: a contract in Chris's inbox reached Discord but never WhatsApp).
// One WhatsApp per contract, ever: the same Runway agreement reached the group twice 3 minutes apart (two emails
// carrying one sign link), and Harsh forwarded the second copy to Chris again (Nov 20). The claim is race-safe across
// PM copies and keyed on the sign link, or on the files and the thread when there is no link.
export async function contractWhatsApp({ email, c, who, gist, byReply = false }) {
  const key = contractKey(c, email);
  if (key) {
    const { claimOnce } = await import('./briefs.js');
    if (!(await claimOnce(`Contract sent to WhatsApp · ${key}`.slice(0, 200), 24 * 60).catch(() => true))) return ' · contract already sent to WhatsApp, not sent again';
  }
  const W = await import('./whatsapp.js');
  const from = String(email.from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || email.from || '';
  const text = [
    `📄 *Contract: ${who}*`,
    from ? `From ${from}${email.subject ? ` · "${email.subject}"` : ''}` : null,
    gist ? `• ${gist}` : null,
    ...c.links.map((u) => `Sign link: ${u}`),
    ...(c.openLinks || []).map((u) => `Contract link (could not turn it into a PDF, it may not be shared publicly): ${u}`),
    byReply ? `No signature needed: the brand only wants a written reply agreeing to it. Please read it${c.files.length ? ' below' : ''}; the PM never agrees to contract terms, so that reply is yours.`
      : c.files.length ? `The ${c.files.length > 1 ? 'files are' : 'file is'} below, so please read it and sign it yourself because the PM never signs or agrees to contract terms.` : 'Please read it and sign it yourself because the PM never signs or agrees to contract terms.',
  ].filter(Boolean).join('\n');
  const r = await W.sendContract({ text, files: c.files });
  return ` · contract to WhatsApp (${r.sent} sent${r.queued ? `, ${r.queued} waiting for the chat to open` : ''}${r.docs ? `, ${r.docs} file${r.docs > 1 ? 's' : ''}` : ''})`;
}

// The fixed rules applied to the AI's reading of an email before anything acts on it. Exported so the daily test
// bank (lib/evals.js) judges exactly what the inbox does.
// A brand hold reaches the script writer only when a video card exists for the deal (he has a brief to stop working on)
// Invoiced and Paid only ever come from the money itself: our invoice actually going out (Approvals / Stripe) or real
// payment (Stripe paid, a receipt). An email that only talks about an invoice ("share your details so we can issue the
// invoice") never moves a deal there (Topview × Chris sat at Invoiced for 47 days with no invoice ever raised, Nov 4).
export const MONEY_STAGES = ['Invoiced', 'Paid'];
export const aiStage = (stage) => (stage && !MONEY_STAGES.includes(stage) ? stage : null);

// The brand says it is still waiting for something ("hope to receive the script soon", "we haven't received the
// invoice", "still waiting for the video"): which thing, or null
export function stillWaitingFor(text) {
  const t = String(text || '').toLowerCase();
  const m = t.match(/\b(?:hope to receive|looking forward to receiving|still waiting (?:for|on)|waiting for|haven'?t (?:yet )?received|have not (?:yet )?received|did ?n[o']t receive|didn'?t get|not received|when (?:can|will) (?:we|i) (?:receive|get|expect))\b[^.?!\n]{0,30}?\b(script|video|cut|draft|invoice|links?|brief)\b/);
  return m ? (m[1] === 'cut' || m[1] === 'draft' ? 'video' : m[1].replace(/s$/, '')) : null;
}

export const holdPingsWriter = (deal = {}) => !!String(deal.linkedVideo || '').trim();

// "You can now move forward with the video draft", "feel free to start filming", "keep this in mind when creating the
// video": the script is approved, whatever notes come with it. Notes "to apply before filming" are still script changes.
export function goAheadToVideo(text) {
  const t = String(text || '');
  const go = /\b(?:move|go|going|moving)\s+(?:forward|ahead)\s+with\s+(?:the\s+)?(?:video|draft|filming|shoot|production|recording)|\b(?:start|begin|proceed(?:\s+(?:with|to))?)\s+(?:working\s+on\s+|on\s+)?(?:the\s+)?(?:video|filming|shoot(?:ing)?|production|recording|draft\s+video)|\bkeep\b[^.\n]{0,40}\bin\s+mind\s+when\s+(?:creating|filming|making|editing|recording|shooting)|\b(?:good|ready|clear)\s+to\s+(?:go|film|shoot|record)\b|\bproceed\s+to\s+film/i.test(t);
  if (!go) return false;
  // A brand describing the process still to come is not a go-ahead: "you will submit the script for review and start
  // video production upon our approval" (Dreamina x Chris BD-77, Nov 12) and a step-by-step guide with "4. Script
  // Approval: send us the script for review. 5. Filming: proceed according to the approved script" (AI Inspo x Duncan,
  // Nov 12) were both read as script approved and drafted tool-access emails before any script was sent.
  if (/\b(?:upon|once|after|pending)\s+(?:our|the|your|their|brand'?s?|client'?s?)?\s*(?:final\s+)?(?:script\s+)?(?:approval|review|sign-?off)\b|\b(?:send|submit|share)\s+(?:us\s+|over\s+)?(?:the\s+|your\s+|a\s+)?script\s+(?:to\s+us\s+)?for\s+(?:our\s+)?(?:review|approval)|\baccording\s+to\s+the\s+approved\s+script|\bscript\s+approval\s*[:\n]/i.test(t)) return false;
  return !/\b(?:once|after)\s+(?:you(?:'ve|\s+have)?\s+)?(?:appl|address|updat|revis|mak|fix|incorporat)\w*\s+(?:the\s+|these\s+|our\s+|those\s+)?(?:comments|changes|edits|notes|feedback)/i.test(t);
}

// The email lays out a process with script approval as a future step and never says a script IS approved
export function describesProcessOnly(text) {
  const t = String(text || '');
  const future = /\b(?:upon|once|after|pending)\s+(?:our|the|your|their|brand'?s?|client'?s?)?\s*(?:final\s+)?(?:script\s+)?(?:approval|review|sign-?off)\b|\b(?:send|submit|share)\s+(?:us\s+|over\s+)?(?:the\s+|your\s+|a\s+)?script\s+(?:to\s+us\s+)?for\s+(?:our\s+)?(?:review|approval)|\bscript\s+approval\s*[:\n]|\b\d\.\s*script\s+approval\b/i.test(t);
  if (!future) return false;
  const approved = /\b(?:script|it|this|everything)\s+(?:is|has\s+been|was|looks)\s+(?:now\s+)?(?:approved|good|great|perfect)\b|\bwe\s+(?:have\s+)?approved?\s+(?:the|your)\s+script\b|\bscript\s+approved\b(?!\s+(?:and|by))|\b(?:good|ready|clear)\s+to\s+(?:go|film)\b/i.test(t);
  return !approved;
}

// "Sounds good! We'll review the script as soon as possible": a promise to review, so the next move is still the
// brand's. Never an approval unless the same email also approves (bug hunter Nov 24: test bank fotor-will-review-script-
// nov20 was read as script_approved twice, which would put the card at To Film and send a tool-access email). Pure.
// The brand sends its own rewritten version of our script (not notes on it). Pure. System check Nov 24.
export function brandRewroteScript(text) {
  const t = String(text || '');
  const rewrote = /\b(?:we|i)(?:'ve|\s+have)\s+(?:made|done)\s+(?:a\s+few\s+|some\s+|several\s+|a\s+couple\s+of\s+|minor\s+|small\s+|slight\s+)?(?:adjustments|changes|edits|tweaks|revisions|updates)\s+(?:to|on|in)\s+(?:[A-Z][\w-]*'s\s+|the\s+|your\s+|our\s+)?script\b/i.test(t)
    || /\b(?:we|i)(?:'ve|\s+have)\s+(?:re-?written|rewritten|adjusted|edited|revised|updated)\s+(?:[A-Z][\w-]*'s\s+|the\s+|your\s+)?script\b/i.test(t);
  const theirVersion = /\b(?:our|the)\s+(?:revised|updated|adjusted|edited|new|final)\s+(?:version|script)\b[^.\n]{0,40}\b(?:below|attached|here)\b|\b(?:revised|updated|adjusted|edited)\s+version\s+(?:below|attached)\b|\battached\s+(?:our|the)\s+(?:revised|updated|adjusted|edited)\s+(?:version|script)\b/i.test(t);
  const asksUsToRewrite = /\bplease\s+(?:revise|rework|rewrite|update|adjust)\b|\bsend\s+(?:us\s+)?(?:a|the)\s+revised\s+script\b/i.test(t);
  return rewrote && theirVersion && !asksUsToRewrite;
}

// "I've attached the creative brief ... let me know when you'd be able to share the first script": the brand hands us a
// brief and asks for the script, so it is a brief whatever the reader says (bug hunter Nov 24: test bank speakon-second-
// reel was read as brand_reply twice after cb1c858, so reel 2's brief would never reach its card or the writer). A brief
// promised for later, or a rate question (rule 46), is not one. Pure.
export function sharesBriefForScript(text) {
  const t = String(text || '');
  const B = String.raw`(?:creative\s+|campaign\s+|content\s+|video\s+|reel\s+|full\s+)?brief`;
  const shares = new RegExp(String.raw`\b(?:i|we)(?:'ve|\s+have)\s+(?:attached|shared|included|linked|added)\s+(?:the|our|a|my)\s+${B}\b|\b(?:attached|here)\s+is\s+(?:the|our|a)\s+${B}\b|\bhere'?s\s+(?:the|our|a)\s+${B}\b|\bfind\s+(?:the|our|a)\s+${B}\s+(?:attached|below|here)\b|\b${B}\s+(?:is\s+)?(?:attached|below)\b`, 'i').test(t);
  const asksScript = /\bscript\b/i.test(t);
  return shares && asksScript && !ASKS_RATE.test(t);
}

// "Our campaign brief may be updated ... We'll send you the final brief well before production. In the meantime, you're
// welcome to look through our current Black Friday campaign's creator brief for an overview" (Renoise x Chris, Nov 25):
// another campaign's brief shared for reference while the real one is still to come is not the brief. No card for the
// script writer, no script sent from it (system check Nov 26 morning: the deal went to Brief Received, the card to
// 4- Script Draft and Rudraksh was asked for a script from the Black Friday brief). Pure.
export function referenceBriefOnly(text) {
  const t = String(text || '');
  const later = /\b(?:send|share)\s+(?:you\s+|over\s+)?(?:the|our)\s+(?:final|full|actual|official|real)\s+(?:campaign\s+)?brief\b|\b(?:final|full|actual)\s+(?:campaign\s+)?brief\b[^.\n]{0,80}\b(?:later|before\s+production|soon|closer\s+to|once\s+(?:it'?s|it\s+is)\s+(?:ready|final))|\bbrief\s+(?:may|might|will)\s+(?:be|change|get)\s+(?:updated|changed|revised|finali[sz]ed)\b/i.test(t);
  const reference = /\bfor\s+(?:an?\s+)?(?:overview|reference|context|inspiration)\b|\bin\s+the\s+meantime\b|\bto\s+get\s+(?:familiar|a\s+feel)\b|\bget\s+familiar\s+with\b/i.test(t);
  return later && reference;
}

export function reviewPromiseOnly(text) {
  const t = String(text || '');
  const promise = /\b(?:we'?ll|we\s+will|i'?ll|i\s+will|(?:the\s+)?(?:team|client|brand)\s+will|(?:we'?re|we\s+are|i'?m|i\s+am)\s+going\s+to|will)\s+(?:now\s+|quickly\s+|soon\s+|internally\s+)?(?:review|look\s+(?:at|over|into|through)|take\s+a\s+(?:quick\s+)?look|go\s+(?:over|through)|check)\b/i.test(t);
  if (!promise) return false;
  const approved = /\bapproved?\b(?!\s+(?:once|after|when|upon))|\blooks?\s+(?:good|great|perfect)\b|\b(?:good|ready|clear)\s+to\s+(?:go|film)\b|\bgo\s+ahead\b|\b(?:move|moving)\s+forward\b|\bproceed\b|\bstart\s+filming\b/i.test(t);
  return !approved;
}

// A platform's "submit it in the app" or "there is no asset" notice (Faved, creator.co) is not change notes on the cut
// (rule 79): the row stays where it is and Harsh is told once to submit on the platform. Weglot x Lindsay (Faved), Nov 23:
// two such notices were read as video_feedback, put the row on Changes and pinged Prateek with CHANGES REQUESTED, then
// Faved approved the video for Nov 30. Returns the notice sentence, or '' when the email also asks for real changes.
export function platformSubmitNotice(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const where = /\bfaved\b|creator\.co\b|\bplatform\b|\bin\s+the\s+app\b|\bcampaign\s+page\b|\bdashboard\b|\bportal\b/i;
  if (!where.test(t)) return '';
  if (/\bapprov(?:ed|al)\b(?!\s+(?:once|after|when|upon))/i.test(t)) return '';
  const change = /\b(?:chang(?:e|es|ing)|adjust\w*|fix\w*|remov\w*|replac\w*|shorten\w*|trim\w*|swap\w*|re-?edit\w*|re-?record\w*|re-?shoot\w*|music|voice\s*-?over|subtitles?|captions?|fonts?|colou?rs?|logo|cta|hook|intro|outro|feedback\s+on\s+the\s+(?:video|cut|draft)|revis(?:e|ion)\w*)\b|\b\d{1,2}:\d{2}\b/i;
  const sentences = t.split(/(?<=[.?!])\s+/);
  const notice = /\b(?:there\s+(?:is|was|were)\s+no|no)\s+(?:assets?|files?|video|attachments?|link)\b|\b(?:submit|upload|share|add)\w*\b[^.?!]{0,80}\b(?:through|via|in|on|using|to)\s+(?:the\s+|your\s+)?(?:faved|creator\.co|app|platform|campaign\s+page|dashboard|portal)\b/i;
  let hit = '';
  for (const s of sentences) {
    if (notice.test(s)) { if (!hit) hit = s.trim(); continue; }
    if (change.test(s)) return '';
  }
  return hit.slice(0, 240);
}

// The brand is waiting on OUR confirmation of a date or plan ("Once you confirm the intent to go live on 23rd Nov, I
// will share the formal agreement", "Please confirm the go-live date", "can you confirm Chris is available on the 3rd?").
// Only Harsh can give that (rule 70: the brand's real ask, usually a go-live date, goes to him). Bug hunter Nov 25:
// test bank emergent-chris-brief-not-contract-nov19 failed twice at 00:47 UTC with the reader saying brief and no
// needs_our_info, so the go-live confirmation Karan asked for would never reach Harsh. Returns the sentence or ''.
export function awaitsOurConfirmation(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const sentences = t.split(/(?<=[.?!])\s+/);
  const thing = /\b(?:go(?:ing)?[\s-]*live|live\s+date|post(?:ing)?\s+date|publish(?:ing)?|date|day|timeline|deadline|schedule|intent|availab|slot|deliver)/i;
  for (const s of sentences) {
    const once = /\b(?:once|when|as\s+soon\s+as|after)\s+you(?:'ve|\s+have)?\s+confirm(?:ed)?\b/i.test(s);
    const ask = /\b(?:please|kindly|could\s+you|can\s+you|would\s+you|pls|need\s+you\s+to|let\s+(?:me|us)\s+know\s+(?:if|whether)\s+you\s+can)\s+(?:also\s+)?confirm\b/i.test(s);
    if ((once || ask) && thing.test(s) && !/\bconfirm(?:ed)?\s+receipt\b/i.test(s)) return s.trim().slice(0, 240);
  }
  return '';
}

// The brand lifts a posting hold: "you can go ahead and publish", "Huedini is live, feel free to post", "good to post on
// the 13th". Only read on a deal that has a posting hold.
export function postingCleared(text) {
  const t = String(text || '');
  if (postingOnlyHold(t)) return false;
  return /\b(?:go\s+ahead\s+(?:and\s+)?(?:post|publish|go\s+live)|(?:you\s+can|feel\s+free\s+to|ok(?:ay)?\s+to|good\s+to|free\s+to|cleared\s+to|ready\s+to)\s+(?:post|publish|go\s+live|launch)|(?:cleared|approved)\s+for\s+(?:posting|publishing|publication|go-?live)|(?:launch|feature|product|it)\s+(?:is|has)\s+(?:now\s+)?(?:live|launched|out)|has\s+(?:officially\s+)?launched|please\s+(?:post|publish)\b|post\s+(?:it\s+)?(?:on|today|tomorrow|this))/i.test(t);
}

// "Please don't publish the video without checking with me first", "the launch may be delayed": only the POSTING waits.
// The script writer and the editors keep working (ElevenLabs × Duncan, Nov 7: this became "On hold" for Rudraksh).
export function postingOnlyHold(text) {
  const t = String(text || '');
  const post = /\b(?:don'?t|do\s+not|not\s+to|please\s+hold\s+off(?:\s+on)?|hold\s+off(?:\s+on)?|wait\s+(?:to|before))\s+(?:publish|post|go(?:ing)?\s+live|launch)|\b(?:posting|publishing|go-?live|launch)\s+(?:date\s+)?(?:may|might|could|will)\s+(?:be\s+)?(?:slightly\s+)?(?:delayed|move|change|slip|shift)|\b(?:launch|posting\s+date)\b[^.\n]{0,60}\bdelayed\b/i.test(t);
  const work = /\b(?:pause|hold|stop|don'?t\s+(?:start|continue|proceed\s+with))\s+(?:the\s+|all\s+)?(?:script(?:ing)?|work|filming|production|editing|recording|shoot)/i.test(t);
  return post && !work;
}

// Notes on a CUT (the brand thanks us for "the cuts", names a video by timestamp "0:12") are video feedback for the
// editor, never script changes for the writer, when the email never mentions a script. The reader called the ZenBusiness
// UGC notes script_changes in the test bank on Nov 14 (case zenbusiness-ugc-notes, after 51fd8a7 which did not touch the
// reader), so this no longer depends on the model's mood (system check, Nov 14).
// Feedback that only asks for hashtags (the post caption), with nothing about the cut itself (Dreamina x Chris, Nov 18)
export function hashtagOnly(text) {
  const t = String(text || '');
  if (!/#[A-Za-z]\w+|\bhashtags?\b/i.test(t)) return false;
  return !/\b(cut|scene|seconds?|sec|0:\d\d|\d+s\b|watermark|logo|audio|music|voice|b-?roll|screen|clip|subtitles?|on-?screen|text on|frame|trim|hook|intro|outro|footage|edit(?!ing the caption)|render|cover|thumbnail)\b/i.test(t.replace(/#\w+/g, ''));
}

// Deal stages where only a script (never a cut) can have reached the brand
export function scriptOnlyStage(stage) {
  return ['Script Sent', 'Brief Received', 'Signed', 'Price Agreed'].includes(String(stage || ''));
}

// The reader's video_feedback on notes the brand sent while only a script can have reached them (AI Inspo x Duncan,
// Nov 23). handleInboxEmail still checks the edit rows for a cut before switching; the test bank uses the same test so
// it scores what production does (keep the two in step). Pure.
export function scriptNotesNotCut(x, stage) {
  return x?.from_role === 'brand' && x?.event === 'video_feedback' && scriptOnlyStage(stage) && String(x?.feedback || '').trim().length > 10;
}

export function notesOnCut(text) {
  const t = String(text || '');
  if (/\bscripts?\b/i.test(t)) return false;
  return /\b(?:the|your|this|these|first|second|final|rough|revised)\s+(?:cuts?|edits?|videos?)\b|\bcuts\b|\bdraft\s+videos?\b|\bvideo\s+drafts?\b/i.test(t) || /\b\d{1,2}:\d{2}s?\b/.test(t);
}

// "Your video has passed the review, please publish it": the brand approved an edited video. On a deal with several
// videos the same email often also carries notes on the next scripts (CapCut x Chris, Nov 16-17), and the reader then
// picked script_approved / script_changes, so the approved video sat at With Brand and its card went back to scripting.
export function videoApprovalIn(text) {
  // A future approval ("once the video is approved we'll pay") is not one: those clauses are left out
  const t = String(text || '').replace(/\b(?:once|after|when|until|before|if)\b[^.\n]{0,80}/gi, ' ');
  return /\b(?:video|cut|draft|edit)\s+(?:has\s+|have\s+)?(?:passed|cleared)\s+(?:the\s+|our\s+)?(?:review|approval)/i.test(t)
    || /\b(?:video|cut|draft)\s+(?:is|has\s+been|was)\s+approved\b/i.test(t)
    // "The video looks good now and is approved", "everything is approved on our side" (Dreamina x Chris, Nov 16) but
    // never a future one ("once the video is approved")
    || (/\b(?:video|cut|draft|edit)\b[^.\n]{0,40}\bapproved\b/i.test(t) && !/\b(?:once|after|when|until|before|if)\b[^.\n]{0,20}\b(?:video|cut|draft|edit)\b[^.\n]{0,40}\bapproved\b/i.test(t) && !/\bscripts?\b[^.\n]{0,40}\bapproved\b/i.test(t))
    || (/\beverything is approved\b/i.test(t) && !/\bscripts?\b/i.test(t))
    || /\bapproved?\s+(?:the|your)\s+(?:video|cut|draft)\b/i.test(t)
    || /\bplease\s+(?:publish|post)\s+it\b/i.test(t)
    || /\bgo\s+ahead\s+and\s+(?:publish|post)\b/i.test(t);
}

// The safety net after every brand email (Harsh, Nov 17: the PM misses a lot of things). The reader files ONE event per
// email, so a second ask in the same email (a video approval next to script notes, an ad code request, a billing
// question) could fall through with nobody told. This free check reads the brand's latest message for the asks we know
// and returns each one the PM did nothing about, so Harsh hears about it the same minute.
const ASKS = [
  { what: 'approved a video or asked us to publish', re: (t) => videoApprovalIn(t), done: /video approved|To Post|Deal Approved/i, events: ['video_feedback'] },
  { what: 'sent notes on a script', re: (t) => /\b(?:revision|revise|notes?|feedback|changes?)\b[^.\n]{0,60}\bscripts?\b|\bscripts?\b[^.\n]{0,60}\b(?:revis\w*|chang\w*|notes?|feedback)\b/i.test(t), done: /script changes|script approved|Rudraksh|No new script changes/i, events: ['script_changes', 'script_approved'] },
  { what: 'sent changes on a video', re: (t) => /\b(?:changes?|revis\w+|fix|adjust\w*)\b[^.\n]{0,50}\b(?:video|cut|draft)\b/i.test(t) && !/\bscripts?\b/i.test(t) && !videoApprovalIn(t), done: /changes sent|Video Intake|Changes/i, events: ['video_feedback'] },
  { what: 'sent a new or updated brief', re: (t) => /\b(?:new|updated|another|second|third)\s+brief\b|\bbrief\s+(?:has been|was|is)\s+updated\b/i.test(t), done: /brief|script changes|Rudraksh/i, events: ['brief', 'script_changes'] },
  { what: 'asked for the ad code', re: (t) => /\b(?:ad ?code|spark ?code|partnership code|boost code)\b/i.test(t), done: /ad ?code|To Post|video approved|Deal Approved/i, events: ['video_feedback'] },
  { what: 'asked about billing, an invoice or payment details', re: (t) => /\b(?:invoice|billing (?:details|info)|bank details|payment details|w-?9|w-?8)\b/i.test(t), done: /invoice|billing|bank|unread/i, events: ['invoice_from_creator', 'payment_confirmed'] },
];
export function missedAsks(text, x, did) {
  const t = String(text || '');
  if (!t.trim() || x?.from_role === 'noocap' || x?.from_role === 'creator') return [];
  return ASKS.filter((a) => a.re(t) && !a.events.includes(x?.event) && !a.done.test(String(did || ''))).map((a) => a.what);
}

export function applyTextGuards(x, email) {
  if (x.event === 'script_changes' && notesOnCut(latestText(email?.text || ''))) x.event = 'video_feedback';
  // A brand describing the steps still to come ("4. Script Approval: please send us the script for review. 5. Filming:
  // proceed according to the approved script") is never an approval, even when the reader says script_approved: the
  // reader kept doing it after the lesson (test bank case ai-inspo-process-guide-not-approval, system check Nov 13)
  if (x.event === 'script_approved' && describesProcessOnly(latestText(email?.text || ''))) { x.event = 'brand_reply'; x.needs_reply = true; }
  // "Okay, got it. Hope to receive the script soon" after we already sent it: the brand hasn't seen what we sent, so
  // this is never a no-reply update. It needs an answer that sends the thing again (Hyper3D × Lindsay, Nov 3).
  { const w = stillWaitingFor(latestText(email?.text || '')); if (w) { x.needs_reply = true; x.still_waiting_for = w; x.we_owe = x.we_owe || `Send the ${w} again: the brand says they are still waiting for it`; } }
  // "Looks great, a couple of notes for filming and editing": the script is approved, the notes go to whoever films and edits
  if (x.event === 'script_changes' && String(x.filming_notes || '').trim() && !String(x.feedback || '').trim()) x.event = 'script_approved';
  // "Looks great, no major issues, just one small note…" on a video: any requested change wins over the approval,
  // or the editor renders the CTAs on a cut the brand still wants changed. The approval is remembered so the
  // editor and the deal know only this tweak is left.
  if (x.event === 'video_feedback' && String(x.feedback || '').trim().length > 10) { x.approved_after_changes = !!x.video_approved; x.video_approved = false; }
  // A brand handing over a brief and asking for the script is a brief, even when the reader calls it a brand_reply
  if (x.event === 'brand_reply' && x.from_role !== 'creator' && x.from_role !== 'noocap' && sharesBriefForScript(latestText(email?.text || ''))) x.event = 'brief';
  // Another campaign's brief shared only for an overview while the final brief is still to come is not the brief (Renoise x Chris, Nov 25)
  if (x.event === 'brief' && x.from_role !== 'creator' && x.from_role !== 'noocap' && referenceBriefOnly(latestText(email?.text || ''))) { x.event = 'brand_reply'; x.reference_brief = true; }
  // Notes on a script we sent win over a brief link in the same email: the script writer must hear about them
  if (x.event === 'brief' && String(x.feedback || '').trim().length > 20) x.event = 'script_changes';
  // "Approved Idea, Script & Live Date… here is the validated version", next step "Draft video": the brand approved
  // the script (with their final wording). It is never a brief update or script changes for the writer (Weglot, Nov 3)
  if (['brief', 'script_changes'].includes(x.event) && isApprovedWithEdits(latestText(email.text || ''))) {
    x.event = 'script_approved';
    if (!x.approved_script) x.approved_script = String(x.brief_text || x.feedback || '').trim() || null;
  }
  if (x.event === 'brand_reply' && x.from_role === 'brand' && isPaymentClaimed(latestText(email.text || ''))) x.event = 'payment_confirmed';
  if (x.event === 'payment_confirmed' && isPaymentScheduled(latestText(email.text || ''))) { x.event = 'brand_reply'; x.needs_reply = false; if (x.deal_stage === 'Paid') x.deal_stage = null; }
  // "One small note in the doc, keep it in mind when creating the video draft. You can now move forward": approved,
  // and the note is for filming and editing, never a script revision for the writer (ElevenLabs × Duncan, Nov 7)
  { const latest = latestText(email?.text || '');
    if (['script_changes', 'brand_reply', 'brief'].includes(x.event) && x.from_role !== 'creator' && goAheadToVideo(latest) && /\bscript/i.test(latest) && /\b(?:review|approv|look(?:s|ed)?\s+(?:good|great)|good\s+to\s+go|move\s+forward|proceed)/i.test(latest)) {
      x.event = 'script_approved';
      x.filming_notes = [String(x.filming_notes || '').trim(), String(x.feedback || '').trim()].filter(Boolean).join('\n') || null;
      x.feedback = null;
    }
    // A "don't publish yet" is a posting hold: the work carries on and nobody is told to stop
    if (postingOnlyHold(latest)) { if (x.on_hold) x.posting_hold = x.posting_hold || x.hold_reason || 'the brand\'s go-ahead before posting'; x.on_hold = false; }
    // The model sometimes writes the word "null" instead of null (Manyfast x Duncan, Nov 17: a billing email set a posting hold "null")
    if (x.posting_hold && !String(x.posting_hold).replace(/^(null|none|n\/a|no)$/i, '').trim()) x.posting_hold = null;
    if (!x.posting_hold && postingCleared(latest)) x.posting_cleared = true;
    // Last word on process guides: the go-ahead and approved-with-edits guards above turned a brief or script_changes
    // read of AI Inspo's step-by-step guide ("5. Filming: proceed according to the approved script") back into
    // script_approved after the early guard had run (test bank ai-inspo-process-guide-not-approval, still broken all of
    // Nov 14; system check night Nov 14). Steps still to come are never an approval, whichever guard said so.
    if (x.event === 'script_approved' && describesProcessOnly(latest)) { x.event = 'brand_reply'; x.needs_reply = true; x.filming_notes = x.filming_notes || null; }
    if (x.event === 'script_approved' && reviewPromiseOnly(latest)) x.event = 'brand_reply';
    // A brand waiting on our confirmation of a date or plan needs Harsh, whatever event the reader picked
    if (x.from_role !== 'creator' && x.from_role !== 'noocap' && !x.needs_our_info) {
      const c = awaitsOurConfirmation(latest);
      if (c) { x.needs_our_info = true; x.needs_reply = true; x.info_needed = x.info_needed || `the confirmation the brand is waiting for: "${c}"`; }
    }
    // The brand rewrote our script itself and asks whether it works for the creator ("We've made a few adjustments to
    // Chris's script, the revised version below"; "we've attached our revised version, let us know if the script works
    // for Duncan"). That is not notes for Rudraksh and never a "revised script in 2 to 3 working days" ack: their version
    // IS the revised script, and the next move is our yes on it, which is Harsh's call (system check Nov 24 afternoon,
    // Fotor x Chris BD-79 and Fotor x Duncan BD-89: both went to Rudraksh and Marina was promised a new script).
    if (['script_changes', 'brief'].includes(x.event) && x.from_role !== 'creator' && x.from_role !== 'noocap' && brandRewroteScript(latest)) {
      x.event = 'brand_reply'; x.needs_reply = true; x.needs_our_info = true; x.template = null;
      x.brand_script_version = String(x.feedback || x.brief_text || '').trim() || null; x.feedback = null;
      x.info_needed = "confirmation whether the creator is happy to film the brand's own revised script as written (they rewrote it themselves)";
      x.we_owe = x.info_needed;
    }
    // A video approval is never lost to another event in the same email: with no script in it, it IS the event; with
    // script notes alongside, the script event stays and the video is approved as well (CapCut x Chris, Nov 16-17)
    if (x.event !== 'video_feedback' && x.from_role !== 'noocap' && x.from_role !== 'creator' && videoApprovalIn(latest)) {
      if (['script_approved', 'brand_reply'].includes(x.event) && !/\bscripts?\b/i.test(latest)) { x.event = 'video_feedback'; x.video_approved = true; x.feedback = null; x.filming_notes = null; }
      else x.also_video_approved = true;
    }
    // Rule 79: a platform's submission notice is never change notes, so no Changes row and no editor ping; Harsh submits
    if (x.event === 'video_feedback' && !x.video_approved && x.from_role !== 'creator' && x.from_role !== 'noocap') {
      const n = platformSubmitNotice(latest);
      if (n) {
        x.event = 'brand_reply'; x.feedback = null; x.template = null; x.needs_reply = false;
        x.platform_submit = true; x.needs_our_info = true;
        x.info_needed = `submit the cut on the brand's platform yourself (its notice: "${n}")`;
        x.we_owe = x.we_owe || x.info_needed;
      }
    }
  }
  return x;
}

// A held email is still a brand email: the readers may disagree on WHAT it means, never on WHO wrote last. Without
// these stamps the deal kept its old Last Brand Reply, so the follow-up timer ran on: Upfluence x Duncan approved the
// first draft on Nov 12 (readers disagreed, email held) and 10 hours later the PM auto-sent "have you had a chance to
// look over the first draft?" counted from Oct 8 (system check, Nov 13)
export function heldBrandStamps(email, x) {
  if (x?.from_role !== 'brand') return [];
  const out = [['Last Brand Reply', istStamp(emailTime(email))], ['Follow-ups Sent', 0]];
  if (email?.messageId) out.push(['Message ID', email.messageId]);
  return out;
}

// A held loop-in or agreed deal with no deal row for its thread: open one (flagged Needs you) so it isn't lost
export const heldNeedsDeal = (email, x, deal) => !!x?.brand && !(deal?.threadId && deal.threadId === email?.threadId)
  && (isHandover(email, x) || (x.from_role === 'brand' && ['Price Agreed', 'Signed', 'Brief Received'].includes(x.deal_stage)));
async function openHeldDeal({ email, x, deal, reason }) {
  if (!heldNeedsDeal(email, x, deal)) return null;
  const creator = creatorFromAddresses(email) || x.creator;
  const board = BOARDS.find((b) => b.creator === creator);
  if (!board) return null;
  const made = await createDealFor({ ...x, creator, deal_stage: isHandover(email, x) ? 'Price Agreed' : x.deal_stage, confidence: 'low' }, email, board);
  if (made.reused) return null;
  await patchDeal(made, (set) => { set('Needs Check', true); if (isHandover(email, x)) set('Deal Stage', 'Price Agreed'); set('Next Action', `Needs you: new ${made.brand || x.brand} deal from ${creator}'s team. The two readers disagreed (${reason}), so nothing was sent; reply to the brand yourself.`.slice(0, 1900)); }).catch(() => {});
  return { ...made, creator, brand: made.brand || x.brand };
}

export function oldTrackedEmail(email, deals = [], now = Date.now()) {
  const t = emailTime(email);
  if (!Number.isFinite(t) || (now - t) / 36e5 <= 36 || !email?.threadId) return null;
  return deals.find((d) => d.threadId && d.threadId === email.threadId) || null;
}

// Second reader (lib/verify.js): checks the first reader's decision before the PM acts. In shadow mode it only logs;
// switched on, a disagreement holds the email and asks Harsh instead of acting on a guess.
async function secondReadGate({ email, x, deal, who, usage, cost }) {
  try {
    const V = await import('./verify.js');
    const mode = V.MODE();
    if (mode === 'off' || !V.needsSecondRead(x)) return null;
    if (mode === 'team' && !V.pingsTeam(x)) return null;
    const convo = deal?.id ? await (await import('./memory.js')).readTranscript(deal.id, 12000).catch(() => '') : '';
    const v = await V.secondRead({ email, x, deal: deal || {}, convo, latest: latestText(email.text || '') });
    const bad = (!v.agree || v.wrongDeal) && !V.labelOnlyApproval(x, v) && !V.peripheralOnly(x, v);
    await log({ event: `Second read ${bad ? 'DISAGREES' : 'agrees'}${mode === 'shadow' ? ' (shadow)' : ''}: ${who || x.brand || email.subject || ''}`.slice(0, 118), outcome: bad ? 'Needs approval' : 'Rule', email, x, deal, details: `Reader 1: ${x.event}${x.deal_stage ? ' / stage ' + x.deal_stage : ''}\nReader 2: ${v.rightEvent}${v.wrongDeal ? ' (wrong deal)' : ''}: ${v.reason}${v.note ? '\nNote: ' + v.note : ''}`, usage, cost: (cost || 0) + v.cost, creator: deal?.creator }).catch(() => {});
    if (!bad || (mode !== 'on' && mode !== 'team')) return null;
    if (deal?.id) await patchDeal(deal, (set) => { set('Next Action', `Needs you: check ${deal.brand}'s latest email (the two readers disagree: ${v.reason})`.slice(0, 1900)); for (const [f, val] of heldBrandStamps(email, x)) set(f, val); }).catch(() => {});
    // Unsure what to reply is no reason to lose the deal (Harsh, Nov 20, Topview x Lindsay): a creator handing a new brand
    // to us still gets its deal in Notion and the team hears about it. No reply is written; Harsh answers the brand himself.
    const opened = await openHeldDeal({ email, x, deal, reason: v.reason }).catch((e) => { console.error('held deal', e.message); return null; });
    const where = opened?.url || deal?.url;
    await discord('🧐 ' + card(`${opened ? `${opened.brand} × ${opened.creator} · new deal opened, reply to the brand yourself` : `${who || x.brand || 'Brand email'} · I'm not sure what this email means`}`, [`Reader 1 thinks: ${x.event.replace(/_/g, ' ')}. Reader 2 thinks: ${v.rightEvent.replace(/_/g, ' ')}${v.wrongDeal ? ', and that it belongs to another deal' : ''}.`, opened ? `${v.reason} The deal is in Brand Deals (flagged Needs you). I wrote nothing to the brand.` : `${v.reason} Nothing was changed. Tell me on WhatsApp what it is and I'll act on it.`], where), 'pm').catch(() => {});
    return { action: 'held', why: `second reader disagreed: ${v.reason}${opened ? ' · new deal opened' : ''}`.slice(0, 200), deal: opened?.url || deal?.url };
  } catch (e) { console.error('second read', e.message); return null; }
}


// "your usual rates", "your typical pricing" too (Intimeros x Chris, Nov 19: "could you share your usual rates for Instagram
// Reels" was filed as a brief, a deal opened at Brief Received and Rudraksh was told to write a script nobody agreed to)
const ASKS_RATE = /\b(your|current|standard)\s+((usual|typical|normal|general|standard|current|best|base|latest)\s+)?(rates?|pricing|prices?|fees?)\b|\bshare\s+(your|the)\s+((usual|typical|normal|standard|current|latest)\s+)?(rates?|pricing|rate card)|\bwhat\s+(would|do)\s+you\s+charge|\brate\s*card\b|\bhow\s+much\s+(would|do)\s+you\s+charge/i;
const FINISHED = ['Posted', 'Invoiced', 'Paid'];

// A brand whose deal is already posted, invoiced or paid asking for our rate for something new in the same thread is a
// new inquiry whatever the reader calls the email (it is rarely a "brief"). Migoo x Brad: paid on Oct 10, Clara asked on
// Nov 6 for Brad's rate for an in-person product session (Dec 7-12); the email was filed onto the Paid deal, its memory
// rewritten, and no Inbound deal was opened (system check Nov 6).
// An invitation to the brand's NEXT campaign inside a finished deal's thread is a new deal too (rule 42), even with no
// rate question: Dreamina x Chris was Invoiced when Kepan wrote on Nov 8 "we'd love to invite you to our latest Dreamina
// campaign at the same rate" with a new creative brief; the PM folded it into the invoiced deal's memory and opened
// nothing (system check Nov 8). Whether the creator joins is Harsh's call, so it opens at Inbound and he is asked.
// Runway x Chris, Nov 11: "can we rerun the same campaign again for November? Like for like" is an invite too (system check)
const NEW_CAMPAIGN = /\binvite you to (join )?(our|the|a|another)\b[^.\n]{0,40}\b(campaign|collab(oration)?|partnership|project)\b|\b(latest|new|next|another|upcoming)\s+(\S+\s+){0,3}(campaign|collab(oration)?|partnership)\b[^.\n]{0,80}\b(join|interested|invite|work with you|same rate)\b|\b(re-?run|run|repeat|do)\b[^.\n]{0,30}\bcampaign\b[^.\n]{0,30}\b(again|for (january|february|march|april|may|june|july|august|september|october|november|december)|next month)\b|\b(re-?run|run|repeat)\b[^.\n]{0,15}\bagain\b[^.\n]{0,40}\b(same|like for like)\b/i;
export const campaignInviteIn = (text) => NEW_CAMPAIGN.test(String(text || ''));
export function finishedDealInquiry(email, x, deals) {
  if (x.from_role !== 'brand') return null;
  const onThread = deals.find((d) => email.threadId && d.threadId === email.threadId) || (x.deal_number ? deals[x.deal_number - 1] : null);
  if (!onThread || !FINISHED.includes(onThread.stage)) return null;
  const latest = latestText(email.text || '');
  const asksRate = ASKS_RATE.test(latest);
  const invite = !asksRate && NEW_CAMPAIGN.test(latest);
  if (!asksRate && !invite) return null;
  // A rate ask that the reader calls a brief is handled by briefIsInquiry before this; an invite can arrive either way
  if (asksRate && x.event === 'brief') return null;
  return { asksRate, invite, otherBrand: false, onThread };
}

// Harsh, Nov 23: "if there's nothing discussed like please share the brief or send the contract or anything related to
// pricing then the brand is not closed, they are still in talk". A brief-looking email on a NEW thread only opens a closed
// deal (card, script writer) when the thread, quoted history included, shows the deal was agreed: someone asked for or
// sent the brief / contract, a price was agreed, or the brand says the creator was selected or confirmed.
const CLOSED_SIGNS = /\b(send|share|forward|attach(ed)?|sending|sharing)\s+(over\s+)?(us\s+|you\s+)?(the\s+|a\s+|our\s+|your\s+)?(contract|agreement|paperwork|brief|campaign brief|creative brief)\b|\b(contract|agreement)\s+(is\s+)?(attached|signed|sent)\b|\b(works for us|works for me|happy to (move|go) (forward|ahead)|move (forward|ahead) with|agreed (on|to)|we('| a)re (all )?set|confirm(ed|ing)? (the )?(rate|price|fee|budget|collab(oration)?|partnership))\b|\b(you('| ha)ve been|you('| a)re|we('| ha)ve)\s+(selected|approved|accepted|confirmed|chosen)\b|\b(welcome (aboard|to the campaign)|kick-?off|onboarding)\b|\b(offer|rate|fee|price|budget)\b[^.\n]{0,40}\$\s?\d[\d,]*[^.\n]{0,40}\b(works|agreed|approved|accepted|confirmed|fine)\b|\$\s?\d[\d,]*[^.\n]{0,40}\b(works|agreed|approved|accepted|confirmed)\b/i;
export const closedInThread = (text) => CLOSED_SIGNS.test(String(text || ''));

export function briefIsInquiry(email, x, deals) {
  const latest = latestText(email.text || '');
  const asksRate = ASKS_RATE.test(latest);
  const onThread = deals.find((d) => email.threadId && d.threadId === email.threadId) || (x.deal_number ? deals[x.deal_number - 1] : null);
  const b = normBrand(x.brand), t = normBrand(onThread?.brand);
  const otherBrand = !!(onThread && b.length >= 3 && t && !t.includes(b) && !b.includes(t));
  if (!asksRate && !otherBrand) return null;
  return { asksRate, otherBrand, onThread };
}

async function openInquiry({ email, x, deals, onThread, invite = false, usage, cost }) {
  const brand = x.brand || onThread?.brand || 'Unknown brand';
  const creator = onThread?.creator || x.creator || null;
  const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '';
  // Reuse only a deal still being negotiated: a finished deal (posted, invoiced, paid) never takes a new inquiry (Migoo, Nov 6)
  let deal = deals.find((d) => !FINISHED.includes(d.stage) && d.stage !== 'Lost' && normBrand(d.brand) === normBrand(brand) && (!creator || CREATOR_KEY(d.creator || '') === CREATOR_KEY(creator)));
  if (!deal) {
    const ds = await schemaOf(DS.deals);
    const props = { 'Brand Name': { title: [{ type: 'text', text: { content: brand.slice(0, 200) } }] } };
    setIf(ds, props, 'Creator', creator);
    setIf(ds, props, 'Deal Stage', 'Inbound');
    setIf(ds, props, 'Deal Source', 'Auto-captured');
    setIf(ds, props, 'Needs Check', true);
    setIf(ds, props, 'Brand Email', sender);
    setIf(ds, props, 'Thread ID', email.threadId);
    setIf(ds, props, 'Message ID', email.messageId);
    setIf(ds, props, 'Thread Subject', threadSubject(email.subject));
    setIf(ds, props, 'Thread CC', threadCcFrom(email));
    setIf(ds, props, 'Next Action', invite ? `Waiting on us: Harsh to decide if ${creator || 'the creator'} joins this new ${brand} campaign` : 'Waiting on us: reply with our rate');
    setIf(ds, props, 'Notes', `${invite ? 'New campaign invite' : 'Inquiry'}: ${(x.summary || []).join(' | ').slice(0, 600)}${onThread ? ` (came in the ${onThread.brand} thread)` : ''}`);
    const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.deals }, properties: props });
    deal = { id: page.id, url: page.url, brand, creator };
  }
  const ask = { dealId: deal.id, brand, creator, need: invite ? `a yes or no: does ${creator || 'the creator'} join their new ${brand} campaign? (${(x.summary || []).slice(0, 2).join('; ').slice(0, 200)})` : `${creator ? creator + "'s" : 'our'} rate for ${brand} (they asked: ${(x.summary || []).slice(0, 2).join('; ').slice(0, 200)})`, threadId: email.threadId || '', messageRfc: email.messageId || '', subject: threadSubject(email.subject) || '', brandEmail: sender, theirMessage: latestText(email.text).slice(0, 1500) };
  try { const W = await import('./whatsapp.js'); await W.askForInfo(ask); } catch (e) { console.error('inquiry ask', e.message); }
  await log({ event: `New inquiry: ${brand} × ${creator || '?'}`, outcome: 'Rule', email, x, deal, details: `Not a brief: ${invite ? `an invite to a new campaign in the finished ${onThread?.brand || brand} thread` : onThread && normBrand(onThread.brand) !== normBrand(brand) ? `another brand in the ${onThread.brand} thread` : 'they asked for our rate'}. Deal at Inbound, ${invite ? 'go/no-go' : 'rate'} asked on WhatsApp. No card, no script writer.`, usage, cost, creator });
  return { event: 'inquiry', action: 'inquiry', deal: deal.url };
}

// The creator-inbox path (leads.js) finds a finished deal by the brand contact and never reaches finishedDealInquiry,
// so a new-campaign invite there opens its Inbound deal and asks Harsh the same way (Runway x Chris, Nov 11)
export async function openCampaignInquiry({ email, deal }) {
  const x = { brand: deal.brand, creator: deal.creator, from_role: 'brand', summary: [latestText(email.text || '').replace(/\s+/g, ' ').slice(0, 200)] };
  return openInquiry({ email, x, deals: [deal], onThread: deal, invite: true });
}

export async function handleInboxEmail(email) {
  const everything = await openDeals({ withClosed: true });
  const deals = everything.filter((d) => !['Paid', 'Lost'].includes(d.stage));
  // A brand writing again on a deal already marked Paid (second video, ad code, usage rights...) is still a live
  // conversation: if no open deal matches the thread or the brand's domain, bring the Paid deal back in for this email
  {
    const dom = domainOf(email.from);
    const sameBrand = (d) => (email.threadId && d.threadId === email.threadId) || (dom && !FREE_MAIL.test(dom) && domainOf(d.brandEmail) === dom);
    if (!deals.some(sameBrand)) {
      const paid = everything.find((d) => d.stage === 'Paid' && sameBrand(d));
      if (paid) deals.push(paid);
    }
  }
  if (ourAddress(email.from)) {
    if (await alreadyHandled(email.messageId)) return { action: 'skipped', why: 'already handled' };
    return handleOurReply(email, everything.filter((d) => d.stage !== 'Lost')); // Paid deals too: invoices for a second video go out after the first is paid
  }
  if (await import('./watch.js').then((w) => w.bounceAlert(email, 'noocapcollab')).catch(() => false)) return { action: 'skipped', why: 'bounce, announced on Discord' };
  const g = gate(email, deals);
  if (!g.ok) {
    // A short reply from the creator's side in a thread we track ("sure, will do") still counts as answered
    const tracked = email.threadId && deals.find((d) => d.threadId === email.threadId);
    if (tracked && g.why === 'no deal signals' && domainOf(email.from) && domainOf(email.from) !== domainOf(tracked.brandEmail)) await recordOurSide(email, `${tracked.creator || 'creator'}'s side`).catch(() => {});
    if (g.why !== 'sent by us' && g.why !== 'system email') await log({ event: `Skipped (${g.why}): ${email.subject || ''}`, outcome: 'Skipped', email, x: { reason: g.why }, details: `From ${email.from || '?'}. Skipped by the free filter, no AI used.` }).catch(() => {});
    return { action: 'skipped', why: g.why };
  }
  if (await alreadyHandled(email.messageId)) {
    const late = await lateImages(email, deals).catch((e) => { console.error('late images', e.message); return null; });
    return { action: 'skipped', why: 'already handled' + (late ? ` · ${late}` : '') };
  }

  // An email over 36 hours old on a deal we already track is only recorded (the deal is never rewound by it), so it
  // needs no AI: the brand's reply date is stamped and that's all. Reading these with Claude was $2.29 of the 60-day bill
  // (Harsh, Nov 20: "places where AI shouldn't get used")
  { const old = oldTrackedEmail(email, deals);
    if (old) {
      const brandSide = !creatorSide(email.from) && !ourAddress(email.from);
      const at = istStamp(emailTime(email));
      if (brandSide && (!old.lastBrand || Date.parse(old.lastBrand) < emailTime(email))) await patchDeal(old, (set) => { set('Last Brand Reply', at); set('Follow-ups Sent', 0); }).catch(() => {});
      await log({ event: `Old email recorded: ${old.brand} × ${old.creator || '?'}`, outcome: 'Skipped', email, deal: old, details: `Email is ${Math.round((Date.now() - emailTime(email)) / 36e5)}h old, recorded without AI and without changing the deal`, creator: old.creator }).catch(() => {});
      return { action: 'skipped', why: 'old email, recorded only (no AI)', deal: old.url };
    } }
  const allLinks = [...new Set(((email.text || '') + ' ' + (email.html || '')).match(LINK_RE) || [])].filter((u) => DOC_LINK.test(u));
  let docText = null;
  if (/brief/i.test(`${email.subject} ${email.text}`)) for (const u of allLinks.slice(0, 2)) { docText = await readDocLink(u); if (docText) break; }

  const { x, usage } = await readEmail(email, deals, docText);
  // The creators' own teams (Duncan's buildroom.ai, Chris's collab inbox, Valeri's Valchy) are our side, never the brand:
  // their emails are recorded, never answered, and never saved as the brand's address
  if (creatorSide(email.from) && x.from_role !== 'noocap') { x.from_role = 'creator'; x.needs_reply = false; }
  x.from_role = sideOf(email.from, x.from_role);
  // Only the brand can close a deal. Our own email quoting a price or saying "send the contract and we can move forward"
  // is an offer, so it never makes the deal Price Agreed / Signed / Brief Received (that waits for the brand's yes)
  const BRAND_ONLY = ['Price Agreed', 'Signed', 'Brief Received', 'Script Approved', 'Approved', 'Paid'];
  if (x.from_role !== 'brand') {
    if (x.event === 'price_agreed') x.event = 'brand_reply';
    if (BRAND_ONLY.includes(x.deal_stage)) x.deal_stage = null;
  }
  // Anything newer in the thread (the brand writing again, or the creator's team answering) makes the reply drafts
  // still waiting for the older emails out of date. The creator's side is handled in recordOurSide below.
  if (email.threadId && !['creator', 'noocap'].includes(x.from_role)) await retireStaleDrafts(email, new Date(emailTime(email)).toISOString()).catch(() => []);
  // Whose deal it is: the creator's own address on the thread beats the AI's guess
  const byAddress = creatorFromAddresses(email);
  if (byAddress && (!x.creator || CREATOR_KEY(x.creator) !== CREATOR_KEY(byAddress))) x.creator = byAddress;
  const cost = costOf(usage);
  if (['creator', 'noocap'].includes(x.from_role)) await recordOurSide(email, x.from_role === 'creator' ? `${x.creator || 'creator'}'s team` : 'NOOCAP').catch(() => {});
  // If the AI didn't pick a deal, match it ourselves: same Gmail thread first, then same brand + creator.
  // Stops the same thread opening a second deal.
  // A deal of a different creator is the wrong deal, unless it's literally the same thread (the same agency runs
  // Tripo for Lindsay and for Valeri: Valeri's thread must never land on Lindsay's deal and rewrite its thread)
  if (x.deal_number && byAddress) {
    const d = deals[x.deal_number - 1];
    if (d?.creator && CREATOR_KEY(d.creator) !== CREATOR_KEY(byAddress) && !(email.threadId && d.threadId === email.threadId)) x.deal_number = null;
  }
  // Brand Contacts key: who this sender speaks for. A contact that handles one creator names the creator when the
  // email itself doesn't.
  const contact = x.from_role === 'brand' ? await contactOf(email.from).catch(() => null) : null;
  if (!byAddress && contact?.creators?.length === 1 && !x.creator) x.creator = contact.creators[0];
  // The AI picked a deal on this thread but the email is about another brand that has its own deal on the same thread
  if (x.deal_number && email.threadId && x.brand) {
    const d = deals[x.deal_number - 1];
    if (d && normBrand(d.brand) !== normBrand(x.brand)) { const i = matchDealIndex(deals, email, x); if (i >= 0 && normBrand(deals[i].brand) === normBrand(x.brand)) x.deal_number = i + 1; }
  }
  if (!x.deal_number) {
    const i = matchDealIndex(deals, email, x);
    if (i >= 0) x.deal_number = i + 1;
  }
  // A deal only takes an email from another thread when ownership is confirmed: the creator's own address or handle
  // is on the email, or this sender (or their company) is on file for that creator. A brand name or an AI guess alone
  // never moves a deal onto a new thread; the email waits for a person instead (Tripo: Valeri's agency email must not
  // land on Lindsay's Tripo deal).
  let ownerConfirmed = false;
  if (x.deal_number) {
    const d = deals[x.deal_number - 1];
    const sameThread = !!(email.threadId && d?.threadId && d.threadId === email.threadId);
    const byAddr = !!(byAddress && d?.creator && CREATOR_KEY(byAddress) === CREATOR_KEY(d.creator));
    ownerConfirmed = sameThread || byAddr || handles(contact, d?.creator);
    // The creator's address on the email says which creator, not which deal: another company on another thread
    // with the same brand name is a new deal (GrowMaxValue's CapCut brief for Chris, Nov 5)
    if (!sameThread && x.from_role === 'brand' && !sameDealParty(d, email)) {
      x.creator = byAddress || x.creator || d?.creator || null;
      x.deal_number = null;
      ownerConfirmed = false;
      x.new_party = `${d?.brand || 'a deal'} × ${d?.creator || '?'} is another company's deal`;
    }
    if (!ownerConfirmed && x.from_role === 'brand' && x.deal_number) {
      x.deal_number = null;
      x.owner_unsure = `${d?.brand || 'a deal'} × ${d?.creator || '?'} matched only by name, not by thread or contact`;
      x.creator = byAddress || (contact?.creators?.length === 1 ? contact.creators[0] : null);
    }
    if (x.from_role !== 'brand') ownerConfirmed = sameThread || byAddr;
  }

  // A contract goes to WhatsApp whatever else the email is about (and even if the AI found it unremarkable)
  let contractNote = '';
  try { contractNote = await contractToWhatsApp(email, x, x.deal_number ? deals[x.deal_number - 1] : null); } catch (e) { console.error('Contract to WhatsApp failed', e.message); contractNote = ' · contract to WhatsApp FAILED: ' + String(e.message).slice(0, 120); }
  if (contractNote) x.reason = `${x.reason || ''}${contractNote}`;

  if (x.event === 'not_relevant' || x.confidence === 'low') {
    await log({ event: `Skipped: ${email.subject || ''}`, outcome: 'Skipped', email, x, details: x.reason, usage, cost });
    return { action: 'skipped', why: 'AI: ' + x.reason };
  }

  // The brand hands the script back as a doc with their (or the advertiser's) comments in it, often with "you can
  // start filming based on it": the notes live in the doc, so the script writer gets the link instead of nothing
  const scriptNotes = scriptCommentsDoc(email, x);
  if (scriptNotes) { x.event = 'script_changes'; x.feedback = scriptNotes; }
  applyTextGuards(x, email);
  // A brand asking for our rate, or an agency pitching ANOTHER brand in an existing deal's thread, is an inquiry, never a
  // brief: nothing is agreed yet, so no card and no script writer (Evan at Widely introduced Teamily in the Kylon x Lindsay
  // thread asking for Lindsay's rate; the PM filed it as a Kylon brief and sent Rudraksh to write a script, Nov 5).
  // It opens its own deal at Inbound and the rate question goes to Harsh.
  // The brief is in the quoted thread of a deal that has no video card yet: file it now (see quotedBrief)
  if (['brand_reply', 'script_approved'].includes(x.event) && x.from_role !== 'noocap') {
    const bd = deals.find((d) => email.threadId && d.threadId === email.threadId) || (x.deal_number ? deals[x.deal_number - 1] : null);
    const qb = bd && !bd.linkedVideo ? quotedBrief(email.text || '') : '';
    if (qb) {
      x.event = 'brief';
      x.brief_text = String(x.brief_text || '').trim() || qb;
      x.brief_links = [...new Set([...(x.brief_links || []), ...((qb.match(LINK_RE) || []).filter((u) => DOC_LINK.test(u)))])];
      if (!x.deal_number) x.deal_number = deals.indexOf(bd) + 1;
      x.reason = `${x.reason || ''} · brief found in the quoted thread (no video card yet)`;
    }
  }
  if (x.event === 'brief') {
    const inq = briefIsInquiry(email, x, deals);
    if (inq) return openInquiry({ email, x, deals, ...inq, usage, cost });
    // No deal on this thread and nothing in it about the brief, the contract or an agreed price: the brand is still in
    // talks, so the deal opens at Inbound and Harsh is asked, with no card and no script writer
    const onThread = deals.find((d) => email.threadId && d.threadId === email.threadId) || (x.deal_number ? deals[x.deal_number - 1] : null);
    if (!onThread && !closedInThread(email.text) && !isHandover(email, x)) return openInquiry({ email, x, deals, onThread: null, usage, cost });
  }
  // `deals` leaves Paid deals out, so a rate ask on a Paid deal (Migoo, the case this check was written for) never matched:
  // look the thread up in every deal (system check Nov 8)
  { const inq = finishedDealInquiry(email, x, everything);
    if (inq && !inq.invite) return openInquiry({ email, x, deals: everything, ...inq, usage, cost });
    if (inq?.invite) {
      // The same email usually carries news for the finished deal too (Dreamina: "payment in 3-5 days"), so after the new
      // deal is opened the email is still handled on the old one, but never as a brief there (rule 42)
      await openInquiry({ email, x, deals: everything, ...inq, usage, cost }).catch((e) => console.error('campaign invite', e.message));
      if (x.event === 'brief') x.event = 'brand_reply';
    } }
  if (x.event === 'brief') {
    { const bd = deals.find((d) => email.threadId && d.threadId === email.threadId) || (x.deal_number ? deals[x.deal_number - 1] : null); const held = await secondReadGate({ email, x, deal: bd, who: bd ? `${bd.brand} × ${bd.creator || '?'}` : x.brand, usage, cost }); if (held) return { event: 'brief', ...held }; }
    x.is_brief = true;
    const r = await fileBrief({ email, x, deals, allLinks, docText, usage, cost });
    // A creator's loop-in that also carries the brief still gets the "we'll take it from here" reply (HubSpot x Duncan,
    // Nov 20: the brief was filed and nobody told Piers we had it). Only when the deal was opened by this email.
    if (r?.createdDeal && isHandover(email, x)) {
      try {
        const opened = (await openDeals({ withClosed: true })).find((d) => d.threadId === email.threadId);
        if (opened && !(await weRepliedAfter(email))) await ackHandover(opened, email, x);
      } catch (e) { console.error('handover ack after brief', e.message); }
    }
    return { event: 'brief', ...r };
  }

  let deal = x.deal_number ? deals[x.deal_number - 1] : null;
  const creator = deal?.creator || x.creator;
  let board = creator ? BOARDS.find((b) => CREATOR_KEY(b.creator) === CREATOR_KEY(creator)) : null;
  // Numbered briefs inside any brand email ("Second brief: ...", "Third brief: ..."), even one the reader filed as video
  // feedback: each link goes on its own card, and a script written before it goes back to the script writer
  // (CapCut x Chris, Nov 14). The rest of the email is still handled as usual.
  if (deal && board && x.from_role !== 'noocap') {
    try {
      const B = await import('./briefs.js');
      const numbered = B.numberedBriefs(latestText(email.text || ''));
      if (numbered.length) {
        const done = await B.putNumberedBriefs({ deal, board, numbered, email, x });
        if (done.length) {
          await discord(`${tag()} ✏️ **New briefs: ${deal.brand} × ${deal.creator}**\n${done.map((d) => `• Video ${d.n}: ${d.title} → brief set${d.rewrite ? ', script writer asked to redo the script (Brief changed)' : ''}`).join('\n')}`).catch(() => {});
          await log({ event: `Briefs per video: ${deal.brand} × ${deal.creator}`, outcome: 'Rule', email, x, deal, details: done.map((d) => `#${d.n} ${d.url} ${d.link}${d.rewrite ? ' (Brief changed)' : ''}`).join('\n'), creator: deal.creator }).catch(() => {});
        }
      }
    } catch (e) { console.error('numbered briefs', e.message); }
  }
  // No deal row yet (negotiation happened in the creator's own inbox): if we know the creator and the brand, open the deal
  // ourselves, flagged Needs Check, instead of leaving the email unmatched.
  let newDeal = false;
  // Brand wrote to noocapcollab without saying which creator: look for a recent SPONSOR card named after the brand
  if (!deal && !board && x.brand && x.from_role !== 'noocap' && !x.owner_unsure) {
    const guess = await creatorFromCards(x.brand).catch(() => null);
    if (guess) { board = BOARDS.find((b) => b.creator === guess); x.creator = guess; }
  }
  // Our own email in a thread with no deal yet is still a lead (negotiation lives on the Leads tab), so no deal is opened for it
  // "That works for us, send the contract" from our side is still only our offer: the brand hasn't agreed until THEY say
  // so (or send the contract/brief), so our own email can't open a deal at Price Agreed either
  // Except a handover: the creator's team adding noocapcollab to the thread ("please add noocapcollab so they can take
  // over") means the deal is agreed and is ours to run now. Open it, flagged Needs Check, instead of dropping it.
  if (!deal && isHandover(email, x)) { x.deal_stage = 'Price Agreed'; x.owner_unsure = false; }
  if (!deal && x.from_role !== 'brand' && !isHandover(email, x) && !(x.deal_stage && !['Inbound', 'Negotiating', 'Price Agreed'].includes(x.deal_stage))) {
    await log({ event: `Our email, still a lead: ${email.subject || ''}`, outcome: 'Skipped', email, x, details: 'No deal opened: the brand has not agreed yet', usage, cost, creator: board?.creator });
    return { action: 'recorded', why: 'our email on a lead, no deal yet' };
  }
  if (!deal && board && x.brand && x.from_role !== 'noocap' && !(x.owner_unsure && !byAddress && !handles(contact, board.creator))) {
    deal = await createDealFor(x, email, board); newDeal = !deal.reused;
    // The creator's team looped noocapcollab in: tell the brand we have it from here and ask for the brief and contract
    // (Harsh, Nov 13). Sends itself after the usual hold, like every follow-up; the chasing after it is the deal's own.
    if (newDeal && isHandover(email, x)) { try { await ackHandover(deal, email, x); } catch (e) { console.error('handover ack', e.message); } }
    if (byAddress || handles(contact, board.creator)) ownerConfirmed = true;
  }
  // Brand approved or commented on the video but there's no deal row: act on the video in Video Intake anyway
  if (!deal && x.event === 'video_feedback' && x.brand) {
    const row = await findIntakeRowByBrand(x.brand, board?.creator).catch(() => null);
    if (row && (x.video_approved || x.feedback)) {
      if (x.video_approved) await setIntake(row, 'To Post');
      else await setIntake(row, 'Changes', { feedback: x.feedback ? [x.feedback] : asList(x.summary), bumpRevision: true, images: email.attachments });
      const did = x.video_approved ? 'Video Intake set to To Post, editor bot asks for the CTA renders' : `Brand changes sent to ${row.editor || 'the editor'} (Video Intake set to Changes)`;
      await log({ event: `video feedback: ${x.brand} × ${row.creator || '?'} (no deal row)`, outcome: 'Rule', email, x, details: did, usage, cost, creator: row.creator });
      return { action: 'handled', event: x.event, did };
    }
  }
  const fresh = !email.date || (Date.now() - Date.parse(email.date)) / 36e5 <= 36;
  if (!deal && fresh && (x.needs_reply || x.event === 'brand_reply' || x.event === 'payment_confirmed') && x.from_role === 'brand') {
    // Can't tell which deal, but the brand is waiting on us: still put a reply in Approvals, in their thread
    const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '';
    const loose = { brand: x.brand || 'Brand', creator: null, stage: null, brandEmail: sender, threadId: email.threadId, messageRfc: email.messageId, threadSubject: threadSubject(email.subject), threadCc: threadCcFrom(email) };
    // Already answered? A reply to this exact email in any state (draft, sent or rejected), or a draft still waiting in the thread
    const or = [{ property: 'Reply To Message ID', rich_text: { equals: String(email.messageId || '').slice(0, 1900) } }];
    const waiting = (await weRepliedAfter(email)) || (email.messageId || email.threadId ? await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { or } }).then((r) => (r.results || []).length > 0).catch(() => false) : false);
    if (!waiting) {
      await replaceOlderReplies(email.threadId);
      const mail = await writeEmail({ kind: 'Reply', deal: loose, facts: { their_latest_message: latestText(email.text), their_message: (x.summary || []).join(' | '), subject: email.subject, note: 'If they ask for bank, payment or personal details, do not invent any: say we will send them shortly.' } });
      const made = await createDraft({ files: email.attachments, context: `From: ${email.from || ''}\nDate: ${email.date || ''}\n\n${latestText(email.text).slice(0, 2500)}`, kind: 'Reply', deal: loose, subject: mail.subject, body: mail.body, notify: false, why: `${x.brand || 'A brand'} asked: ${(x.summary || [])[0] || email.subject} (not linked to a deal yet, I couldn't tell which creator) [from:${new Date(emailTime(email)).toISOString()}]` });
      // Two emails from the same thread can arrive together: keep the first draft, bin any twin
      const twins = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 10, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Gmail Thread ID', rich_text: { equals: email.threadId } }] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] }).then((r) => r.results || []).catch(() => []);
      if (twins.length > 1 && twins[0].id !== made.id) await notion('PATCH', `/pages/${made.id}`, { in_trash: true }).catch(() => {});
      else await discord(`📬 **${x.brand || 'Brand'} · reply email to approve**\n• ${String((x.summary || [])[0] || email.subject).slice(0, 160)}\n• Not linked to a deal yet: I couldn't tell which creator${process.env.PM_PUBLIC_URL ? `\n→ [Review in Approvals](${process.env.PM_PUBLIC_URL}/#approvals)` : ''}`, 'pm');
    }
    await log({ event: `Unmatched ${x.event}: ${email.subject || ''}`, outcome: 'Needs approval', email, x, details: (waiting ? 'Already replied, or a reply is waiting in Approvals' : 'Reply drafted for approval without a deal') + (x.owner_unsure ? ` · held back from ${x.owner_unsure}: link it by hand, or add this sender to Brand Contacts` : ''), usage, cost, creator: board?.creator });
    return { action: 'needs_help', event: x.event, why: 'no matching deal, reply drafted' };
  }
  if (!deal && !fresh) {
    await log({ event: `Skipped: old unmatched email · ${email.subject || ''}`, outcome: 'Skipped', email, x, details: 'Older than 36 hours and not linked to a deal, recorded only', usage, cost });
    return { action: 'skipped', why: 'old email, no deal' };
  }
  if (!deal) {
    const msg = `❓ ` + card(`Couldn't match an email: ${email.subject || '(no subject)'}`, [`From ${String(email.from || '?').replace(/<.*>/, '').trim() || email.from}`, (x.summary || [])[0]]) + `\nTell me in chat which deal it belongs to, or add the deal in Notion.`;
    await discord(msg, 'pm');
    await log({ event: `Unmatched ${x.event}: ${email.subject || ''}`, outcome: 'Needs approval', email, x, details: msg, usage, cost, creator: board?.creator });
    return { action: 'needs_help', event: x.event, why: 'no matching deal' };
  }

  // The deal's running record takes this email in before anything is drafted from it
  // Who wrote it comes from the sender's address: the AI's "other" filed Erick's (Creator.co, Bluehost) email as ours, Nov 5
  if (ageH0(email) <= 24 * 30) await rememberEmail(deal, { who: ourAddress(email.from) ? 'us (NOOCAP)' : (x.from_role === 'creator' || creatorSide(email.from)) ? `${deal.creator || 'creator'}'s team` : `brand (${email.from || ''})`, date: email.date, subject: email.subject, text: latestText(email.text || '') }).catch((e) => console.error('memory', e.message));

  // One message per email. A brand-new deal always goes to #pm-alerts (someone has to check it); routine updates go to #pm-log.
  const say = (emoji, headline, lines, level = 'log', link = deal.url) => {
    if (newDeal && deal.needsCheck) { level = 'pm'; lines = [...(lines || []).slice(0, 1), 'New deal, but I could not tell the stage: please set it']; emoji = '🆕'; }
    return discord(`${emoji} ` + card(headline, lines, link), level);
  };
  const fromBrand = x.from_role === 'brand';
  // An explicit invoice request is never missed (ZEELY via Mediacube asked "provide the invoice for the remaining
  // payment" and got a "we'll send it within hours" reply instead of an invoice, Nov 2). The invoicing step raises it;
  // no reply email is written for it.
  // "Approved Idea, Script & Live Date With Feedback: here is the validated version" + "Next Step: Draft video" is an
  // APPROVAL with the brand's own final wording, not changes for the script writer: film it (Weglot via Faved, Nov 3)
  // "In our payment queue, due to be paid 13/11" is a promise to pay, never a payment (Runway, Nov 3)
  if (fromBrand && !x.asks_for_invoice && x.event !== 'payment_confirmed' && /\b(send|share|provide|issue|need|forward|resend|raise)\b[^.?\n]{0,60}\binvoice\b/i.test(latestText(email.text || ''))) x.asks_for_invoice = true;
  if (fromBrand && x.asks_for_invoice && x.event === 'brand_reply' && !/\?/.test(latestText(email.text || '').replace(/[^?]*invoice[^?]*\?/gi, ''))) { x.needs_reply = false; x.needs_our_info = false; }
  // A newer brand email makes any reply still waiting for this thread stale; money landing makes chases stale too
  // (SpeakOn: a draft asking for the payment sheet stayed after they wrote that payment was done)
  if (fromBrand && ageH0(email) <= 36) {
    await replaceOlderReplies(email.threadId || deal.threadId).catch(() => {});
    if (x.event === 'payment_confirmed' && proofFilesOf(email).length) for (const k of ['Payment chase', 'Billing details']) { const d = await pendingDraft(deal.id, k).catch(() => null); if (d) await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {}); }
  }
  // A confirmed brand email teaches the Brand Contacts key (never a guessed one, so a mistake can't teach itself)
  if (fromBrand && ownerConfirmed && deal?.creator) await learnContact({ from: email.from, brand: deal.brand, creator: deal.creator }).catch(() => {});
  // Billing details sent as a screenshot or PDF (Emergent x Chris, Nov 23): read the file when the email talks about
  // billing and nothing in the text gave them
  if (fromBrand && deal && !x.billing_details?.company_name && !readBilling(deal.billing) && BILLING_ASK.test(latestText(email.text || '')) && !billingFromText(latestText(email.text || ''), email.from)) {
    try { const b = await billingFromFiles(email); if (b) x.billing_details = b; } catch (e) { console.error('billing from files', e.message); }
  }
  const common = (set) => {
    // The PM keeps the stage itself: forward only, and only when it's sure
    // Paid is never taken from the AI's guess: only real money (with proof, or Stripe) marks it, in payment_confirmed / invoicing
    if (aiStage(x.deal_stage) && x.confidence === 'high' && STAGES.includes(x.deal_stage) && stageBefore(deal.stage, x.deal_stage)) set('Deal Stage', x.deal_stage);
    if (fromBrand) { set('Last Brand Reply', istStamp(emailTime(email))); set('Follow-ups Sent', 0); }
    // Company details for the invoice, and how the fee is split: the invoicing step raises the invoice from these
    // The brand asked for the invoice: it goes out now, it doesn't wait for the video to be posted
    if (fromBrand && x.asks_for_invoice) set('Invoice Requested', true);
    // The AI reader can miss company details the brand wrote out (Gamut x Lindsay, Nov 18): read them from the text too
    if (fromBrand && !x.billing_details?.company_name && !readBilling(deal.billing)) { const b = billingFromText(latestText(email.text || ''), email.from); if (b) x.billing_details = b; }
    if (fromBrand && x.billing_details?.company_name) set('Billing Details', JSON.stringify({ ...x.billing_details, email: x.billing_details.email || (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || null, at: todayIST() }));
    if (x.payment_terms && /\d\s*%|net \d+|upfront|advance|on (publish|posting|delivery)|\d+\s*(business |working |calendar )?days/i.test(x.payment_terms)) {
      set('Payment Terms', String(x.payment_terms).slice(0, 300));
      // The brand said when it pays: that is the due date, and the payment is not chased before it (Harsh, Nov 26:
      // Emergent said 15 days from the invoice, and we had already chased on day 3)
      if (fromBrand && deal.invoiceSent && deal.stage !== 'Paid') {
        const due = dueFromTerms(x.payment_terms, { invoiceSent: deal.invoiceSent, said: new Date(emailTime(email) + 5.5 * 36e5).toISOString().slice(0, 10) });
        if (due) { set('Invoice Due Date', due); set('Next Action', `Waiting for payment, due ${due} (the brand's terms). No reminder before then.`); }
      }
    }
    // The brand named where invoices go ("invoices are paid 30 days after they are sent to finance@getramped.com"): every
    // invoice and payment chase goes to that address from now on (GetRamped, Nov 4: the chase went to Celina instead)
    { const be = fromBrand ? billingEmailIn(latestText(email.text || '')) : null; if (be && !String(deal.billing || '').toLowerCase().includes(be)) set('Billing Details', withBillingEmail(deal.billing, be)); }
    // A brand update that asks nothing of us ("still waiting on our team's approval") leaves nothing to answer: the
    // ball stays with them, so it counts as answered and the follow-up clock starts from it
    if (fromBrand && x.event === 'brand_reply' && x.needs_reply === false && !x.we_owe) set('Last Our Reply', istStamp(emailTime(email)));
    // The deal's thread only moves when we know this email is really this deal's (see ownerConfirmed above)
    const own = ownerConfirmed || newDeal;
    if (email.threadId && ((fromBrand && own) || !deal.threadId)) set('Thread ID', email.threadId);
    // Our own email only becomes the reply anchor when it sits in the brand's thread: a stray email we started elsewhere
    // took over Bluehost × Chris's Message ID and every chaser after it went to that stray thread (Nov 9)
    if (email.messageId && ((fromBrand && own) || (!deal.messageRfc && (fromBrand || !deal.threadId || email.threadId === deal.threadId)))) { set('Message ID', email.messageId); set('Thread Subject', threadSubject(email.subject)); }
    if (fromBrand && own) { const cc = threadCcFrom(email, deal.threadCc); if (cc && cc !== deal.threadCc) set('Thread CC', cc); }
    // We answer whoever wrote last: Emergent's contact moved from Kritika to Gautam, and the ad-code reply went to
    // Kritika (Nov 3). A brand sender in the deal's own thread replaces the old Brand Email.
    { const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
      if (fromBrand && sender && !creatorSide(sender) && (!deal.brandEmail || (own && sender.toLowerCase() !== String(deal.brandEmail).toLowerCase()))) set('Brand Email', sender); }
  };
  const pts = (x.summary || []).slice(0, 2);
  // Catch-up safety: an email older than 36 hours is history. Recording it must not rewind the deal's stage,
  // overwrite Next Action, draft replies or ping anyone (the deal has probably moved on since).
  const ageH = email.date ? (Date.now() - Date.parse(email.date)) / 36e5 : 0;
  // Promises to the brand ("I'll send the signed contract shortly") become the deal's Next Action, due the next day.
  // The heartbeat reminds Harsh once a day until it's sent. An old email only sets it on a brand-new deal (no history to trust).
  const kept = scriptPromiseKept((x.we_promised || []).filter(Boolean), x.from_role, latestText(email.text || ''));
  const promised = kept.promised;
  const delivered = (x.delivers || []).filter(Boolean);
  const applyPromise = async () => {
    if (x.from_role === 'brand' || (ageH > 36 && !newDeal)) return '';
    if (kept.handed && !['Inbound', 'Negotiating'].includes(deal.stage) && stageBefore(deal.stage, 'Script Approved')) {
      const sentAt = emailTime(email);
      const in3 = new Date(sentAt + 5.5 * 36e5 + 3 * 864e5).toISOString().slice(0, 10);
      await patchDeal(deal, (set) => {
        set('Last Our Reply', istStamp(sentAt));
        if (!deal.scriptSent) set('Script Sent Date', new Date(sentAt + 5.5 * 36e5).toISOString().slice(0, 10));
        if (stageBefore(deal.stage, 'Script Sent')) set('Deal Stage', 'Script Sent');
        set('Follow-ups Sent', 0); set('Next Action', 'Waiting for the brand to approve the script'); set('Next Action Date', in3);
      }).catch(() => {});
      if (!promised.length) return '; script handed over by our side, recorded as sent';
    }
    if (promised.length) {
      const day = new Date((Date.parse(email.date || '') || Date.now()) + 5.5 * 36e5);
      const due = new Date(day.getTime() + 864e5).toISOString().slice(0, 10);
      await patchDeal(deal, (set) => { set('Next Action', `Send ${deal.brand} the ${promised.join(' + ')} (promised ${day.toISOString().slice(0, 10)})`); set('Next Action Date', due); }).catch(() => {});
      return `; reminder set: send ${promised.join(' + ')}`;
    }
    if (delivered.length && /^Send /.test(deal.nextAction || '')) {
      await patchDeal(deal, (set) => set('Next Action', `Sent: ${delivered.join(' + ')}`)).catch(() => {});
      await clearNextDate(deal);
      return `; marked sent: ${delivered.join(' + ')}`;
    }
    return '';
  };
  if (ageH > 36) {
    await applyPromise();
    // Still keep the deal's facts current without rewinding anything: the brand's last reply date (so follow-ups don't
    // chase a brand that already answered) and the stage, forward only
    try {
      const cur = await notion('GET', `/pages/${deal.id}`);
      const lastBrand = plain(cur.properties?.['Last Brand Reply']);
      const stageNow = plain(cur.properties?.['Deal Stage']);
      const day = email.date && Number.isFinite(Date.parse(email.date)) ? istStamp(Date.parse(email.date)) : null;
      await patchDeal(deal, (set) => {
        if (aiStage(x.deal_stage) && x.confidence === 'high' && STAGES.includes(x.deal_stage) && stageBefore(stageNow, x.deal_stage)) set('Deal Stage', x.deal_stage);
        if (fromBrand && day && (!lastBrand || (lastBrand.length > 10 ? Date.parse(lastBrand) < Date.parse(day) : lastBrand.slice(0, 10) < day.slice(0, 10)))) { set('Last Brand Reply', day); set('Follow-ups Sent', 0); }
      });
    } catch { /* recording only */ }
    if (newDeal && deal.needsCheck) await say('🆕', `${deal.brand} × ${deal.creator || '?'} · found in older emails`, pts, 'pm');
    await log({ event: `Old email recorded: ${deal.brand} × ${deal.creator || '?'}`, outcome: 'Skipped', email, x, deal, details: `Email is ${Math.round(ageH)}h old, recorded without changing the deal`, usage, cost, creator: deal.creator });
    return { action: 'skipped', why: 'old email, recorded only', deal: deal.url };
  }
  const who = `${deal.brand} × ${deal.creator || '?'}`;
  let did = '';
  let accessDid = '';

  // Change notes from the brand that the AI filed as a plain reply (ZenBusiness × Lindsay, 3 Nov: "UGC 3 · 0:04s missing
  // the ® after Velo…" became a drafted email). Notes go to whoever makes the change, never into an email: to the editor
  // when a cut has been sent (an open edit row exists), else to the script writer while the script is with the brand.
  if (fromBrand && x.event === 'brand_reply' && String(x.feedback || '').trim().length > 10) {
    let cut = null;
    try { cut = (await findIntakeRows(deal).catch(() => [])).find((r) => /in review|send to brand|with brand|changes|to post/i.test(r.status || '')) || null; } catch { /* below */ }
    if (cut) x.event = 'video_feedback';
    else if (['Script Sent', 'Brief Received', 'Signed', 'Price Agreed'].includes(deal.stage)) x.event = 'script_changes';
  }
  // Notes the brand calls feedback on "your first video draft" while only a script has gone out are script notes: no
  // cut exists to give feedback on (AI Inspo x Duncan, Nov 23: Jessie's three notes on the script PDF were read as
  // video_feedback, the readers split and the deal waited for Harsh instead of going to Rudraksh; morning system check).
  if (fromBrand && x.event === 'video_feedback' && scriptOnlyStage(deal.stage) && String(x.feedback || '').trim().length > 10) {
    let cut = null;
    try { cut = (await findIntakeRows(deal).catch(() => [])).find((r) => /in review|send to brand|with brand|changes|to post/i.test(r.status || '')) || null; } catch { /* below */ }
    if (!cut) x.event = 'script_changes';
  }

  // The brand pays only by bank transfer or PayPal (Harsh, Nov 16): the creator's verified details from Creator Payment
  // Details go in a reply that waits for Harsh's tap. Nothing is sent from anywhere else.
  if (fromBrand && ['Posted', 'Invoiced'].includes(deal.stage)) {
    try {
      const G = await import('./invoiceguard.js');
      const note = await G.answerPaymentMethod({ ...deal, invoiceAmount: deal.invoiceAmount, invoiceNumber: deal.invoiceNumber }, { from: email.from, subject: email.subject, latest: latestText(email.text || '') }, { createDraft, say: (m) => discord(m, 'pm') });
      if (note) accessDid += ` · ${note}`;
    } catch (e) { console.error('payment method reply', e.message); }
  }

  // The brand can't open the link we sent (Readdy and ElevenLabs, Nov 10-11): send the same link again straight away,
  // on its own line, instead of treating "the link doesn't load" as feedback on the video
  if (fromBrand && linkBroken(latestText(email.text || ''))) {
    try {
      const link = await lastLinkSent(deal);
      if (link) {
        const first = (String(email.from || '').match(/^"?([A-Z][a-z]+)/) || [])[1] || 'there';
        const body = `Hi ${first},\n\nSorry about that. Here's the link again:\n\n${link}\n\nIf it still doesn't open, let us know and we'll send the video another way.\n\nBest,\n${deal.creator || 'Our'}'s Team`.replace(/\nOur's Team$/, '\nOur Team');
        const d = await createDraft({ kind: 'Other', deal, subject: `Re: ${String(email.subject || deal.threadSubject || '').replace(/^\s*(re:\s*)+/i, '')}`, body, notify: false, why: `${deal.brand} said the link didn't open; the same link sent again.` });
        if (d?.created && d.id) { const { autoSend } = await import('./outbox.js'); await autoSend(d.id); }
        x.event = 'brand_reply'; x.feedback = ''; x.needs_reply = false; x.needs_our_info = false;
        accessDid += ' · link sent again (it didn\'t open for them)';
      }
    } catch (e) { console.error('resend link', e.message); }
  }
  { const held = await secondReadGate({ email, x, deal, who, usage, cost }); if (held) return held; }
  // The brand answered our tool-access email (UIDs to send, an invite, credits): the steps go to the card and its
  // editor, and the editor's answer goes back through the card's "For the brand" field, so it never waits on Harsh
  if (fromBrand && !['script_changes', 'video_feedback', 'payment_confirmed'].includes(x.event)) {
    try {
      const T = await import('./toolaccess.js');
      const r = await T.routeAccessReply({ deal, email, latest: latestText(email.text || ''), discord });
      // the PM still answers whatever else the brand wrote (a broken link, a question); it only skips the account part
      if (r && !r.duplicate) { accessDid = ` · tool access sent to ${r.to}`; if (!r.answerToo) { x.needs_reply = false; x.needs_our_info = false; } }
    } catch (e) { console.error('tool access hand-off', e.message); }
  }
  switch (x.event) {
    case 'price_agreed': {
      await patchDeal(deal, (set) => {
        common(set);
        if (stageBefore(deal.stage, 'Price Agreed')) set('Deal Stage', 'Price Agreed');
        if (x.amount && (!x.currency || /usd|\$/i.test(x.currency))) set('Final Rate USD', x.amount);
        set('Confirmed Date', todayIST());
        set('Next Action', 'Waiting for the brief');
      });
      await say('💰', `${who} · ${money(x.amount, x.currency) || 'price'} agreed`, pts, 'log');
      did = 'Deal moved to Price Agreed';
      break;
    }
    case 'script_approved': {
      // Several videos on the deal: the script cards are the ones still at scripting, never a video already filmed
      const scriptCard = await scriptCardOf(deal, latestText(email.text || ''));
      deal = { ...deal, linkedVideo: scriptCard };
      // Approved but on hold ("please wait for our confirmation before starting video production"): the deal records the
      // approval, nothing moves to To Film, no tool-access ask, and the brand gets the fixed hold reply (AI Inspo x
      // Duncan, Nov 26: they got "we're moving into production now")
      { const U = await import('./unanswered.js');
        if (U.productionHold(latestText(email.text || ''))) {
          await patchDeal(deal, (set) => { common(set); if (stageBefore(deal.stage, 'Script Approved')) set('Deal Stage', 'Script Approved'); set('Script Approved Date', todayIST()); set('Next Action', `On hold: ${deal.brand} approved the script but asked us to wait for their go-ahead before filming. Don't film until they confirm.`); });
          await say('⏸️', `${who} · script approved, but they asked us to hold filming`, ['The card stays where it is. Nothing gets filmed until they confirm.'], 'pm', deal.linkedVideo || deal.url);
          did = 'Deal Script Approved, on hold until the brand confirms';
          if (!x.needs_our_info && deal.channel !== 'WhatsApp') {
            try { const R = await import('./replytemplates.js'); const r = await R.sendTemplateToDeal(deal.id, 'production_hold_ack', { from: email.from, since: new Date(emailTime(email)).toISOString() }); if (r?.sent) did += ', hold reply sent'; } catch (e) { console.error('hold ack', e.message); }
          }
          break;
        } }
      await patchDeal(deal, (set) => {
        common(set);
        if (stageBefore(deal.stage, 'Script Approved')) set('Deal Stage', 'Script Approved');
        set('Script Approved Date', todayIST());
        set('Next Action', 'Film and edit the video');
      });
      const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 6) : null;
      const notes = String(x.filming_notes || '').trim();
      // Their own validated wording is what gets filmed: it goes on the card as the final script
      const finalScript = String(x.approved_script || '').trim();
      // The card then shows only the approved script: the brief, feedback and older versions go to Card history
      // (Harsh, Nov 16: "once the script is approved... just show the approved script, nothing else")
      let cleaned = null;
      if (deal.linkedVideo) {
        try { const C = await import('./cardclean.js'); const id = (String(deal.linkedVideo).match(/[0-9a-f]{32}/i) || [])[0]; if (id) cleaned = await C.cleanCardToApprovedScript(id, { brandScript: finalScript, filmingNotes: notes, date: todayIST() }); }
        catch (e) { console.error('card cleanup', e.message); }
      }
      if (!cleaned?.cleaned && notes && deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `🎬 Brand notes for filming and editing ${todayIST()}`, notes.split('\n'));
      if (!cleaned?.cleaned && finalScript && deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `✅ Final script approved by the brand ${todayIST()} (their validated version, film this)`, finalScript.split('\n').map((l) => l.trim()).filter(Boolean));
      await say('✅', `${who} · script approved`, [st ? `Video moved to ${st}` : null, notes ? `Filming notes saved on the card: ${notes.slice(0, 160)}` : pts[0]], notes ? 'pm' : 'log', deal.linkedVideo || deal.url);
      did = `Deal Script Approved${st ? ', video ' + st : ''}${notes ? ', filming notes added to the card' : ''}`;
      // Script approved -> ask the brand to give their tool's access to our filming account, once per deal; it sends
      // itself after the hold (Harsh, Nov 7)
      let toolAsk = null;
      try { toolAsk = await askToolAccess(deal, email, { points: !!(notes || x.needs_our_info || /^\s*\d+[.)]\s/m.test(latestText(email.text || ''))) }); if (toolAsk) did += ', tool-access email drafted'; } catch { /* the approval itself is handled */ }
      // A fixed thank-you with the draft timing goes back on its own (Harsh, Nov 24: "why there's no reply here?",
      // Manyfast x Duncan's approval sat unanswered). Not when the tool-access email is already going into the thread,
      // and not when the brand also asked something only Harsh can answer (that goes to him).
      if (!toolAsk && !x.needs_our_info && deal.channel !== 'WhatsApp') {
        try { const R = await import('./replytemplates.js'); const r = await R.sendTemplateToDeal(deal.id, 'script_approved_ack', { from: email.from, since: new Date(emailTime(email)).toISOString() }); if (r?.sent) did += ', thank-you sent'; else if (r?.why) did += `, no thank-you (${String(r.why).slice(0, 80)})`; } catch (e) { console.error('script approved ack', e.message); }
      }
      break;
    }
    case 'script_changes': {
      if (!String(x.feedback || '').trim()) {
        // Nothing new for the script writer (the email repeats older notes): don't send the card back again
        await patchDeal(deal, (set) => common(set));
        did = 'No new script changes in this email';
        break;
      }
      await patchDeal(deal, (set) => { common(set); set('Next Action', 'Rudraksh revising the script'); });
      // Several videos on the deal (CapCut x Chris, Nov 17): notes on scripts 2 and 3 went onto video 1's card, which
      // was already approved and waiting to post, and sent it back to 4- Script Draft. Notes go to the cards still at
      // scripting; a filmed video is never sent back by script notes.
      const scriptCards = await scriptCardsOf(deal);
      let st = null;
      // The cards go to "4.8- Script Changes" (Harsh, Nov 20): when the new script is pasted and the card is moved back to
      // 5, the PM sends it to the brand as the revised script (lib/heartbeat.js, scriptChangesAt)
      for (const c of scriptCards) { st = (await setVideoStatus(c, SCRIPT_CHANGES)) || st; await markScriptChanges(c, deal); await addNoteToVideo(c, `📋 Brand feedback on the script ${todayIST()}`, [x.feedback, ...(x.summary || [])]); }
      deal = { ...deal, linkedVideo: scriptCards[0] || null };
      const pinged = await discord(`${tag()} ✏️ **Script changes requested: ${who}**\n${x.feedback ? x.feedback.slice(0, 900) : pts.map((p) => '• ' + p).join('\n')}${st ? `\n• Card${scriptCards.length > 1 ? 's' : ''} moved to ${st}. Paste the new script and move ${scriptCards.length > 1 ? 'them' : 'it'} back to 5, and the PM sends the revised script to the brand` : ''}${deal.linkedVideo ? '\nNotion: ' + deal.linkedVideo : ''}`).catch(() => false);
      if (pinged) await say('✏️', `${who} · script changes requested`, ['Rudraksh has been tagged'], 'log', deal.linkedVideo || deal.url);
      else await discord(`⚠️ **Couldn't reach Rudraksh on Discord: ${who} script changes**\nThe feedback is on the video card, please pass it on${deal.linkedVideo ? '\n→ ' + deal.linkedVideo : ''}`, 'pm').catch(() => {});
      did = `Script changes ${pinged ? 'sent to Rudraksh' : 'saved on the card (Discord ping to Rudraksh FAILED)'}${st ? ', video back to ' + st : ''}`;
      // The brand hears that the notes are with the writer (Harsh, Nov 18: Mia's script notes sat unanswered). Fixed
      // wording, noocapcollab only; a question that needs our info still goes to Harsh instead.
      if (pinged && fromBrand && !x.needs_our_info) {
        const leadLine = x.also_video_approved ? "Thanks for approving the video! We'll get it published and share the live link here as soon as it's up." : '';
        try { did += ` · ${await templateReply(email, deal, { ...x, template: 'script_changes_ack', leadLine })}`; } catch (e) { did += ` · fixed reply failed: ${String(e.message).slice(0, 80)}`; }
      }
      break;
    }
    case 'video_feedback': {
      await patchDeal(deal, (set) => {
        common(set);
        if (x.video_approved && stageBefore(deal.stage, 'Approved')) set('Deal Stage', 'Approved');
        set('Next Action', x.video_approved ? 'Render CTAs and post the video' : x.feedback ? (x.approved_after_changes ? 'Editor making the brand\'s small change (otherwise approved), then send the revised cut' : 'Editor making the brand\'s changes') : 'Waiting for the brand to review the video');
      });
      if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the video ${todayIST()}`, [x.feedback, ...asList(x.summary)]);
      // Hand it to the editor through Video Intake: Changes = the editor bot asks for the revision,
      // To Post = the editor bot asks for the CTA renders. The board card follows.
      let row = null;
      try { row = await findIntakeRow(deal); } catch { /* handled below */ }
      if (x.video_approved && row?.status === 'Posted') row = null; // already out, an approval changes nothing
      // One email, several videos, one approved and one with changes (CapCut x Lindsay, Nov 25): read per video, never
      // as one approval or one set of changes for whichever row came first
      if (x.video_approved) {
        try {
          const all = await findIntakeRows(deal).catch(() => []);
          const parts = all.length > 1 ? notesPerVideo(latestText(email.text || ''), all) : null;
          if (parts && parts.some((p) => !p.approved)) { x.video_approved = false; x.feedback = x.feedback || parts.filter((p) => !p.approved).map((p) => p.lines.join(' ')).join(' '); }
        } catch { /* as the reader said */ }
      }
      if (x.video_approved) {
        // Your editor bot takes it from here: CTA message to the editor, "done" → Posted in Intake + card to To Post
        if (row) await setIntake(row, 'To Post', { note: (x.feedback ? [x.feedback] : asList(x.summary)).filter(Boolean).join('\n') });
        // No Video Intake row (ElevenLabs × Duncan NOVEMBER, Nov 16: the card sat at 9 after the brand approved): the
        // card itself goes to To Post, which starts the editor's To Post thread with the CTA upload folder
        const st = !row && deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 10).catch(() => null) : null;
        await say('🎉', `${who} · video approved`, [row ? 'Video Intake set to To Post, editor bot asks for the CTA renders' : st ? `Card moved to ${st}` : null, deal.postingHold ? `Posting hold: ${String(deal.postingHold).slice(0, 120)}` : null], row || st ? 'log' : 'pm', deal.linkedVideo || deal.url);
        if (!row && !st) await discord(`⚠️ ` + card(`${who} · video approved, but I couldn't find it in Video Intake`, ['Set its Video Intake row to To Post so the editor renders the CTAs']), 'pm');
      } else if (x.feedback && hashtagOnly(`${x.feedback} ${asList(x.summary).join(' ')}`)) {
        // Dreamina x Chris, Nov 18-21: "Could you please revise the hashtags accordingly? #Dreamina #MarketingStudio ..."
        // on an approved, cleared-to-post reel was sent to the editor as video changes. The tracker row and card went back
        // to Changes, nobody posted, and the reel sat 3 days past its post date under a cancel warning. Hashtags are the
        // post caption: the video stays where it is and whoever posts gets the hashtags
        if (row?.id && row.source === 'tracker') { try { await notion('PATCH', `/pages/${row.id}`, { properties: { 'Post Caption': { rich_text: [{ type: 'text', text: { content: `Hashtags the brand asked for: ${String(x.feedback).slice(0, 1800)}` } }] } } }); } catch { /* the card note below still carries it */ } }
        await patchDeal(deal, (set) => set('Next Action', 'Post the video with the brand\'s hashtags, then send the live link')).catch(() => {});
        await say('#️⃣', `${who} · hashtags for the post`, [x.feedback, 'Caption only: the video is not sent back to the editor'], 'log', deal.linkedVideo || deal.url);
        did = 'Hashtags for the post noted on the card (caption only, no editor changes)';
        break;
      } else if (x.feedback) {
        // The brand's own words, or the summary when there are none: both together showed every note twice (Topview AI x Lindsay round 2, Nov 25)
        const fb = [x.approved_after_changes ? 'Brand is happy with the video apart from this change:' : null, ...(x.feedback ? [x.feedback] : asList(x.summary))].filter(Boolean);
        // Several videos on this deal (ZEN UGC 1, 2, 3) and notes per video in the email: each row gets its own notes
        const all = await findIntakeRows(deal).catch(() => []);
        const parts = all.length > 1 ? notesPerVideo(latestText(email.text || ''), all) : null;
        if (parts) {
          // A section the brand approved goes to To Post with its posting notes (hashtags, links) as the Post Caption;
          // only the sections with changes go back to their own editor
          for (const { row: r, lines, approved } of parts) {
            if (approved) {
              await setIntake(r, 'To Post', { note: lines.join('\n') });
              if (r.source === 'tracker') await notion('PATCH', `/pages/${r.id}`, { properties: { 'Post Caption': { rich_text: [{ type: 'text', text: { content: lines.join('\n').slice(0, 1900) } }] } } }).catch(() => {});
            } else await setIntake(r, 'Changes', { feedback: lines, bumpRevision: true, images: email.attachments });
          }
          const changed = parts.filter((p) => !p.approved);
          row = (changed[0] || parts[0]).row; row.title = changed.map((p) => p.row.title).join(', ') || row.title;
        } else if (row) await setIntake(row, 'Changes', { feedback: fb, bumpRevision: true, images: email.attachments });
        const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 8) : null;
        if (row) await say('🎬', `${who} · brand changes sent to ${row.editor || 'the editor'}`, [x.feedback, st ? `Card moved to ${st}` : null], 'log', row.url);
        else await discord(`🎬 ` + card(`${who} · brand wants changes, but I couldn't find the video in Video Intake`, [x.feedback, 'Pass this to the editor']), 'pm');
      } else {
        await say('🎬', `${who} · brand is reviewing the video`, pts, 'log', deal.linkedVideo || deal.url);
      }
      // Round 2 and later: the n8n watcher stays silent, so the editor's thread gets the changes right now
      if (!x.video_approved && x.feedback && row && (row.revisions || 0) >= 1) { try { const E = await import('./editorthreads.js'); await E.postFeedbackToThreads(); } catch (e) { console.error('editor feedback post', e.message); } }
      did = x.video_approved ? (row ? 'Deal Approved, Video Intake set to To Post' : 'Deal Approved, NOT found in Video Intake (asked Harsh)') : x.feedback ? (row ? `Brand changes sent to ${row.editor || 'the editor'} (Video Intake ${row.title} set to Changes)` : 'Brand changes NOT sent: no Video Intake row found (asked Harsh in #pm)') : 'Brand is reviewing, noted on the video';
      // The brand hears straight away that its notes are with the editor (Harsh, Nov 19: Manyfast x Chris sent caption and
      // screen-time fixes and nobody answered). Fixed wording; a question in the same email (a new publish date) still
      // waits for Harsh, and the email stays unread for it.
      if (!x.video_approved && x.feedback && row && fromBrand) {
        try { did += ` · ${await templateReply(email, deal, { ...x, template: 'video_changes_ack' })}`; } catch (e) { did += ` · fixed reply failed: ${String(e.message).slice(0, 80)}`; }
      }
      break;
    }
    case 'invoice_from_creator': {
      // Creators send their own invoices. If this one went to the brand (noocapcollab only CC'd), just record it.
      const toBrand = deal.brandEmail && `${email.to || ''} ${email.cc || ''}`.toLowerCase().includes(String(deal.brandEmail).toLowerCase());
      if (toBrand) {
        await patchDeal(deal, (set) => { common(set); set('Deal Stage', 'Invoiced'); set('Invoice Sent Date', todayIST()); if (x.amount) set('Invoice Amount', x.amount); set('Next Action', 'Waiting for payment'); });
        let rev = '';
        try { rev = await markRevenueInvoiced(deal, x); } catch (e) { rev = 'revenue not updated: ' + String(e.message).slice(0, 120); }
        await say('🧾', `${who} · invoice sent ${money(x.amount || deal.invoiceAmount, x.currency) || ''}`.trim(), [`${deal.creator} invoiced the brand, I'll chase payment at 7, 14 and 21 days`], 'log');
        did = 'Invoice recorded as sent, ' + rev;
        break;
      }
      const uploads = [];
      for (const a of (email.attachments || []).slice(0, 2)) {
        const fid = await uploadToNotion(a);
        if (fid) uploads.push({ type: 'file_upload', file_upload: { id: fid }, name: a.filename || 'Invoice.pdf' });
      }
      const schema = await schemaOf(DS.deals);
      const p = {};
      if (uploads.length && schema['Invoice File']) p['Invoice File'] = { files: uploads };
      setIf(schema, p, 'Invoice Amount', x.amount);
      setIf(schema, p, 'Next Action', 'Approve the invoice email to the brand');
      if (Object.keys(p).length) await notion('PATCH', `/pages/${deal.id}`, { properties: p });
      const mail = await writeEmail({ kind: 'Invoice', deal, facts: { amount: money(x.amount || deal.invoiceAmount || deal.finalRate, x.currency), deliverables: deal.deliverables, posted_links: deal.postedLinks } });
      const d = await createDraft({ kind: 'Invoice', deal, subject: mail.subject, body: mail.body, attach: uploads.length ? 'Invoice' : 'None', video: deal.linkedVideo, why: `${deal.creator} sent the invoice${uploads.length ? '' : ' (⚠️ no attachment found, attach it in Notion first)'}` });
      did = `Invoice saved to the deal, email drafted (${d.created ? 'waiting for approval' : d.reason})`;
      break;
    }
    case 'payment_confirmed': {
      if (paidAlready(deal)) { await patchDeal(deal, (set) => common(set)); did = 'Already marked Paid: recorded, no second alert'; break; } // see paidAlready
      let paidCheck = { known: false };
      // "We've already paid" with no receipt, screenshot or transfer reference is a claim, not a payment: nothing is
      // marked paid, and a reply asking for the payment confirmation waits for Harsh (Zeely via Mediacube, Nov 3)
      {
        const said = latestText(email.text || '');
        const hasProof = proofFilesOf(email).length > 0 || /\b(transaction|reference|ref\.?|utr|swift|txn|remittance|receipt)\b[\s#:no.]*[A-Z0-9][A-Z0-9-]{5,}/i.test(said) || /paypal|wise|payoneer/i.test(String(email.from || ''))
          // proof sent earlier in the deal counts too (Mediacube attached the transfer confirmation on 23 Oct), but only
          // proof for THIS invoice: dated on or after the Invoice Sent Date (system check, Nov 13: the Oct 23 proof of
          // Zeely's first half marked the second half Paid when Victoria only said "it was sent, could you check?")
          || earlierProof(deal.memory, deal.notes, deal.invoiceSent);
        // Every invoice goes through Stripe, so Stripe is the judge: an email can only say "we paid", Stripe says whether
        // the money arrived. Paid in Stripe = paid, whatever the email says. Not paid in Stripe (they paid some other way, or not yet) = ask for the transfer proof as before.
        let st = { known: false };
        try { const I = await import('./invoicing.js'); st = await I.stripeState(deal); } catch { /* fall back to the email */ }
        paidCheck = st;
        // The brand often answers in the OLD deal's thread about the NEW invoice (ElevenLabs x Duncan, Nov 19: Yulia wrote
        // "your invoice has been paid" in the October thread about November's invoice, which Stripe showed paid. The PM
        // matched the October deal, found no Stripe there, and nobody thanked her for 4 days). If this deal isn't paid in
        // Stripe but another deal of the same brand and creator is, that is the payment: thank them here, leave this deal
        // as it is, and tell Harsh which deal it was
        if (!(st.known && st.allPaid) && fromBrand && !hasProof) {
          const sib = await paidSiblingDeal(deal).catch(() => null);
          if (sib) {
            let thanks = '';
            try { thanks = await paymentThanks({ ...deal, threadId: email.threadId || deal.threadId }, email); } catch (e) { thanks = 'thank-you failed: ' + String(e.message).slice(0, 80); }
            await patchDeal(deal, (set) => common(set));
            await say('💸', `${who} · "paid" was about ${sib.invoiceNumber || "another deal of theirs"}`, [`Stripe shows that deal paid, so the brand was thanked in this thread (${thanks}). This deal (${deal.invoiceNumber || "its invoice"}) is NOT marked paid: check it separately.`], 'pm', deal.url);
            did = `Payment was for ${sib.invoiceNumber || "a sibling deal"} (paid in Stripe): ${thanks}; this deal left unpaid`;
            break;
          }
        }
        if (st.known && st.allPaid) { /* real money: carry on to the paid path below */ }
        else if (fromBrand && !hasProof) {
          await patchDeal(deal, (set) => { common(set); set('Next Action', 'Brand says it paid but sent no proof: waiting for their payment confirmation'); set('Next Action Date', new Date(Date.now() + 5.5 * 36e5 + 3 * 864e5).toISOString().slice(0, 10)); });
          const qs = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
          const here = { ...(email.threadId ? { ...deal, threadId: email.threadId, messageRfc: email.messageId || deal.messageRfc, threadSubject: threadSubject(email.subject) || deal.threadSubject } : deal), ...(qs && !creatorSide(qs) ? { brandEmail: qs } : {}) };
          if (!(await draftedFor(email, here.threadId))) {
            const mail = await writeEmail({ kind: 'Reply', deal: here, facts: { their_latest_message: said, ask: 'Thank them and ask them to share the payment confirmation (the bank transfer receipt or the transaction reference) so we can match it on our side. Do not say we have or have not received it.' } });
            { const d = await createDraft({ kind: 'Reply', deal: here, subject: mail.subject, body: mail.body, video: deal.linkedVideo, notify: false, why: `${deal.brand} says they paid, but no receipt or reference came with it. This asks for the payment proof. Sends on its own [template:payment_proof_ask]` });
            // Asking for the transfer reference never commits us to anything: it goes on its own (Harsh, Nov 26, Dreamina)
            if (d?.created && d.id) { try { const { autoSend } = await import('./outbox.js'); await autoSend(d.id); } catch (e) { console.error('payment proof ask send', e.message); } } }
          }
          await say('💸', `${who} · says it's paid, no proof attached`, ['Not marked paid. A reply asking for the payment confirmation is waiting for you.'], 'pm', deal.url);
          did = 'Payment claimed without proof: asked for confirmation, not marked paid';
          break;
        }
      }
      // Money before the video is live is an upfront / part payment: record it, but the deal stays open (marking it Paid
      // hid Gamut from Active brands and stopped every follow-up while the video still had to be made)
      let upfront = false;
      try {
        const v = await findDealVideo(deal);
        const st = v && !v.ambiguous ? parseInt(plain(Object.entries(v.properties || {}).find(([n]) => n.toLowerCase() === 'status')?.[1]) || '', 10) : NaN;
        upfront = Number.isFinite(st) && st < 12 && !['Posted', 'Invoiced'].includes(deal.stage);
        // No card (or two) to look at: a deal that hasn't been posted or invoiced yet can't be paid in full
        if (!Number.isFinite(st) && deal.stage && stageBefore(deal.stage, 'Posted')) upfront = true;
      } catch { if (deal.stage && stageBefore(deal.stage, 'Posted')) upfront = true; }
      if (upfront) await patchDeal(deal, (set) => { common(set); set('Agent Notes', `${deal.agentNotes ? deal.agentNotes + '\n' : ''}[${todayIST()}] Upfront payment received before the video was posted. Deal stays open.`.slice(-1900)); });
      else { const I = await import('./invoicing.js'); const na = I.paidNextAction(await I.creatorCut(deal.creator)); await patchDeal(deal, (set) => { common(set); set('Deal Stage', 'Paid'); set('Paid Date', todayIST()); set('Next Action', na); }); }
      let rev = '';
      const proof = proofFilesOf(email);
      const stripePaid = !!(paidCheck.known && paidCheck.allPaid);
      try { rev = await markRevenuePaid(deal, x, proof); } catch (e) { rev = 'revenue not updated: ' + String(e.message).slice(0, 120); }
      // A receipt counts as paid: the Stripe invoice is closed as paid outside Stripe so it stops reminding the brand
      if (proof.length && !upfront) { try { const I = await import('./invoicing.js'); const closed = await I.closeStripePaidOutside(deal); if (closed.length) rev += ` · Stripe invoice marked paid (outside Stripe)`; } catch { /* the deal is Paid either way */ } }
      if (proof.length) rev += ` · payment proof saved (${proof.length} file${proof.length > 1 ? 's' : ''})`;
      // The money landing goes to WhatsApp with the brand's proof attached
      try {
        const W = await import('./whatsapp.js');
        const amt = money(x.amount || deal.invoiceAmount || deal.finalRate, x.currency);
        const text = [`💸 *Paid: ${who}*${amt ? ` · ${amt}` : ''}`, (x.summary || [])[0] ? `• ${(x.summary || [])[0]}` : null, proof.length ? `Their payment proof is below, and it's saved on the revenue row too.` : stripePaid ? `Stripe shows the invoice paid.` : 'No proof attached to the email.', stripePaid ? 'Collect the NOOCAP cut once it lands in the account.' : 'Please check it has landed in the account, then collect the NOOCAP cut.'].filter(Boolean).join('\n');
        const r = await W.sendContract({ text, files: proof, label: 'payment proof' });
        rev += ` · WhatsApp (${r.sent} sent${r.queued ? `, ${r.queued} waiting` : ''})`;
      } catch (e) { rev += ' · WhatsApp failed: ' + String(e.message).slice(0, 80); }
      // Real money in: the brand gets the fixed thank-you in its thread straight away
      if (fromBrand && (stripePaid || proof.length)) { try { rev += ` · ${await paymentThanks(deal, email)}`; } catch (e) { rev += ' · thank-you failed: ' + String(e.message).slice(0, 80); } }
      await say('💸', `${who} · paid ${money(x.amount || deal.invoiceAmount, x.currency) || ''}`.trim(), [rev, 'Collect the NOOCAP cut'], 'log'); // the cut to collect shows in the 9am money digest
      did = (upfront ? 'Upfront payment recorded, deal kept open (video not posted yet); ' : 'Deal marked Paid; ') + rev;
      break;
    }
    default: { // brand_reply
      await patchDeal(deal, (set) => common(set));
      // A message that only needs one of the fixed replies (Harsh, Nov 17) gets it straight away, in the brand's thread
      const tpl = fromBrand && x.template ? await templateReply(email, deal, x).catch((e) => `Template ${x.template} not sent: ${String(e.message).slice(0, 120)}`) : '';
      if (tpl && /^Sent the fixed reply/.test(tpl)) {
        did = tpl;
      } else if (x.platform_submit && fromBrand) {
        // Rule 79: a platform's submission notice is Harsh's to act on in the platform; the row stays, no email, no editor ping
        await patchDeal(deal, (set) => set('Next Action', `Waiting on us: ${x.info_needed}`)).catch(() => {});
        await say('📤', `${who} · submit the cut on the platform`, [`The platform says: ${String(x.info_needed || '').replace(/^.*?notice: /, '').slice(0, 220)}`, 'Nothing was changed on the video and the editor was not pinged'], 'pm', deal.url).catch(() => {});
        did = 'Platform submission notice: Harsh told to submit the cut on the platform (row left as is, no editor ping)';
      } else if (x.needs_reply && fromBrand && await weRepliedAfter(email)) {
        did = 'Brand asked something, but a newer message in the thread already moved things on';
      } else if (x.needs_reply && fromBrand && await draftedFor(email, email.threadId || deal.threadId)) {
        did = 'Reply already waiting in Approvals';
      } else if (x.needs_reply && fromBrand && (x.needs_our_info || x.we_owe) && teamWorkOnly(x.info_needed || x.we_owe)) {
        // System check Nov 16 (Dreamina x Chris): a brand chasing work the team is making is not a Harsh ask, and not a
        // promise email either; the revised cut / script answers it when it is done
        did = `Brand is waiting on team work (${String(x.info_needed || x.we_owe).slice(0, 120)}): left to the editor/script flow, no WhatsApp ask`;
        // ...but the brand still hears back: the fixed timing reply goes out (CodeRabbit x Chris, Nov 17: Riya's "please
        // send the script over quickly" got nothing, because this branch came before the template step)
        { const key = x.template || templateForWork(x.info_needed || x.we_owe);
          if (key) {
            let r = '';
            try { r = await templateReply(email, deal, { ...x, template: key }); did += ` · ${r}`; } catch (e) { did += ` · fixed reply failed: ${String(e.message).slice(0, 80)}`; }
            // A promise already made and now chased: Harsh gives the date (Atoms x Lindsay, Nov 23)
            if (/already promised a time/.test(r)) {
              const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
              const need = `a date for ${String(x.info_needed || x.we_owe || 'the work they are chasing').slice(0, 120)} (we already promised a time in this thread and they are chasing it)`;
              try { const W = await import('./whatsapp.js'); await W.askForInfo({ dealId: deal.id, brand: deal.brand, creator: deal.creator, need, threadId: email.threadId || deal.threadId || '', messageRfc: email.messageId || deal.messageRfc || '', subject: threadSubject(email.subject) || deal.threadSubject || '', brandEmail: sender && !creatorSide(sender) ? sender : deal.brandEmail || '', theirMessage: latestText(email.text).slice(0, 1500) }); did += ' · asked Harsh for the date'; } catch (e) { console.error('WhatsApp info ask failed', e.message); }
            }
          } }
      } else if (x.needs_reply && fromBrand && (x.needs_our_info || x.we_owe) && (x.info_needed || x.we_owe)) {
        x.info_needed = x.info_needed || x.we_owe;
        // The answer needs something only we have (ad codes, analytics, an account email): ask Harsh first on WhatsApp
        // instead of paying the AI to draft an email that can't say anything useful. His answer becomes the draft.
        const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
        const ask = { dealId: deal.id, brand: deal.brand, creator: deal.creator, need: x.info_needed, threadId: email.threadId || deal.threadId || '', messageRfc: email.messageId || deal.messageRfc || '', subject: threadSubject(email.subject) || deal.threadSubject || '', brandEmail: sender && !creatorSide(sender) ? sender : deal.brandEmail || '', theirMessage: latestText(email.text).slice(0, 1500) };
        await patchDeal(deal, (set) => set('Next Action', `Waiting on us: ${x.info_needed}`)).catch(() => {});
        try { const W = await import('./whatsapp.js'); await W.askForInfo(ask); } catch (e) { console.error('WhatsApp info ask failed', e.message); }
        // Same mark the "we owe" sweep checks, so it does not ask Harsh a second time about this email (system check Nov 20)
        await log({ event: `Owed ask (inbox): ${deal.brand} × ${deal.creator || '?'}`.slice(0, 118), outcome: 'Alert', email, deal, details: `${owedMark(deal.id, istStamp(emailTime(email)))} · ${x.info_needed}`, area: 'Brand deals', creator: deal.creator }).catch(() => {});
        await say('🙋', `${who} · they need something from us`, [`They're asking for: ${x.info_needed}`, 'Reply on WhatsApp with it (swipe-reply to the question) and I\'ll draft the email with it'], 'pm', deal.url).catch(() => {});
        did = `Asked Harsh for: ${x.info_needed} (no email drafted yet) ${unreadTag(email, deal, x)}`;
      } else if (x.needs_reply && fromBrand) {
        // Harsh, Nov 17: no AI-written replies. When the brand needs an answer that no fixed reply covers, the email stays
        // unread in Gmail for him to answer himself, and his answer teaches the templates (learnFromOurReply)
        await say('📩', `${who} · needs your reply (left unread in Gmail)`, [(x.summary || [])[0] || email.subject].filter(Boolean), 'pm', deal.url).catch(() => {});
        did = `Left unread for Harsh to reply ${unreadTag(email, deal, x)}`;
      } else {
        await say('📨', `${who} · ${fromBrand ? 'brand replied' : x.from_role === 'creator' ? `${deal.creator || 'creator'} replied` : 'new message'}`, pts, 'log');
        did = 'Harsh notified';
      }
    }
  }
  // The brand asked us to hold the work ("pause the scripting until the brand confirms the clause"): mark the deal
  // "On hold (brand)" so no script or cut goes out, but keep the deal live so the heartbeat checks in on the 3/5/9
  // weekday schedule and the deal doesn't go cold. Any later brand email that isn't a hold lifts it.
  if (fromBrand && x.on_hold) {
    await patchDeal(deal, (set) => { set('Paused', false); set('Next Action', `On hold (brand): ${x.hold_reason || 'waiting for their go-ahead'}`); }).catch(() => {});
    await say('⏸️', `${who} · brand asked us to hold the work`, [x.hold_reason || (x.summary || [])[0], 'Nothing goes out to them until they confirm, but the PM keeps checking in so the deal stays warm'], 'pm', deal.linkedVideo || deal.url).catch(() => {});
    // The script writer only hears about a hold when there is work of his to pause: a video card exists (a brief was
    // sent to him). No brief yet = nothing to stop, so no ping (Emergent, Nov 4: "On hold" went to Rudraksh with no brief)
    if (holdPingsWriter(deal)) await discord(`${tag()} ⏸️ **On hold: ${who}**\nThe brand asked us to pause for now. Please don't continue until we hear back. I'll keep following up with them in the meantime.\nNotion: ${deal.linkedVideo}`).catch(() => {});
    did += ' · work on hold at the brand\'s request (follow-ups continue)';
  } else if (fromBrand && x.posting_hold) {
    // Only the posting waits: the card says so for whoever schedules it, the team keeps working, no one is told to stop.
    // The deal remembers it (Posting Hold) so the heartbeat warns if the card reaches To Post and checks in after a week.
    await patchDeal(deal, (set) => { set('Posting Hold', String(x.posting_hold).slice(0, 300)); if (!deal.postingHold) set('Posting Hold Since', todayIST()); }).catch(() => {});
    if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `⛔ Don't post yet ${todayIST()}`, [`The brand asked us not to publish until they confirm (${x.posting_hold}). Filming and editing carry on as normal.`]).catch(() => {});
    await say('📅', `${who} · posting waits for the brand`, [x.posting_hold, 'Work carries on; the video won\'t be posted until they confirm'], 'pm', deal.linkedVideo || deal.url).catch(() => {});
    did += ' · posting waits for the brand (work carries on)';
  }
  // The brand's instructions for posting and delivery go on the deal's cards so nobody misses them (Harsh, Nov 24: Mia's
  // CapCut checklist with the CTA, UTM links, 60-day ad code and "no other post within a day" was only in the email)
  if (fromBrand && Array.isArray(x.brand_notes) && x.brand_notes.length) {
    try { const n = await saveBrandNotes(deal, x.brand_notes); if (n) did += ` · ${n}`; } catch (e) { console.error('brand notes', e.message); }
  }
  if (x.also_video_approved && x.event !== 'video_feedback') {
    try { const r = await approveVideoToo(deal); if (r) { did += ` · ${r}`; await say('🎉', `${who} · video approved`, [r, deal.postingHold ? `Posting hold: ${String(deal.postingHold).slice(0, 120)}` : null], 'log', deal.url); } }
    catch (e) { console.error('video approval alongside', e.message); await discord(`⚠️ ` + card(`${who} · the brand approved a video in this email, but I couldn't move it to To Post`, [String(e.message).slice(0, 200), 'Set its EDIT TRACKER row to To Post']), 'pm').catch(() => {}); }
  }
  if (fromBrand && x.posting_cleared && deal.postingHold) {
    await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Posting Hold': { rich_text: [] }, 'Posting Hold Since': { date: null } } }).catch(() => {});
    if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `✅ Cleared to post ${todayIST()}`, ['The brand gave the go-ahead to publish.']).catch(() => {});
    await say('✅', `${who} · brand cleared the video for posting`, [(x.summary || [])[0]], 'pm', deal.linkedVideo || deal.url).catch(() => {});
    did += ' · posting hold lifted';
  }
  if (fromBrand && !x.on_hold && /^On hold \(brand\)/i.test(deal.nextAction || '')) {
    // An approval or notes after the hold already set the next step; only a plain reply needs "check their message"
    await patchDeal(deal, (set) => { set('Paused', false); if (!['script_approved', 'script_changes', 'video_feedback'].includes(x.event)) set('Next Action', 'Brand is back: check their message'); }).catch(() => {});
    await say('▶️', `${who} · brand is back after the hold`, [(x.summary || [])[0]], 'pm', deal.url).catch(() => {});
    did += ' · hold lifted';
  }
  // The brand set a deadline ("drafts by end of week"): put it on the deal and tell Harsh, whatever the email was about
  if (x.due_by && /^\d{4}-\d{2}-\d{2}$/.test(x.due_by) && fromBrand && x.due_by >= todayIST()) {
    await patchDeal(deal, (set) => { set('Deadline', x.due_by); set('Next Action Date', x.due_by); }).catch(() => {});
    const day = new Date(x.due_by + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    await say('⏰', `${who} · wants ${x.due_what || 'the next deliverable'} by ${day}`, [(x.summary || [])[0]], 'pm', deal.linkedVideo || deal.url).catch(() => {});
    did += ` · deadline ${x.due_by} (${x.due_what || 'deliverable'}) saved`;
  }
  // A brand question inside a script/video feedback email still gets a reply in Approvals. Change notes on their own
  // get no "thanks, we're on it" email: they go to the editor / script writer, and the brand hears back with the
  // revised cut or script (Harsh, Nov 3, ZenBusiness UGC notes)
  const hasNotes = String(x.feedback || '').trim().length > 10;
  // Video notes go to the editor and the brand hears back with the revised cut, never a reply draft, even when the AI
  // thinks the notes also ask us something (system check, Nov 4: replies were drafted right after the notes went to the
  // editor). A real question from the brand in those notes reaches Harsh once instead.
  const onlyNotes = (x.event === 'video_feedback' && hasNotes) || (x.event === 'script_changes' && hasNotes && !x.needs_our_info);
  if (fromBrand && x.event === 'video_feedback' && hasNotes && x.needs_our_info && x.needs_reply) {
    await say('🙋', `${who} · a question came with the video notes`, [(x.summary || []).find((l) => /\?/.test(l)) || (x.summary || [])[0] || 'Open the email to see what they asked'], 'pm', deal.linkedVideo || deal.url).catch(() => {});
    did += ' · question with the notes passed to Harsh';
  }
  if (fromBrand && x.needs_reply && !onlyNotes && feedbackNeedsHarsh(x) && !(await weRepliedAfter(email)) && !(await draftedFor(email, email.threadId || deal.threadId))) {
    // No AI reply before Harsh answers: those drafts were rejected almost every time (Harsh, Nov 20: "drafting mails of
    // no use"). He is asked on WhatsApp and his answer becomes the draft.
    const qSender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '';
    const ask = { dealId: deal.id, brand: deal.brand, creator: deal.creator, need: `an answer to: ${((x.summary || [])[0] || email.subject || '').slice(0, 200)}${x.due_by ? ` (wants ${x.due_what || 'it'} by ${x.due_by})` : ''}`, threadId: email.threadId || deal.threadId || '', messageRfc: email.messageId || deal.messageRfc || '', subject: threadSubject(email.subject) || deal.threadSubject || '', brandEmail: qSender && !creatorSide(qSender) ? qSender : deal.brandEmail || '', theirMessage: latestText(email.text).slice(0, 1500) };
    try { const W = await import('./whatsapp.js'); await W.askForInfo(ask); } catch (e) { console.error('question ask', e.message); }
    did += ' · question asked on WhatsApp';
  }
  did += await applyPromise(); // after the event so its Next Action isn't overwritten
  did += accessDid;
  clearCache();
  // Safety net: an ask in the brand's email that nothing above acted on goes to Harsh now, and the email stays unread
  if (fromBrand) {
    const missed = missedAsks(latestText(email.text || ''), x, did);
    if (missed.length) {
      await discord(`🔎 ` + card(`${who} · the brand's email has something I didn't act on`, [`They ${missed.join(', and they ')}.`, `I filed it as ${x.event.replace(/_/g, ' ')}: ${String(did).slice(0, 160)}`, 'Please check the email and handle this part, or tell me what to do']), 'pm', { now: true }).catch(() => {});
      did += ` · possibly missed: ${missed.join('; ')} [unread missed-ask]`;
    }
  }
  // Harsh, Nov 19: "if you're not replying, at least keep the mails unread so I know to whom to reply". A brand email
  // that asks something of us stays unread unless a reply actually went out or is waiting in Approvals (Luma x Chris:
  // "confirm you're ready to publish and your date" was filed as handled and marked read, nobody answered)
  if (fromBrand && !/\[unread /.test(did) && keepUnread(x, did)) did += ' [unread awaiting-reply]';
  await log({ event: `${x.event.replace(/_/g, ' ')}: ${who}`, outcome: 'Rule', email, x, deal, details: did, usage, cost, creator: deal.creator });
  // Left for Harsh: n8n labels it PM-seen but doesn't mark it read, so it stays unread in Gmail
  return { action: /\[unread /.test(did) ? 'needs_you' : 'handled', event: x.event, deal: deal.url, did };
}

// Re-send a brand's script notes to the script writer, exactly like the automatic "script changes" step:
// deal Next Action, video card back to Script Draft, note on the card (optional) and the Discord ping.
// Used when an email was filed the wrong way (e.g. notes that came with a brief link).
// The brand's newest open card (not posted or archived) on a creator's board, matched by brand name in the title.
async function findBrandCard(brand, creator) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = norm(brand).slice(0, 8); if (key.length < 3) return null;
  const boards = BOARDS.filter((b) => !creator || norm(b.creator) === norm(creator));
  const { allVideos } = await import('./tools.js');
  const { videos } = await allVideos();
  return videos.filter((v) => boards.some((b) => b.creator === v.creator) && norm(v.title).includes(key) && !['Posted', 'Archived'].includes(v.stage))
    .sort((a, b) => String(b.edited).localeCompare(String(a.edited)))[0] || null;
}
// A brand's video feedback the PM handled before images were passed along: when the same email comes round again
// (PM-seen label removed) with its screenshots, they go to the editor once. Only for video feedback, only once.
async function lateImages(email, deals) {
  const pics = (email.attachments || []).filter((a) => a.data && /^image\//i.test(a.mimeType || '') && Buffer.byteLength(a.data, 'base64') > 15000);
  if (!pics.length) return null;
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 10, filter: { property: 'Message ID', rich_text: { equals: String(email.messageId).slice(0, 1900) } } });
  const rows = r.results || [];
  const fb = rows.find((p) => /^video feedback/i.test(plain(p.properties?.Event) || ''));
  if (!fb || rows.some((p) => /^Late images/i.test(plain(p.properties?.Event) || ''))) return null;
  const deal = threadDeal(deals, email);
  const row = deal ? await findIntakeRow(deal).catch(() => null) : await findIntakeRowByBrand(String(plain(fb.properties?.Event) || '').replace(/^video feedback:\s*/i, '').split(' × ')[0]).catch(() => null);
  if (!row) return null;
  const day = new Date(Date.parse(email.date || Date.now()) + 5.5 * 36e5).toISOString().slice(0, 10);
  const urls = await addLateImages(row, pics, `from the brand's ${day} email`, plain(fb.properties?.Time) || fb.created_time);
  if (!urls.length) return null;
  const { postLateImages } = await import('./editorthreads.js');
  const posted = await postLateImages(row.id, urls, `🖼️ The brand's images from their ${day} email (sent with their earlier changes)`).catch(() => false);
  await log({ event: `Late images: ${email.subject || ''}`.slice(0, 120), outcome: 'Rule', email, deal, details: `${urls.length} image(s) added to ${row.title}${posted ? ' and posted to the editor' : ' (Discord thread not found)'}`, creator: deal?.creator });
  return `${urls.length} late image(s) ${posted ? 'sent to the editor' : 'saved on the video'}`;
}

// Split a brand's email into the notes for each video, using the video titles as headings ("Zen UGC 1", "Zen UGC 2").
// Returns null unless at least two videos are found, so a single-video email keeps the normal path.
// "Video 1:" / "**Video 2**" / "Reel 2 -" header lines, matched to the row with that number (CapCut x Lindsay, Nov 25:
// "Video 1: ... needs to be revised" and "Video 2: This video is approved" went as one set of changes to video 2's
// editor, and video 1's editor got nothing). Returns [{ number, i }] or [].
export function videoHeaders(lines) {
  const out = [];
  lines.forEach((l, i) => { const m = /^\s*[*_#]*\s*(?:video|reel|cut|draft)\s*#?\s*(\d{1,2})\s*[*_]*\s*[:\-–—]?\s*[*_]*\s*$/i.exec(l) || /^\s*[*_#]*\s*(?:video|reel)\s*#?\s*(\d{1,2})\s*[*_]*\s*[:\-–—]\s*/i.exec(l); if (m) out.push({ number: Number(m[1]), i, rest: l.slice(m[0].length).trim() }); });
  return out;
}
export const APPROVED_PART = /\b(is|are|has been|have been|now)\s+approved\b|\bapproved (for|to) (publication|post|publish|go live)|\bgood to (go|post)\b|\bready (to|for) (post|publish)/i;

export function notesPerVideo(text, rows) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*[×x]\s*\w+\s*$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const lines = String(text || '').split('\n');
  const keep = (l) => l && !/^(thanks|thank you|best|regards|cheers)\b/i.test(l) && (l.split(/\s+/).length >= 3 || /[\d:#]/.test(l));
  // Numbered sections first: each "Video N" header goes to the row whose title ends in that number (no number = 1).
  // A section ends at the next header or at a paragraph about something else ("Regarding the third video:")
  const heads = videoHeaders(lines);
  if (heads.length >= 1 && rows.length > 1) {
    const { videoNumber } = { videoNumber: (t) => { const m = String(t || '').match(/(?:\(\s*(\d{1,2})\s*\)|#\s*(\d{1,2})|\b(?:video|reel|part|v)\s*(\d{1,2})|\s(\d{1,2}))\s*$/i); return m ? Number(m[1] || m[2] || m[3] || m[4]) : 1; } };
    const parts = [];
    heads.forEach((h, k) => {
      const row = rows.find((r) => videoNumber(r.title) === h.number);
      if (!row) return;
      const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
      const body = [h.rest, ...lines.slice(h.i + 1, end)];
      const stop = body.findIndex((l, j) => j > 0 && /^\s*[*_]*\s*(regarding|about|as for|on another note|also,? (for|regarding))\b/i.test(l));
      const section = (stop > 0 ? body.slice(0, stop) : body).map((l) => String(l || '').replace(/^[\s•*\-–]+/, '').trim()).filter(keep).slice(0, 30);
      if (section.length) parts.push({ row, lines: section, approved: APPROVED_PART.test(section.join(' ')) });
    });
    if (parts.length) return parts;
  }
  const hits = [];
  for (const r of rows) {
    const t = norm(r.title);
    if (t.length < 3) continue;
    // "ZEN UGC 1" also matches a line that just says "UGC 1" (the brand drops its own name), never "UGC 11"
    const i = lines.findIndex((l) => { const n = norm(l); return n === t || (n.startsWith(t) && n.length <= t.length + 3) || (/\d/.test(n) && n.length >= 3 && n.length <= 12 && t.endsWith(' ' + n)); });
    if (i >= 0) hits.push({ row: r, i });
  }
  if (hits.length < 2) return null;
  hits.sort((a, b) => a.i - b.i);
  return hits.map((h, k) => ({ row: h.row, lines: lines.slice(h.i + 1, k + 1 < hits.length ? hits[k + 1].i : lines.length).map((l) => l.replace(/^[\s•*\-–]+/, '').trim()).filter((l) => l && !/^(thanks|thank you|best|regards|cheers)\b/i.test(l) && (l.split(/\s+/).length >= 3 || /[\d:]/.test(l))).slice(0, 30) })).filter((p) => p.lines.length);
}

// Notes on an EDITED CUT (timestamps, shots, the avatar, music, captions) belong to the editor, not the script writer
// (Harsh, Nov 13: Brad's PromoCut cut notes "at 5 seconds it cuts me off… the mountain shot… my avatar in the CTA"
// were sent to Rudraksh as Dreamina script changes).
export function looksLikeCutNotes(text = '') {
  const t = String(text);
  const cut = [
    /\b(at|around|by)\s*~?\d{1,3}(\.\d)?\s*(s|sec|secs|seconds?)\b/i, /\b\d{1,2}:\d{2}\b/, /\bcuts? (me |it |him |her )?off\b/i,
    /\b(shot|b-?roll|footage|clip|frame|transition|zoom|overlay|animation|jump ?cut|render|export)\b/i,
    /\bon (the )?(phone )?screen\b/i, /\bavatar\b/i, /\b(music|audio|sound|sfx|voice ?over)\b/i, /\b(captions?|subtitles?|text on screen|font)\b/i,
    /\b(the edit|edited|the cut|the video|draft video|the draft)\b/i,
  ].filter((r) => r.test(t)).length;
  const script = [/\bscript\b/i, /\b(reword|rewrite|wording|rephrase)\b/i, /\b(hook|line|sentence|paragraph) (should|could|needs?)\b/i, /\b(talking points?|key message|must.?mention)\b/i].filter((r) => r.test(t)).length;
  return cut >= 2 && cut > script * 2;
}

// Cut notes from WhatsApp or chat ("Brad x PromoCut changes" + the notes): the same hand-off as a brand's video
// feedback email. The Video Intake row goes to Changes with the notes (the editor bot pings the editor), the board card
// goes to 8- Changes and the notes land on the card. Nothing is sent to the brand.
export async function sendVideoChanges({ brand, creator, feedback, file = null }) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const deals = await openDeals();
  const deal = deals.find((d) => norm(d.brand).includes(norm(brand)) && (!creator || norm(d.creator) === norm(creator))) || { brand, creator, linkedVideo: null, id: null };
  const who = `${deal.brand} × ${deal.creator || creator || '?'}`;
  let row = deal.id ? await findIntakeRow(deal).catch(() => null) : null;
  if (!row) row = await findIntakeRowByBrand(brand, creator || deal.creator).catch(() => null);
  if (!row) throw new Error(`No open Video Intake row found for ${who}. Name the video as it is in Video Intake and I'll try again.`);
  const lines = String(feedback).split('\n').map((l) => l.trim()).filter(Boolean);
  // The image Harsh sent with the notes (a logo, a screenshot of the shot to fix) goes to the editor too: it lands under
  // the notes on the Video Intake row, and the editor's Discord thread posts it from there (Virash x Brad, Nov 18: the
  // logo to use was forwarded with the notes, only the words reached Prateek)
  let images = [];
  if (file?.mediaId) {
    try { const W = await import('./whatsapp.js'); const got = await W.downloadMedia(file.mediaId); if (/^image\//i.test(got.mimeType || file.mime || '')) images = [{ filename: file.filename, mimeType: got.mimeType || file.mime, data: got.data, keep: true }]; } catch (e) { console.error('video changes image', e.message); }
  }
  await setIntake(row, 'Changes', { feedback: lines, bumpRevision: true, images });
  if (images.length) { try { const E = await import('./editorthreads.js'); await E.postImageToEditor(row.id, images[0], `🖼️ **${who}**: image sent with the changes (use this one)`); } catch (e) { console.error('editor image', e.message); } }
  if (images.length && deal.linkedVideo) { try { const { uploadToNotion } = await import('./briefs.js'); const id = await uploadToNotion(images[0]); const vid = (String(deal.linkedVideo).match(/[0-9a-f]{32}/i) || [])[0]; if (id && vid) await notion('PATCH', `/blocks/${vid}/children`, { children: [{ object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id } } }] }); } catch { /* the editor still gets it from the intake row */ } }
  if (deal.id) await patchDeal(deal, (set) => set('Next Action', 'Editor making the changes')).catch(() => {});
  const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 8).catch(() => null) : null;
  if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Changes on the video ${todayIST()}`, lines).catch(() => {});
  await discord(`🎬 **${who} · video changes sent to ${row.editor || 'the editor'}**\n• ${lines[0]?.slice(0, 220) || ''}`, 'log').catch(() => {});
  await log({ event: `Video changes sent to editor: ${who}`, outcome: 'Rule', email: { messageId: '' }, deal: deal.id ? deal : null, details: String(feedback).slice(0, 500), creator: deal.creator || creator });
  return { ok: true, deal: who, row: row.title, editor: row.editor || null, video: st, image_sent: images.length > 0 };
}

// Which card the script-writer hand-off lands on. A flag picked on a card ("Send to Script Writer") belongs to THAT card,
// never to the deal's first linked video: CapCut x Chris, Nov 15, "Brief changed" on cards (2) and (3) moved video 1's
// card (its cut with the brand) from 9- Approval back to 4- Script Draft, wrote both briefs onto it and set the deal to
// "Rudraksh revising the script" while video 1 waited on Mia. The deal's Next Action only changes for its own video.
export function scriptPingTarget(deal, videoUrl) {
  const id = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase()
    || (String(u || '').match(/[0-9a-f-]{36}/i) || [''])[0].replace(/-/g, '').toLowerCase();
  const target = videoUrl || deal?.linkedVideo || null;
  const ownVideo = !videoUrl || !deal?.linkedVideo || id(videoUrl) === id(deal.linkedVideo);
  return { target, touchDeal: ownVideo };
}

export async function resendScriptChanges({ brand, creator, feedback, addNote = true, title = 'Script changes requested', videoUrl = null }) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const deals = await openDeals();
  let deal = deals.find((d) => norm(d.brand).includes(norm(brand)) && (!creator || norm(d.creator) === norm(creator)));
  let cardOnly = false;
  if (!deal) {
    // No deal row (a WhatsApp deal that never got one, say): fall back to the brand's card on the creator's board
    const v = await findBrandCard(brand, creator);
    if (!v) throw new Error(`No open deal or video card found for ${brand}${creator ? ' × ' + creator : ''}`);
    deal = { brand, creator: v.creator, linkedVideo: v.url, id: null }; cardOnly = true;
  }
  const who = `${deal.brand} × ${deal.creator || '?'}`;
  const { target, touchDeal } = scriptPingTarget(deal, videoUrl);
  if (!cardOnly && touchDeal) await patchDeal(deal, (set) => set('Next Action', 'Rudraksh revising the script'));
  const st = target ? await setVideoStatus(target, SCRIPT_CHANGES).catch(() => null) : null;
  if (target) await markScriptChanges(target, deal.id ? deal : null).catch(() => {});
  if (addNote && target) await addNoteToVideo(target, `📋 ${title === 'Script changes requested' ? 'Brand feedback on the script' : title} ${todayIST()}`, String(feedback).split('\n'));
  const ok = await discord(`${tag()} ✏️ **${title}: ${who}**\n${String(feedback).slice(0, 900)}${target ? '\nNotion: ' + target : ''}`);
  // and Harsh / Pratham hear about it (WhatsApp picks up ✏️ updates)
  await discord(`✏️ **${who} · script changes sent to Rudraksh**\n• ${String(feedback).split('\n')[0].slice(0, 220)}${ok ? '' : '\n• ⚠️ the Discord ping to Rudraksh failed, the notes are on the video card'}`, 'log').catch(() => {});
  await log({ event: `Script changes re-sent: ${who}`, outcome: 'Rule', email: { messageId: '' }, deal: cardOnly ? null : deal, details: String(feedback).slice(0, 500), creator: deal.creator });
  return { ok, deal: who, video: st };
}

// "I'm attaching the script with comments from the advertiser: <doc link>" → the feedback for the script writer.
// Only for the brand's own latest message, with a doc link in it, about a script, mentioning comments/notes/edits.
function scriptCommentsDoc(email, x) {
  if (x.from_role && x.from_role !== 'brand') return null;
  if (!['brand_reply', 'script_approved', 'script_changes'].includes(x.event)) return null;
  const latest = latestText(email.text || '');
  const docs = (latest.match(LINK_RE) || []).filter((u) => DOC_LINK.test(u));
  if (!docs.length) return null;
  if (!/\bscript/i.test(latest)) return null;
  if (!/\b(comments?|commented|notes?|feedback|edits?|suggestions?|changes|revisions?|tweaks?)\b/i.test(latest)) return null;
  // "Keep this note in mind when creating the video, you can now move forward": approved, the doc is a filming note
  if (goAheadToVideo(latest)) { x.filming_notes = [String(x.filming_notes || '').trim(), `Brand's note in this doc, keep it in mind when filming and editing: ${docs[0]}`].filter(Boolean).join('\n'); return null; }
  if (x.event === 'script_changes' && String(x.feedback || '').length > 40 && docs.some((u) => String(x.feedback).includes(u))) return null;
  const film = /\b(start|begin|go ahead( and)?|proceed( with)?)\s+(the\s+)?(film|shoot|record)/i.test(latest);
  return [
    `The brand left comments on the script in this doc: ${docs[0]}`,
    String(x.feedback || '').trim() || null,
    film ? 'They say filming can start once the comments are applied.' : null,
  ].filter(Boolean).join('\n');
}

// Script notes waiting to go to the script writer: an Agent Log row titled "Queued: script notes · Brand × Creator"
// with the notes in Details. The heartbeat sends each one once (same as the inbox's own script-changes step) and
// renames the row, so an email the inbox filed the wrong way can still reach Rudraksh through the automation.
export async function runScriptNotesQueue() {
  const res = await notion('POST', `/data_sources/4215bfda-0191-4e77-a40b-4c2d8b6e0d70/query`, { page_size: 10, filter: { property: 'Event', title: { starts_with: 'Queued: script notes' } } }).catch(() => ({ results: [] }));
  const done = [];
  for (const p of (res.results || []).filter((x) => !x.in_trash)) {
    const event = plain(p.properties?.Event) || '';
    const details = plain(p.properties?.Details) || '';
    const m = event.match(/·\s*(.+?)\s*×\s*(.+)$/);
    const rename = (t) => notion('PATCH', `/pages/${p.id}`, { properties: { Event: { title: [{ type: 'text', text: { content: t.slice(0, 120) } }] } } }).catch(() => {});
    if (!m || !details.trim()) { await rename(event.replace(/^Queued/, 'Queue skipped (needs "· Brand × Creator" and notes)')); continue; }
    // Claim it first so two overlapping runs can't both send it
    await rename(event.replace(/^Queued/, 'Sending'));
    try {
      const r = await resendScriptChanges({ brand: m[1], creator: m[2], feedback: details });
      await rename(`Script notes sent to Rudraksh · ${r.deal}${r.ok ? '' : ' (Discord ping failed)'}`);
      done.push(r.deal);
    } catch (e) {
      await rename(`Queue failed: script notes · ${m[1]} × ${m[2]} (${String(e.message).slice(0, 60)})`);
    }
  }
  return done;
}


// A brief Harsh hands over by hand (a brief link in chat, not a brand email): an Agent Log row titled
// "Queued: brief · Brand × Creator" with the message for the script writer in Details. The heartbeat posts it to
// #brand-scripts once, tagging Rudraksh, and renames the row (Higgsfield × Lindsay, Nov 7). The money hard stop in
// discord() applies as for every script-writer ping.
export async function runBriefQueue() {
  const res = await notion('POST', `/data_sources/4215bfda-0191-4e77-a40b-4c2d8b6e0d70/query`, { page_size: 10, filter: { property: 'Event', title: { starts_with: 'Queued: brief' } } }).catch(() => ({ results: [] }));
  const done = [];
  for (const p of (res.results || []).filter((x) => !x.in_trash)) {
    const event = plain(p.properties?.Event) || '';
    // Page mentions (Notion turns a pasted card link into one) keep their link, not just the page title
    const details = (p.properties?.Details?.rich_text || []).map((t) => (t.type === 'mention' && t.href ? t.href : t.plain_text || '')).join('');
    const m = event.match(/·\s*(.+?)\s*×\s*(.+)$/);
    const rename = (t) => notion('PATCH', `/pages/${p.id}`, { properties: { Event: { title: [{ type: 'text', text: { content: t.slice(0, 120) } }] } } }).catch(() => {});
    if (!m || !details.trim()) { await rename(event.replace(/^Queued/, 'Queue skipped (needs "· Brand × Creator" and a message)')); continue; }
    // The card it names was already announced (the new-card check got there first): one ping is enough
    const cardId = (details.match(/[0-9a-f]{32}/i) || [])[0];
    if (cardId) {
      const seen = await notion('POST', `/data_sources/4215bfda-0191-4e77-a40b-4c2d8b6e0d70/query`, { page_size: 1, filter: { and: [{ property: 'Details', rich_text: { contains: cardId } }, { or: [{ property: 'Event', title: { starts_with: 'Writer pinged' } }, { property: 'Event', title: { starts_with: 'Brief filed' } }] }] } }).catch(() => ({ results: [] }));
      if ((seen.results || []).length) { await rename(`Brief not sent again (card already announced) · ${m[1]} × ${m[2]}`); continue; }
    }
    await rename(event.replace(/^Queued/, 'Sending'));
    const ok = await discord(`${tag()} 📝 **New brand deal: ${m[1]} × ${m[2]}**\n${details.slice(0, 1700)}`).catch(() => false);
    await rename(`Brief sent to Rudraksh · ${m[1]} × ${m[2]}${ok ? '' : ' (Discord ping FAILED)'}`);
    done.push(`${m[1]} × ${m[2]}`);
  }
  return done;
}

// After the brand approves the script, ask them to give access to their tool on our filming account (Harsh, Nov 7).
// A plain template (no AI), one per deal, in the brand's thread; it sends itself after the usual hold.
export const TOOL_ACCESS_EMAIL = 'noocaptools@gmail.com';
export function toolAccessBody({ firstName, brand, creator, points = false }) {
  return `Hi ${firstName || 'there'},\n\nThanks for approving the script, we'll move ahead with filming${points ? ' and take care of all the points you listed' : ''}. To record the demo, could you please give access to ${brand || 'the tool'} on ${TOOL_ACCESS_EMAIL}? That's the account we'll use for this video. Please let us know once the access has been given.\n\nBest,\n${creator || 'The'}'s Team`;
}
// Deal memory or the email shows the brand already shared a login / trial account with us
export function brandGaveAccount(memory, text = '') {
  const m = String(memory || ''), t = String(text || '');
  return /\b(trial|demo|test|creator)\s+account\b|\btrial (details|access)\b|\b(sent|shared|gave|provided|created)\b[^.\n]{0,40}\b(login|credentials|account access)\b/i.test(m)
    || /\bpassword\s*[:=]\s*\S+/i.test(t);
}
// Name to greet: the From display name when it is in Latin letters, else the name the brand signs with
// ("이승주" <konan@…> signs "Seungjoo Lee (Konan)", Nov 16), else none
export function greetingName(from, text = '') {
  const display = String(from || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  const name = display.split(/\s+/)[0] || '';
  // Family name first: "Lim Su Wern" signs "Su Wern", so the tool-access email greeted her "Hi Lim" (Topview AI x
  // Lindsay, system check Nov 21). When the sign-off name sits inside the From name but not at its start, use it.
  const signed = (String(text || '').match(/\n\s*(?:best|thanks|regards|cheers|best regards|kind regards|thank you)[^\n]*,?\s*\n\s*([A-Z][a-z'-]{1,20}(?: [A-Z][a-z'-]{1,20})?)\s*(?:\n|$)/i) || [])[1] || '';
  if (signed && name && display.toLowerCase().includes(signed.toLowerCase()) && !display.toLowerCase().startsWith(signed.toLowerCase())) return signed;
  if (name && !/@/.test(name) && /^[A-Za-z][A-Za-z'.-]*$/.test(name)) return name;
  const sig = String(text || '').match(/\n\s*(?:best|thanks|regards|cheers|best regards|kind regards|thank you)[^\n]*,?\s*\n\s*([A-Z][a-z'-]{1,20})\b/i);
  return sig ? sig[1] : '';
}
// The conversation already has a tool-access round: our email naming noocaptools@gmail.com (any earlier campaign in the
// same thread counts, the account stays on). Emergent x Chris, Nov 16: Naman answered 'yes added' on Aug 6 and the PM asked
// again after the November script approval (rejected by the afternoon check).
export function accessAlreadyAsked(history) {
  const blocks = String(history || '').split(/(?=📨 )/);
  return blocks.some((b) => /^📨 [^\n]*·\s*(us \(NOOCAP\)|[A-Za-z]+'s team)\s*·/.test(b) && /noocaptools@gmail\.com/i.test(b));
}
// The tool-access email answers the approval email itself. The deal in hand still carries the Message-ID from before
// that email was read, so the draft replied to Su Wern's first email of Nov 20 instead of her Nov 21 approval with the
// agreement (Topview AI x Lindsay, system check Nov 21). Same thread: reply to the email being handled. Pure.
export function toolAccessDeal(deal, email) {
  if (!email?.messageId || (email.threadId && deal?.threadId && email.threadId !== deal.threadId)) return deal;
  return { ...deal, messageRfc: email.messageId };
}
export async function askToolAccess(deal, email, { points = false } = {}) {
  if (!deal?.id || !deal.threadId || deal.channel === 'WhatsApp') return null;
  const done = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: deal.id } }, { property: 'Kind', select: { equals: 'Tool access' } }] } }).catch(() => ({ results: [] }));
  if ((done.results || []).length) return null;
  // The brand already handed us an account (Manyfast x Chris, Nov 16: a trial login sent twice, then 'please give access
  // on noocaptools' was drafted anyway): no tool-access ask
  if (brandGaveAccount(deal.memory, email?.text || email?.body || '')) return null;
  if (accessAlreadyAsked(await readTranscript(deal.id, 60000).catch(() => ''))) return null;
  const firstName = greetingName(email?.from, email?.text || email?.body || '');
  return createDraft({ kind: 'Tool access', deal: toolAccessDeal(deal, email), subject: `Re: ${deal.threadSubject || email?.subject || ''}`.replace(/^Re:\s*Re:/i, 'Re:'), body: toolAccessBody({ firstName, brand: deal.brand, creator: deal.creator, points }), notify: false, why: `Script approved: asking ${deal.brand} for access to their tool on ${TOOL_ACCESS_EMAIL}. Sends on its own in 30 min unless you reject it.` });
}

// Re-send the last image someone sent the PM on WhatsApp (last 24 hours) to the editor of a deal's video, without
// touching the notes (they already went). Hook only: ?editorimage=1&brand=..&creator=..
export async function resendEditorImage({ brand, creator, dry = false }) {
  const W = await import('./whatsapp.js');
  let pick = null;
  for (const person of W.people()) {
    const st = await W.loadState(person, { fresh: true });
    const m = [...(st.messages || [])].reverse().find((x) => x.role === 'user' && x.file?.mediaId && Date.now() - Date.parse(x.at) < 864e5);
    if (m && (!pick || Date.parse(m.at) > Date.parse(pick.at))) pick = m;
  }
  if (!pick) throw new Error('No image sent on WhatsApp in the last 24 hours');
  if (dry) return { dry: true, file: pick.file.filename, mime: pick.file.mime, sentAt: pick.at, caption: String(pick.content || '').slice(0, 200) };
  const got = await W.downloadMedia(pick.file.mediaId);
  const img = { filename: pick.file.filename, mimeType: got.mimeType || pick.file.mime, data: got.data, keep: true };
  const deal = (await openDeals()).find((d) => String(d.brand).toLowerCase().includes(String(brand).toLowerCase()) && (!creator || String(d.creator).toLowerCase() === String(creator).toLowerCase())) || { brand, creator };
  let row = deal.id ? await findIntakeRow(deal).catch(() => null) : null;
  if (!row) row = await findIntakeRowByBrand(brand, creator || deal.creator).catch(() => null);
  if (!row) throw new Error(`No Video Intake row for ${brand} x ${creator || '?'}`);
  const E = await import('./editorthreads.js');
  const posted = await E.postImageToEditor(row.id, img, `🖼️ **${deal.brand} × ${deal.creator || creator}**: the logo/image that goes with the changes above (use this one)`);
  const { uploadToNotion } = await import('./briefs.js');
  const id = await uploadToNotion(img).catch(() => null);
  if (id) await notion('PATCH', `/blocks/${row.id}/children`, { children: [{ object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id } } }] }).catch(() => {});
  return { posted, row: row.title, editor: row.editor || null, file: pick.file.filename, sentAt: pick.at, caption: String(pick.content || '').slice(0, 120) };
}
