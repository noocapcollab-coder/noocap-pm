// PM · Inbox brain. Every new noocapcollab email lands here (from n8n).
// Code filters obvious noise, Haiku reads the rest, then the right deal / video / outbox action happens.
import { billingEmailIn, withBillingEmail } from './invoicing.js';
import { notion, plain, clearCache, queryAll } from './notion.js';
import { BOARDS, DS, todayIST, istStamp } from './tools.js';
import { schemaOf, findProp, CREATOR_KEY } from './actions.js';
import { claude, HAIKU, costOf } from './claude.js';
import { openDeals, threadCcFrom, readDocLink, alreadyHandled, fileBrief, sameDealParty,uploadToNotion, setIf, discord, card, log, tag, LINK_RE, DOC_LINK, noMoneyList, noMoney } from './briefs.js';
import { createDraft, writeEmail, stageBefore, STAGES, OUTBOX_DS, pendingDraft } from './outbox.js';
import { findIntakeRow, findIntakeRows, findIntakeRowByBrand, setIntake, addLateImages } from './intake.js';
import { threadSubject } from './mime.js';
import { contactOf, handles, learnContact } from './contacts.js';
import { rememberEmail } from './memory.js';
import { CREATOR_DOMAINS } from './creatordomains.js';

const lc = (s) => String(s ?? '').toLowerCase().trim();
const ROSTER = BOARDS.map((b) => b.creator);
const pageIdFromUrl = (u) => (String(u || '').match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1] || null;
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
export function isPaymentClaimed(text = '') {
  const t = String(text);
  const done = /\b(has (already )?been paid|(we|i)('ve| have)? (already |just )*(sent|paid|transferred|wired|made) (the |your |our )?(payment|invoice|advance|transfer|money|deposit|\d+%)|(we|i)('ve| have) (already |just )*paid\b|payment[^.?!\n]{0,30}\b(has (already )?been|was) (sent|made|completed|processed|done)|payment (sent|made|completed|done)\b|paid today|transfer(red)? (today|yesterday))/i.test(t);
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
    },
    required: ['event', 'confidence', 'reason', 'from_role', 'brand', 'creator', 'deal_number', 'summary', 'needs_reply'],
  },
};

export async function readEmail(email, deals, docText) {
  const dealList = deals.map((d, i) => `${i + 1}. ${d.brand} | creator: ${d.creator || '?'} | stage: ${d.stage || '?'} | video card: ${d.linkedVideo ? 'yes' : 'no'}${d.brandEmail ? ' | brand email: ' + d.brandEmail : ''}`).join('\n') || '(no open deals)';
  const content = [];
  // PDFs go in as their text only (see pdftext.js): far cheaper than sending the file itself
  const pdfs = await (await import('./pdftext.js')).attachmentText(email.attachments);
  // The whole earlier conversation of the deal this thread belongs to, word for word, so the email is read in context
  const likely = threadDeal(deals, email);
  // 10k characters of the conversation (was 16k): older background now comes from the brand wiki (Nov 12 cost review)
  const convo = likely ? await (await import('./memory.js')).readTranscript(likely.id, 10000).catch(() => '') : '';
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
Attachments: ${(email.attachments || []).map((a) => a.filename).join(', ') || 'none'}

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
    tools: [READ_TOOL],
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
  const opt = opts.find((o) => parseInt(o.name, 10) === statusNumber);
  if (!opt) return null;
  await notion('PATCH', `/pages/${id}`, { properties: { [found[0]]: found[1].type === 'status' ? { status: { name: opt.name } } : { select: { name: opt.name } } } });
  return opt.name;
}

async function addNoteToVideo(videoUrl, label, lines) {
  const id = pageIdFromUrl(videoUrl);
  if (!id) return;
  const kids = noMoneyList(lines).slice(0, 60).map((l) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: String(l).slice(0, 1900) } }] } }));
  await notion('PATCH', `/blocks/${id}/children`, { children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: label } }], children: kids.length ? kids : [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }] } }] });
}

function openDealShape(p) {
  const get = (n) => plain(p.properties?.[n]);
  return { id: p.id, url: p.url, brand: get('Brand Name') || 'Untitled', creator: get('Creator'), stage: get('Deal Stage'), brandEmail: creatorSide(get('Brand Email')) ? null : get('Brand Email'), linkedVideo: get('Linked Video'), threadId: get('Thread ID'), messageRfc: get('Message ID'), threadSubject: get('Thread Subject'), threadCc: get('Thread CC') || '', agentNotes: get('Agent Notes') || '', finalRate: get('Final Rate USD'), invoiceAmount: get('Invoice Amount'), followUps: Number(get('Follow-ups Sent') || 0), deliverables: get('Deliverables'), postedLinks: get('Posted Links'), needsCheck: get('Needs Check') === true, paused: get('Paused') === true, nextAction: get('Next Action') || '', memory: get('Deal Memory') || '', notes: get('Notes') || '', postingHold: get('Posting Hold') || '' };
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
export const proofFilesOf = (email) => (email.attachments || []).filter((a) => a.data && ((/^image\//i.test(a.mimeType || '') && Buffer.byteLength(a.data, 'base64') > 15000) || /pdf/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || ''))).slice(0, 4);
async function proofProp(files) {
  const out = [];
  for (const f of files || []) { const id = await uploadToNotion(f).catch(() => null); if (id) out.push({ type: 'file_upload', file_upload: { id }, name: String(f.filename || 'payment-proof').slice(0, 90) }); }
  return out.length ? { 'Payment Proof': { files: out } } : {};
}
async function markRevenuePaid(deal, x, proof = []) {
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
  const cut = lines.findIndex((l) => /^\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From:\s.+|Sent from my|>)/i.test(l));
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
  return { handed, promised: handed ? (promised || []).filter((p) => !/\bscripts?\b/i.test(String(p))) : (promised || []) };
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

// The creator's team handing a thread to NOOCAP: noocapcollab is on the email and the text asks to add or loop us in
export function isHandover(email, x) {
  if (!x || x.from_role !== 'creator' || !x.brand) return false;
  const onIt = /noocapcollab@/i.test(`${email.to || ''} ${email.cc || ''}`);
  const ask = /(add|adding|loop(ing)? in|cc(ing)?|copy(ing)?|include|including)\b[^.\n]{0,40}noocapcollab|take over|taking over|handl(e|ing) (it|this|the collab)|will handle|(my|our) (team|manager|management) (will|is)/i.test(latestText(email.text));
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
async function ourAsk(text, deal) {
  const t = String(text || '').trim().slice(0, 2500);
  if (!t) return null;
  try {
    const out = await claude({ _job: 'inbox-ours', model: HAIKU, max_tokens: 120, tools: [{ name: 'ask', description: 'What this email from us leaves us waiting on the brand for', input_schema: { type: 'object', properties: {
      waiting_for: { type: ['string', 'null'], description: `If our email asks ${deal.brand} to approve, answer, decide or send something before we can move on, a short phrase naming who and what, e.g. "Iddo to approve the topic" or "the brand to send the contract". A follow-up chasing an earlier ask names that earlier ask. null if we only shared an update, thanked them, or delivered something with nothing asked.` },
    }, required: ['waiting_for'] } }], tool_choice: { type: 'tool', name: 'ask' },
      messages: [{ role: 'user', content: `Our email to ${deal.brand} (latest message only):\n\n${t}` }] });
    const w = out.content?.find((c) => c.type === 'tool_use')?.input?.waiting_for;
    return w && String(w).trim() ? String(w).trim().replace(/^waiting (for|on)\s+/i, '').slice(0, 160) : null;
  } catch { return null; }
}

// Our email makes the waiting drafts in its thread stale. One written by hand answers whatever was waiting; one the PM
// sent itself only answers its own kind. Gamut x Lindsay, Nov 10: the auto-sent "Tool access" email rejected the waiting
// "Needs you" reply carrying Iddo's question (new date for the draft cut), so the question never reached Harsh.
export function retiredByOurEmail(draftKind, pmKind) {
  if (!pmKind) return true;
  return String(draftKind || '') === String(pmKind);
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
  if (deal) await rememberEmail(deal, { who: 'us (NOOCAP)', date: email.date || at, subject: email.subject, text: mine + ((email.attachments || []).length ? `\n[attached: ${(email.attachments || []).map((a) => a.filename).join(', ')}]` : '') }).catch((e) => console.error('memory', e.message));
  if (reopened) await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Paid Date': { date: null } } }).catch(() => {});
  if (cleared && !scriptSent && !cutShared) await clearNextDate(deal);
  await log({ event: `Our reply: ${email.subject || ''}`, outcome: 'Rule', email, deal, details: `thread:${email.threadId} at:${at}${retired.length ? ` · retired ${retired.length} waiting draft(s), you already replied` : ''}${cleared ? ' · pending "send" action marked done' : ''}${invoiced ? ' · invoice sent, deal moved to Invoiced' : ''}${reopened ? ' (deal reopened from Paid for the new videos)' : ''}${stamped.length ? ` · Invoice Sent stamped on ${stamped.map((r) => r.title).join(', ')}` : ''}${scriptSent ? ' · script sent, deal moved to Script Sent' : ''}${cutShared ? ` · cut shared by hand (${cutLink}), deal moved to Submitted` : ''}${waitFor ? ` · now waiting for ${waitFor}` : ''}` });
  return { action: 'recorded', why: 'our reply noted', retired: retired.length };
}

// ---------- contracts go to WhatsApp as the actual file ----------
// A brand sending a contract (a PDF that says contract/agreement, an e-sign link, or "contract attached" with a file)
// lands on Harsh's and Pratham's WhatsApp with the file itself. The PM only passes it on: it never signs or agrees.
const SIGN_LINK = /https?:\/\/[^\s<>"')\]]*(?:docusign\.(?:net|com)|pandadoc\.com|hellosign\.com|dropboxsign\.com|sign\.dropbox\.com|adobesign\.com|echosign\.com|documents\.adobe\.com|signnow\.com|ironcladapp\.com|contractbook\.com|sign\.zoho\.|yousign\.com|signwell\.com|boldsign\.com)[^\s<>"')\]]*/gi;
const CONTRACT_FILE = /contract|agreement|addendum|\bsow\b|statement.of.work|insertion.order|\bnda\b|\bterms\b/i;
const CONTRACT_TALK = /\b(contracts?|agreements?|addendum|statement of work|SOW|insertion order|docusign|e-?sign(ature)?)\b/i;
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
  const links = [...new Set(`${latest} ${email.html || ''}`.match(SIGN_LINK) || [])].slice(0, 2);
  const docLinks = contractDocLinks(`${latest}\n${String(email.html || '').replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, ' $2 $1 ')}`);
  const named = docs.filter((a) => CONTRACT_FILE.test(a.filename || ''));
  // A brief and a contract in one email: the contract is the one named like a contract; the brief stays with the brief
  if (named.length) return { files: named, links, docLinks };
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
async function contractToWhatsApp(email, x, deal) {
  const c = contractIn(email);
  if (!c) return '';
  // Unnamed PDFs: a contract only if its text reads like one ("this agreement", "the parties", "in witness whereof")
  if (c.unnamed) {
    const { pdfText } = await import('./pdftext.js');
    const { looksLikeContract } = await import('./contracts.js');
    for (const a of c.unnamed.slice(0, 3)) { const t = await pdfText(a.data, 6000).catch(() => null); if (t && looksLikeContract('', t) && !/\bbrief\b/i.test(t.slice(0, 300))) c.files.push(a); }
    if (!c.files.length) return '';
  }
  // A contract shared as a Google Docs / Drive / Dropbox link comes to WhatsApp as a PDF; if it can't be fetched (not
  // shared publicly), the link itself is sent
  c.openLinks = [];
  for (const u of c.docLinks || []) { const f = await linkToPdf(u); if (f) c.files.push(f); else c.openLinks.push(u); }
  if (x.from_role === 'noocap' || (x.delivers || []).some((d) => /signed/i.test(d))) return ''; // our side sending it back signed
  if (email.date && (Date.now() - Date.parse(email.date)) / 36e5 > 36) return ''; // catch-up of old mail
  const W = await import('./whatsapp.js');
  const who = `${deal?.brand || x.brand || 'A brand'}${deal?.creator || x.creator ? ' × ' + (deal?.creator || x.creator) : ''}`;
  const from = String(email.from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || email.from || '';
  const gist = (x.summary || [])[0];
  const text = [
    `📄 *Contract: ${who}*`,
    from ? `From ${from}${email.subject ? ` · "${email.subject}"` : ''}` : null,
    gist ? `• ${gist}` : null,
    ...c.links.map((u) => `Sign link: ${u}`),
    ...(c.openLinks || []).map((u) => `Contract link (could not turn it into a PDF, it may not be shared publicly): ${u}`),
    c.files.length ? `The ${c.files.length > 1 ? 'files are' : 'file is'} below, so please read it and sign it yourself because the PM never signs or agrees to contract terms.` : 'Please read it and sign it yourself because the PM never signs or agrees to contract terms.',
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

export function applyTextGuards(x, email) {
  // "Okay, got it. Hope to receive the script soon" after we already sent it: the brand hasn't seen what we sent, so
  // this is never a no-reply update. It needs an answer that sends the thing again (Hyper3D × Lindsay, Nov 3).
  { const w = stillWaitingFor(latestText(email?.text || '')); if (w) { x.needs_reply = true; x.still_waiting_for = w; x.we_owe = x.we_owe || `Send the ${w} again: the brand says they are still waiting for it`; } }
  // "Looks great, a couple of notes for filming and editing": the script is approved, the notes go to whoever films and edits
  if (x.event === 'script_changes' && String(x.filming_notes || '').trim() && !String(x.feedback || '').trim()) x.event = 'script_approved';
  // "Looks great, no major issues, just one small note…" on a video: any requested change wins over the approval,
  // or the editor renders the CTAs on a cut the brand still wants changed. The approval is remembered so the
  // editor and the deal know only this tweak is left.
  if (x.event === 'video_feedback' && String(x.feedback || '').trim().length > 10) { x.approved_after_changes = !!x.video_approved; x.video_approved = false; }
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
    if (x.posting_hold && !String(x.posting_hold).trim()) x.posting_hold = null;
    if (!x.posting_hold && postingCleared(latest)) x.posting_cleared = true;
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
    const bad = !v.agree || v.wrongDeal;
    await log({ event: `Second read ${bad ? 'DISAGREES' : 'agrees'}${mode === 'shadow' ? ' (shadow)' : ''}: ${who || x.brand || email.subject || ''}`.slice(0, 118), outcome: bad ? 'Needs approval' : 'Rule', email, x, deal, details: `Reader 1: ${x.event}${x.deal_stage ? ' / stage ' + x.deal_stage : ''}\nReader 2: ${v.rightEvent}${v.wrongDeal ? ' (wrong deal)' : ''}: ${v.reason}${v.note ? '\nNote: ' + v.note : ''}`, usage, cost: (cost || 0) + v.cost, creator: deal?.creator }).catch(() => {});
    if (!bad || (mode !== 'on' && mode !== 'team')) return null;
    if (deal?.id) await patchDeal(deal, (set) => { set('Next Action', `Needs you: check ${deal.brand}'s latest email (the two readers disagree: ${v.reason})`.slice(0, 1900)); for (const [f, val] of heldBrandStamps(email, x)) set(f, val); }).catch(() => {});
    await discord('🧐 ' + card(`${who || x.brand || 'Brand email'} · I'm not sure what this email means`, [`Reader 1 thinks: ${x.event.replace(/_/g, ' ')}. Reader 2 thinks: ${v.rightEvent.replace(/_/g, ' ')}${v.wrongDeal ? ', and that it belongs to another deal' : ''}.`, `${v.reason} Nothing was changed. Tell me on WhatsApp what it is and I'll act on it.`], deal?.url), 'pm').catch(() => {});
    return { action: 'held', why: `second reader disagreed: ${v.reason}`.slice(0, 200), deal: deal?.url };
  } catch (e) { console.error('second read', e.message); return null; }
}


const ASKS_RATE = /\b(your|current|standard)\s+(rates?|pricing|prices?|fees?)\b|\bshare\s+(your|the)\s+(rates?|pricing|rate card)|\bwhat\s+(would|do)\s+you\s+charge|\brate\s*card\b|\bhow\s+much\s+(would|do)\s+you\s+charge/i;
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
    return { event: 'brief', ...r };
  }

  let deal = x.deal_number ? deals[x.deal_number - 1] : null;
  const creator = deal?.creator || x.creator;
  let board = creator ? BOARDS.find((b) => CREATOR_KEY(b.creator) === CREATOR_KEY(creator)) : null;
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
    if (byAddress || handles(contact, board.creator)) ownerConfirmed = true;
  }
  // Brand approved or commented on the video but there's no deal row: act on the video in Video Intake anyway
  if (!deal && x.event === 'video_feedback' && x.brand) {
    const row = await findIntakeRowByBrand(x.brand, board?.creator).catch(() => null);
    if (row && (x.video_approved || x.feedback)) {
      if (x.video_approved) await setIntake(row, 'To Post');
      else await setIntake(row, 'Changes', { feedback: [x.feedback, ...(x.summary || [])], bumpRevision: true, images: email.attachments });
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
  const common = (set) => {
    // The PM keeps the stage itself: forward only, and only when it's sure
    // Paid is never taken from the AI's guess: only real money (with proof, or Stripe) marks it, in payment_confirmed / invoicing
    if (aiStage(x.deal_stage) && x.confidence === 'high' && STAGES.includes(x.deal_stage) && stageBefore(deal.stage, x.deal_stage)) set('Deal Stage', x.deal_stage);
    if (fromBrand) { set('Last Brand Reply', istStamp(emailTime(email))); set('Follow-ups Sent', 0); }
    // Company details for the invoice, and how the fee is split: the invoicing step raises the invoice from these
    // The brand asked for the invoice: it goes out now, it doesn't wait for the video to be posted
    if (fromBrand && x.asks_for_invoice) set('Invoice Requested', true);
    if (fromBrand && x.billing_details?.company_name) set('Billing Details', JSON.stringify({ ...x.billing_details, email: x.billing_details.email || (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || null, at: todayIST() }));
    if (x.payment_terms && /\d\s*%|net \d+|upfront|advance|on (publish|posting|delivery)/i.test(x.payment_terms)) set('Payment Terms', String(x.payment_terms).slice(0, 300));
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

  // The brand can't open the link we sent (Readdy and ElevenLabs, Nov 10-11): send the same link again straight away,
  // on its own line, instead of treating "the link doesn't load" as feedback on the video
  if (fromBrand && linkBroken(latestText(email.text || ''))) {
    try {
      const link = await lastLinkSent(deal);
      if (link) {
        const first = (String(email.from || '').match(/^"?([A-Z][a-z]+)/) || [])[1] || 'there';
        const body = `Hi ${first},\n\nSorry about that. Here's the link again:\n\n${link}\n\nIf it still doesn't open, let us know and we'll send the video another way.\n\nBest,\n${deal.creator || 'Our'}'s Team`.replace(/\nOur's Team$/, '\nOur Team');
        const d = await createDraft({ kind: 'Other', deal, subject: `Re: ${String(email.subject || deal.threadSubject || '').replace(/^\s*(re:\s*)+/i, '')}`, body, notify: false, why: `${deal.brand} said the link didn't open; the same link sent again.` });
        if (d?.created && d.id) { const { approveAndSend } = await import('./outbox.js'); await approveAndSend(d.id); }
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
      await patchDeal(deal, (set) => {
        common(set);
        if (stageBefore(deal.stage, 'Script Approved')) set('Deal Stage', 'Script Approved');
        set('Script Approved Date', todayIST());
        set('Next Action', 'Film and edit the video');
      });
      const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 6) : null;
      const notes = String(x.filming_notes || '').trim();
      if (notes && deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `🎬 Brand notes for filming and editing ${todayIST()}`, notes.split('\n'));
      // Their own validated wording is what gets filmed: it goes on the card as the final script
      const finalScript = String(x.approved_script || '').trim();
      if (finalScript && deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `✅ Final script approved by the brand ${todayIST()} (their validated version, film this)`, finalScript.split('\n').map((l) => l.trim()).filter(Boolean));
      await say('✅', `${who} · script approved`, [st ? `Video moved to ${st}` : null, notes ? `Filming notes saved on the card: ${notes.slice(0, 160)}` : pts[0]], notes ? 'pm' : 'log', deal.linkedVideo || deal.url);
      did = `Deal Script Approved${st ? ', video ' + st : ''}${notes ? ', filming notes added to the card' : ''}`;
      // Script approved -> ask the brand to give their tool's access to our filming account, once per deal; it sends
      // itself after the hold (Harsh, Nov 7)
      try { const t = await askToolAccess(deal, email); if (t) did += ', tool-access email drafted'; } catch { /* the approval itself is handled */ }
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
      const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 4) : null;
      if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the script ${todayIST()}`, [x.feedback, ...(x.summary || [])]);
      const pinged = await discord(`${tag()} ✏️ **Script changes requested: ${who}**\n${x.feedback ? x.feedback.slice(0, 900) : pts.map((p) => '• ' + p).join('\n')}${deal.linkedVideo ? '\nNotion: ' + deal.linkedVideo : ''}`).catch(() => false);
      if (pinged) await say('✏️', `${who} · script changes requested`, ['Rudraksh has been tagged'], 'log', deal.linkedVideo || deal.url);
      else await discord(`⚠️ **Couldn't reach Rudraksh on Discord: ${who} script changes**\nThe feedback is on the video card, please pass it on${deal.linkedVideo ? '\n→ ' + deal.linkedVideo : ''}`, 'pm').catch(() => {});
      did = `Script changes ${pinged ? 'sent to Rudraksh' : 'saved on the card (Discord ping to Rudraksh FAILED)'}${st ? ', video back to ' + st : ''}`;
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
      if (x.video_approved) {
        // Your editor bot takes it from here: CTA message to the editor, "done" → Posted in Intake + card to To Post
        if (row) await setIntake(row, 'To Post');
        await say('🎉', `${who} · video approved`, [row ? 'Video Intake set to To Post, editor bot asks for the CTA renders' : null], row ? 'log' : 'pm', deal.linkedVideo || deal.url);
        if (!row) await discord(`⚠️ ` + card(`${who} · video approved, but I couldn't find it in Video Intake`, ['Set its Video Intake row to To Post so the editor renders the CTAs']), 'pm');
      } else if (x.feedback) {
        const fb = [x.approved_after_changes ? 'Brand is happy with the video apart from this change:' : null, x.feedback, ...asList(x.summary)].filter(Boolean);
        // Several videos on this deal (ZEN UGC 1, 2, 3) and notes per video in the email: each row gets its own notes
        const all = await findIntakeRows(deal).catch(() => []);
        const parts = all.length > 1 ? notesPerVideo(latestText(email.text || ''), all) : null;
        if (parts) {
          for (const { row: r, lines } of parts) await setIntake(r, 'Changes', { feedback: lines, bumpRevision: true, images: email.attachments });
          row = parts[0].row; row.title = parts.map((p) => p.row.title).join(', ');
        } else if (row) await setIntake(row, 'Changes', { feedback: fb, bumpRevision: true, images: email.attachments });
        const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 8) : null;
        if (row) await say('🎬', `${who} · brand changes sent to ${row.editor || 'the editor'}`, [x.feedback, st ? `Card moved to ${st}` : null], 'log', row.url);
        else await discord(`🎬 ` + card(`${who} · brand wants changes, but I couldn't find the video in Video Intake`, [x.feedback, 'Pass this to the editor']), 'pm');
      } else {
        await say('🎬', `${who} · brand is reviewing the video`, pts, 'log', deal.linkedVideo || deal.url);
      }
      did = x.video_approved ? (row ? 'Deal Approved, Video Intake set to To Post' : 'Deal Approved, NOT found in Video Intake (asked Harsh)') : x.feedback ? (row ? `Brand changes sent to ${row.editor || 'the editor'} (Video Intake ${row.title} set to Changes)` : 'Brand changes NOT sent: no Video Intake row found (asked Harsh in #pm)') : 'Brand is reviewing, noted on the video';
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
      // "We've already paid" with no receipt, screenshot or transfer reference is a claim, not a payment: nothing is
      // marked paid, and a reply asking for the payment confirmation waits for Harsh (Zeely via Mediacube, Nov 3)
      {
        const said = latestText(email.text || '');
        const hasProof = proofFilesOf(email).length > 0 || /\b(transaction|reference|ref\.?|utr|swift|txn|remittance|receipt)\b[\s#:no.]*[A-Z0-9][A-Z0-9-]{5,}/i.test(said) || /paypal|wise|payoneer/i.test(String(email.from || ''))
          // proof sent earlier in the deal counts too (Mediacube attached the transfer confirmation on 23 Oct)
          || /(transfer|payment) confirmation|confirmation attached|receipt attached|proof attached|transaction proof|invoice paid/i.test(`${deal.memory || ''} ${deal.notes || ''}`);
        // Every invoice goes through Stripe, so Stripe is the judge: an email can only say "we paid", Stripe says whether
        // the money arrived. Paid in Stripe = paid, whatever the email says. Not paid in Stripe (they paid some other way, or not yet) = ask for the transfer proof as before.
        let st = { known: false };
        try { const I = await import('./invoicing.js'); st = await I.stripeState(deal); } catch { /* fall back to the email */ }
        if (st.known && st.allPaid) { /* real money: carry on to the paid path below */ }
        else if (fromBrand && !hasProof) {
          await patchDeal(deal, (set) => { common(set); set('Next Action', 'Brand says it paid but sent no proof: waiting for their payment confirmation'); set('Next Action Date', new Date(Date.now() + 5.5 * 36e5 + 3 * 864e5).toISOString().slice(0, 10)); });
          const qs = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
          const here = { ...(email.threadId ? { ...deal, threadId: email.threadId, messageRfc: email.messageId || deal.messageRfc, threadSubject: threadSubject(email.subject) || deal.threadSubject } : deal), ...(qs && !creatorSide(qs) ? { brandEmail: qs } : {}) };
          if (!(await draftedFor(email, here.threadId))) {
            const mail = await writeEmail({ kind: 'Reply', deal: here, facts: { their_latest_message: said, ask: 'Thank them and ask them to share the payment confirmation (the bank transfer receipt or the transaction reference) so we can match it on our side. Do not say we have or have not received it.' } });
            await createDraft({ kind: 'Reply', deal: here, subject: mail.subject, body: mail.body, video: deal.linkedVideo, why: `${deal.brand} says they paid, but no receipt or reference came with it. This asks for the payment proof.` });
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
      try { rev = await markRevenuePaid(deal, x, proof); } catch (e) { rev = 'revenue not updated: ' + String(e.message).slice(0, 120); }
      // A receipt counts as paid: the Stripe invoice is closed as paid outside Stripe so it stops reminding the brand
      if (proof.length && !upfront) { try { const I = await import('./invoicing.js'); const closed = await I.closeStripePaidOutside(deal); if (closed.length) rev += ` · Stripe invoice marked paid (outside Stripe)`; } catch { /* the deal is Paid either way */ } }
      if (proof.length) rev += ` · payment proof saved (${proof.length} file${proof.length > 1 ? 's' : ''})`;
      // The money landing goes to WhatsApp with the brand's proof attached
      try {
        const W = await import('./whatsapp.js');
        const amt = money(x.amount || deal.invoiceAmount || deal.finalRate, x.currency);
        const text = [`💸 *Paid: ${who}*${amt ? ` · ${amt}` : ''}`, (x.summary || [])[0] ? `• ${(x.summary || [])[0]}` : null, proof.length ? `Their payment proof is below, and it's saved on the revenue row too.` : 'No proof attached to the email.', 'Please check it has landed in the account, then collect the NOOCAP cut.'].filter(Boolean).join('\n');
        const r = await W.sendContract({ text, files: proof, label: 'payment proof' });
        rev += ` · WhatsApp (${r.sent} sent${r.queued ? `, ${r.queued} waiting` : ''})`;
      } catch (e) { rev += ' · WhatsApp failed: ' + String(e.message).slice(0, 80); }
      await say('💸', `${who} · paid ${money(x.amount || deal.invoiceAmount, x.currency) || ''}`.trim(), [rev, 'Collect the NOOCAP cut'], 'log'); // the cut to collect shows in the 9am money digest
      did = (upfront ? 'Upfront payment recorded, deal kept open (video not posted yet); ' : 'Deal marked Paid; ') + rev;
      break;
    }
    default: { // brand_reply
      await patchDeal(deal, (set) => common(set));
      if (x.needs_reply && fromBrand && await weRepliedAfter(email)) {
        did = 'Brand asked something, but a newer message in the thread already moved things on';
      } else if (x.needs_reply && fromBrand && await draftedFor(email, email.threadId || deal.threadId)) {
        did = 'Reply already waiting in Approvals';
      } else if (x.needs_reply && fromBrand && (x.needs_our_info || x.we_owe) && (x.info_needed || x.we_owe)) {
        x.info_needed = x.info_needed || x.we_owe;
        // The answer needs something only we have (ad codes, analytics, an account email): ask Harsh first on WhatsApp
        // instead of paying the AI to draft an email that can't say anything useful. His answer becomes the draft.
        const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
        const ask = { dealId: deal.id, brand: deal.brand, creator: deal.creator, need: x.info_needed, threadId: email.threadId || deal.threadId || '', messageRfc: email.messageId || deal.messageRfc || '', subject: threadSubject(email.subject) || deal.threadSubject || '', brandEmail: sender && !creatorSide(sender) ? sender : deal.brandEmail || '', theirMessage: latestText(email.text).slice(0, 1500) };
        await patchDeal(deal, (set) => set('Next Action', `Waiting on us: ${x.info_needed}`)).catch(() => {});
        try { const W = await import('./whatsapp.js'); await W.askForInfo(ask); } catch (e) { console.error('WhatsApp info ask failed', e.message); }
        await say('🙋', `${who} · they need something from us`, [`They're asking for: ${x.info_needed}`, 'Reply on WhatsApp with it (swipe-reply to the question) and I\'ll draft the email with it'], 'pm', deal.url).catch(() => {});
        did = `Asked Harsh for: ${x.info_needed} (no email drafted yet)`;
      } else if (x.needs_reply && fromBrand) {
        await replaceOlderReplies(email.threadId || deal.threadId);
        // Answer in the thread this email came from, to this exact message
        const sender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
        const here = { ...(email.threadId ? { ...deal, threadId: email.threadId, messageRfc: email.messageId || deal.messageRfc, threadSubject: threadSubject(email.subject) || deal.threadSubject } : deal), ...(sender && !creatorSide(sender) ? { brandEmail: sender } : {}) }; // answer whoever at the brand wrote
        const mail = await writeEmail({ kind: 'Reply', deal: here, facts: { their_latest_message: latestText(email.text), their_message: (x.summary || []).join(' | '), subject: email.subject } });
        await createDraft({ files: email.attachments, context: `From: ${email.from || ''}\nDate: ${email.date || ''}\n\n${latestText(email.text).slice(0, 2500)}`, kind: 'Reply', deal: here, subject: mail.subject, body: mail.body, video: deal.linkedVideo, why: `${deal.brand} asked: ${(x.summary || [])[0] || email.subject}` });
        if (newDeal && deal.needsCheck) await say('🆕', `${who} · reply drafted`, pts, 'pm');
        did = 'Reply drafted for approval';
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
  if (fromBrand && x.needs_reply && !onlyNotes && ['script_changes', 'video_feedback', 'script_approved'].includes(x.event) && !(await weRepliedAfter(email)) && !(await draftedFor(email, email.threadId || deal.threadId))) {
    await replaceOlderReplies(email.threadId || deal.threadId);
    const qSender = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
    const here = { ...(email.threadId ? { ...deal, threadId: email.threadId, messageRfc: email.messageId || deal.messageRfc, threadSubject: threadSubject(email.subject) || deal.threadSubject } : deal), ...(qSender && !creatorSide(qSender) ? { brandEmail: qSender } : {}) };
    const mail = await writeEmail({ kind: 'Reply', deal: here, facts: { their_latest_message: latestText(email.text), their_message: (x.summary || []).join(' | '), subject: email.subject, deadline: x.due_by ? `${x.due_what || 'deliverable'} by ${x.due_by}` : undefined, note: 'Answer only the question they asked, using the facts you have. Do not repeat or acknowledge their change notes. Never write that we will send or confirm anything "shortly", "soon" or "right away", and never promise a date that is not already agreed.' } });
    await createDraft({ files: email.attachments, context: `From: ${email.from || ''}\nDate: ${email.date || ''}\n\n${latestText(email.text).slice(0, 2500)}`, kind: 'Reply', deal: here, subject: mail.subject, body: mail.body, video: deal.linkedVideo, why: `Needs you: ${deal.brand} asked: ${(x.summary || [])[0] || email.subject}${x.due_by ? ` (wants ${x.due_what || 'it'} by ${x.due_by})` : ''}` });
    did += ' · reply drafted';
  }
  did += await applyPromise(); // after the event so its Next Action isn't overwritten
  did += accessDid;
  clearCache();
  await log({ event: `${x.event.replace(/_/g, ' ')}: ${who}`, outcome: 'Rule', email, x, deal, details: did, usage, cost, creator: deal.creator });
  return { action: 'handled', event: x.event, deal: deal.url, did };
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
export function notesPerVideo(text, rows) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*[×x]\s*\w+\s*$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const lines = String(text || '').split('\n');
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

export async function resendScriptChanges({ brand, creator, feedback, addNote = true }) {
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
  if (!cardOnly) await patchDeal(deal, (set) => set('Next Action', 'Rudraksh revising the script'));
  const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 4).catch(() => null) : null;
  if (addNote && deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the script ${todayIST()}`, String(feedback).split('\n'));
  const ok = await discord(`${tag()} ✏️ **Script changes requested: ${who}**\n${String(feedback).slice(0, 900)}${deal.linkedVideo ? '\nNotion: ' + deal.linkedVideo : ''}`);
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
export function toolAccessBody({ firstName, brand, creator }) {
  return `Hi ${firstName || 'there'},\n\nThanks for approving the script, we'll move ahead with filming. To record the demo, could you please give access to ${brand || 'the tool'} on ${TOOL_ACCESS_EMAIL}? That's the account we'll use for this video. Please let us know once the access has been given.\n\nBest,\n${creator || 'The'}'s Team`;
}
export async function askToolAccess(deal, email) {
  if (!deal?.id || !deal.threadId || deal.channel === 'WhatsApp') return null;
  const done = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: deal.id } }, { property: 'Kind', select: { equals: 'Tool access' } }] } }).catch(() => ({ results: [] }));
  if ((done.results || []).length) return null;
  const name = String(email?.from || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim().split(/\s+/)[0] || '';
  const firstName = /@/.test(name) ? '' : name;
  return createDraft({ kind: 'Tool access', deal, subject: `Re: ${deal.threadSubject || email?.subject || ''}`.replace(/^Re:\s*Re:/i, 'Re:'), body: toolAccessBody({ firstName, brand: deal.brand, creator: deal.creator }), notify: false, why: `Script approved: asking ${deal.brand} for access to their tool on ${TOOL_ACCESS_EMAIL}. Sends on its own in 30 min unless you reject it.` });
}
