// PM · Inbox brain. Every new noocapcollab email lands here (from n8n).
// Code filters obvious noise, Haiku reads the rest, then the right deal / video / outbox action happens.
import { notion, plain, clearCache, queryAll } from './notion.js';
import { BOARDS, DS, todayIST } from './tools.js';
import { schemaOf, findProp, CREATOR_KEY } from './actions.js';
import { claude, HAIKU, costOf } from './claude.js';
import { openDeals, threadCcFrom, readDocLink, alreadyHandled, fileBrief, uploadToNotion, setIf, discord, card, log, tag, LINK_RE, DOC_LINK, noMoneyList } from './briefs.js';
import { createDraft, writeEmail, stageBefore, STAGES, OUTBOX_DS } from './outbox.js';
import { findIntakeRow, findIntakeRowByBrand, setIntake } from './intake.js';
import { threadSubject } from './mime.js';

const lc = (s) => String(s ?? '').toLowerCase().trim();
const ROSTER = BOARDS.map((b) => b.creator);
const pageIdFromUrl = (u) => (String(u || '').match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1] || null;
const domainOf = (s) => (String(s || '').match(/@([\w.-]+\.\w+)/) || [])[1]?.toLowerCase() || '';

const SIGNALS = /\b(video|good to go|looks? great|love (it|the)|ad ?codes?|spark ?codes?|whitelist|usage rights|brief|guideline|talking points?|script|approv|looks good|lgtm|feedback|changes?|revision|edit|invoice|payment|paid|wire|transfer|remit|rate|price|budget|fee|agreed|confirm|contract|deal|go[- ]live|posted|link|deliverable|draft|campaign|sponsor)/i;
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

const EVENTS = ['brief', 'price_agreed', 'script_approved', 'script_changes', 'video_feedback', 'invoice_from_creator', 'payment_confirmed', 'brand_reply', 'not_relevant'];

const READ_TOOL = {
  name: 'record_email',
  description: 'Record what this email means for NOOCAP brand deals.',
  input_schema: {
    type: 'object',
    properties: {
      event: { type: 'string', enum: EVENTS, description: `brief = brand sends/updates the content brief for content not scripted yet, including creative direction without a formal brief doc (example or reference videos, inspiration links, angles or use cases to cover, or asking for concepts/scripts before filming) (if the brand is giving notes on a script or video we already sent, it is script_changes or video_feedback, even when the email also links a brief for another deliverable); price_agreed = brand confirms the rate/deal; script_approved = brand approves the script; script_changes = brand wants script changes; video_feedback = brand comments on or approves the edited video; invoice_from_creator = a creator (or their team) sends their invoice for a deal, either to the brand with NOOCAP copied or to NOOCAP; payment_confirmed = brand says the money has actually been SENT or the invoice is paid (a brand asking for bank, PayPal or payment details so it can pay is brand_reply with needs_reply true, not payment_confirmed); brand_reply = any other message in a deal thread (from the brand, the creator's team or NOOCAP); not_relevant = anything else` },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string' },
      from_role: { type: 'string', enum: ['brand', 'creator', 'noocap', 'other'] },
      brand: { type: 'string', description: 'The company whose product the video promotes. The subject line usually names it (e.g. "Creator Partnership Opportunity — Pine AI" means Pine AI). Do not take it from CC addresses: people from other companies or agencies are often copied.' },
      creator: { type: ['string', 'null'], enum: [...ROSTER, null], description: 'The creator this deal is for, only when the email or quoted thread clearly says so (their name, channel or handle) or it matches an open deal. null when unsure: never guess.' },
      deal_number: { type: ['integer', 'null'], description: 'Number of the matching open deal from the list, or null' },
      summary: { type: 'array', items: { type: 'string' }, description: 'Key points of the LATEST message only (not the quoted history), max 6' },
      deal_stage: { type: ['string', 'null'], enum: [...STAGES, null], description: 'Where the whole deal stands after this email, judged from this email and the quoted thread: Negotiating (talking price), Price Agreed (rate confirmed), Brief Received (brief shared), Script Sent / Script Approved, In Production (filming/editing), Submitted (edited video sent to brand), Approved (brand approved the video), Posted (video live), Invoiced, Paid. null if unclear.' },
      we_promised: { type: ['array', 'null'], items: { type: 'string' }, description: 'Only when the latest message is from NOOCAP or the creator/their team: things it tells the brand they will send later (e.g. "signed contract", "invoice", "posted links", "revised script"). Short nouns. null if nothing is promised.' },
      delivers: { type: ['array', 'null'], items: { type: 'string' }, description: 'Things the latest message actually sends now, as attachments or links (e.g. "signed contract", "invoice"). null if none.' },
      needs_reply: { type: 'boolean', description: 'True only if the brand asks a question or requests something that NOOCAP must answer. False for thanks, acknowledgements, confirmations ("sounds good", "Stripe works", "great, thanks") and for anything the creator or their team already answered later in the thread.' },
      amount: { type: ['number', 'null'], description: 'Agreed rate or invoice amount if stated' },
      currency: { type: ['string', 'null'] },
      paid_date: { type: ['string', 'null'], description: 'Only for payment_confirmed: the date the brand says it paid, as YYYY-MM-DD (work out words like Friday from the email Date); null if not stated' },
      video_approved: { type: ['boolean', 'null'], description: 'For video_feedback: true if they approved the video' },
      feedback: { type: 'string', description: 'Whenever the brand asks for changes to a script or video we sent (whatever the event), the exact requested changes' },
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

async function readEmail(email, deals, docText) {
  const dealList = deals.map((d, i) => `${i + 1}. ${d.brand} | creator: ${d.creator || '?'} | stage: ${d.stage || '?'} | video card: ${d.linkedVideo ? 'yes' : 'no'}${d.brandEmail ? ' | brand email: ' + d.brandEmail : ''}`).join('\n') || '(no open deals)';
  const content = [];
  for (const a of (email.attachments || []).slice(0, 2)) {
    if (a.data && /pdf/i.test(a.mimeType || a.filename || '')) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
  }
  content.push({
    type: 'text',
    text: `NOOCAP creators: ${ROSTER.join(', ')} (Valeri may be spelled Valerie, David Iya may be just David). NOOCAP's team mailbox is noocapcollab.

Open brand deals:
${dealList}

Email
From: ${email.from || ''}
To: ${email.to || ''}
Cc: ${email.cc || ''}
Date: ${email.date || ''}
Subject: ${email.subject || ''}
Attachments: ${(email.attachments || []).map((a) => a.filename).join(', ') || 'none'}

${String(email.text || '').slice(0, 15000)}
${docText ? `\n--- Text of the linked brief doc ---\n${docText.slice(0, 15000)}` : ''}

Classify the latest message in this email (ignore quoted older replies unless needed for context) and record it.
Exception: NOOCAP is often copied into a thread late. If the matching deal has no video card yet (or there is no deal yet) and this email OR the quoted earlier messages contain the brand's brief (a brief doc link, talking points, deliverables, key messages), set event = brief and take the brief fields from wherever they appear in the thread. Match the deal by brand name, sender domain and creator; if nothing matches clearly, deal_number is null.`,
  });
  const out = await claude({
    model: HAIKU,
    max_tokens: 3000,
    system: 'You file incoming emails for NOOCAP Media, an agency that makes sponsored videos for creators and handles their brand deals. Be precise and never invent details that are not in the email or attachments.',
    tools: [READ_TOOL],
    tool_choice: { type: 'tool', name: 'record_email' },
    messages: [{ role: 'user', content }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  return { x: call?.input || { event: 'not_relevant', confidence: 'low', reason: 'no answer', summary: [] }, usage: out.usage };
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
  return { id: p.id, url: p.url, brand: get('Brand Name') || 'Untitled', creator: get('Creator'), stage: get('Deal Stage'), brandEmail: creatorSide(get('Brand Email')) ? null : get('Brand Email'), linkedVideo: get('Linked Video'), threadId: get('Thread ID'), messageRfc: get('Message ID'), threadSubject: get('Thread Subject'), threadCc: get('Thread CC') || '', agentNotes: get('Agent Notes') || '', finalRate: get('Final Rate USD'), invoiceAmount: get('Invoice Amount'), followUps: Number(get('Follow-ups Sent') || 0), deliverables: get('Deliverables'), postedLinks: get('Posted Links'), needsCheck: get('Needs Check') === true };
}

async function createDealFor(x, email, board) {
  const schema = await schemaOf(DS.deals);
  const props = { 'Brand Name': { title: [{ type: 'text', text: { content: (x.brand || 'Unknown brand').slice(0, 200) } }] } };
  setIf(schema, props, 'Creator', board.creator);
  setIf(schema, props, 'Deal Source', 'Auto-captured');
  const sure = x.deal_stage && x.confidence === 'high' && STAGES.includes(x.deal_stage);
  setIf(schema, props, 'Needs Check', !sure);
  if (sure) setIf(schema, props, 'Deal Stage', x.deal_stage);
  // Only the brand's own address goes in Brand Email (the creator or NOOCAP forwarding a thread isn't the brand)
  if (x.from_role === 'brand') setIf(schema, props, 'Brand Email', (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0]);
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
  return { id: page.id, url: page.url, brand: x.brand || 'Unknown brand', creator: board.creator, stage: sure ? x.deal_stage : null, needsCheck: !sure, agentNotes: '', followUps: 0, brandEmail: props['Brand Email']?.email || null, threadId: email.threadId, messageRfc: email.messageId, threadSubject: threadSubject(email.subject), threadCc: threadCcFrom(email) };
}

const money = (n, c) => (n == null ? '' : `${c && c !== 'USD' ? c + ' ' : '$'}${Number(n).toLocaleString('en-US')}`);

const normBrand = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
export function matchDealIndex(deals, email, x) {
  const live = (d) => d.stage !== 'Lost';
  let i = email.threadId ? deals.findIndex((d) => live(d) && d.threadId && d.threadId === email.threadId) : -1;
  if (i >= 0) return i;
  const b = normBrand(x.brand);
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
async function markRevenuePaid(deal, x) {
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
    const p = { Paid: { checkbox: true }, 'Payment Received': { date: { start: paidOn } } };
    if (usd && !plain(row.properties?.['Amount USD'])) p['Amount USD'] = { number: usd };
    await notion('PATCH', `/pages/${row.id}`, { properties: p });
  } else {
    const rt = (t) => [{ type: 'text', text: { content: String(t).slice(0, 1900) } }];
    const props = {
      'Video Title': { title: rt(title) }, 'Video Link': { url: video.url }, Paid: { checkbox: true },
      'Payment Received': { date: { start: paidOn } }, Notes: { rich_text: rt(`Marked paid by the PM from ${deal.brand}'s email${usd ? '' : '. Amount to confirm.'}`) },
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
const CREATOR_DOMAIN = Object.fromEntries(String(process.env.CREATOR_DOMAINS || 'buildroom.ai:Duncan,chriscordero.net:Chris,valchy.ai:Valeri,automateaiconsulting.com:Lindsay').split(',').map((p) => p.split(':').map((x) => x.trim())).filter(([d, c]) => d && c).map(([d, c]) => [d.toLowerCase(), c]));
const CREATOR_SIDE = [...new Set([...Object.keys(CREATOR_DOMAIN), ...String(process.env.CREATOR_SIDE_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)])];
// The creator whose own address is on the thread (From, To or Cc), if exactly one is
function creatorFromAddresses(email) {
  const doms = (`${email.from || ''} ${email.to || ''} ${email.cc || ''}`.match(/@([\w.-]+)/g) || []).map((a) => a.slice(1).toLowerCase());
  const found = new Set();
  for (const d of doms) for (const [dom, c] of Object.entries(CREATOR_DOMAIN)) if (d === dom || d.endsWith('.' + dom)) found.add(c);
  return found.size === 1 ? [...found][0] : null;
}
const creatorSide = (from) => { const d = (String(from || '').match(/@([\w.-]+)/) || [])[1]; return !!d && CREATOR_SIDE.some((c) => d.toLowerCase() === c || d.toLowerCase().endsWith('.' + c)); };
const ourAddress = (from) => lc(from).includes('noocapcollab');
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
  const retired = [];
  for (const d of stale) {
    const src = ((plain(d.properties?.Why) || '').match(/\[from:([^\]]+)\]/) || [])[1];
    if (Date.parse(d.created_time) >= Date.parse(at) && !(src && Date.parse(src) < Date.parse(at))) continue;
    await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
    retired.push(plain(d.properties?.Subject) || 'draft');
  }
  return retired;
}

async function replaceOlderReplies(threadId) {
  if (!threadId) return;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 10, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Kind', select: { equals: 'Reply' } }, { property: 'Gmail Thread ID', rich_text: { equals: threadId } }] } }).catch(() => ({ results: [] }));
  for (const d of r.results || []) await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
}

// The brand's latest message itself, without the quoted history under it
export function latestText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From:\s.+|Sent from my|>)/i.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim().slice(0, 2500);
}

async function recordOurSide(email, who) {
  if (!email.threadId) return;
  const at = new Date(emailTime(email)).toISOString();
  const retired = await retireStaleDrafts(email, at);
  await log({ event: `Our side: ${who} replied · ${email.subject || ''}`, outcome: 'Rule', email, details: `thread:${email.threadId} at:${at}${retired.length ? ` · retired ${retired.length} waiting draft(s), already answered` : ''}` });
}

const dealKey = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
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
    if (!dealKey(`${g('Brand') || ''} ${title}`).includes(key)) continue;
    await notion('PATCH', `/pages/${r.id}`, { properties: { 'Invoice Sent': { date: { start: day } } } });
    done.push(title || deal.brand);
  }
  if (done.length) clearCache();
  return done;
}

async function handleOurReply(email, deals) {
  if (!email.threadId) return { action: 'skipped', why: 'sent by us' };
  const at = new Date(emailTime(email)).toISOString();
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
  let deal = deals.find((d) => d.stage !== 'Lost' && d.threadId && d.threadId === email.threadId);
  if (!deal && recipientDomains.length) {
    const byDomain = deals.filter((d) => d.stage !== 'Lost' && d.brandEmail && recipientDomains.includes(domainOf(d.brandEmail)));
    const creatorHint = creatorFromAddresses(email);
    deal = byDomain.find((d) => !creatorHint || CREATOR_KEY(d.creator || '') === CREATOR_KEY(creatorHint)) || null;
  }
  const cleared = deal && sentFiles && /^Send /.test(deal.nextAction || '');
  // An invoice sent by hand (PDF named like an invoice) moves the deal to Invoiced so the PM chases the payment
  const invoiceSent = sentFiles && ((email.attachments || []).some((a) => /invoice|\binv[-_ ]?\d/i.test(a.filename || '')) || /invoice/i.test(`${email.subject || ''} ${latestText(email.text || '')}`));
  const invoiced = deal && invoiceSent && stageBefore(deal.stage, 'Invoiced');
  // Every posted, unpaid video of this brand × creator gets "Invoice Sent" (one email can carry the invoices for
  // HOLO 1 and HOLO 2), so they leave "Invoice to send" and the PM starts chasing the payment instead
  let stamped = [];
  if (deal && invoiceSent) stamped = await stampInvoiceSent(deal, at.slice(0, 10)).catch(() => []);
  const dueDay = new Date(Date.now() + 5.5 * 36e5 + 21 * 864e5).toISOString().slice(0, 10); // ~14 business days
  // A script sent by hand (script file, or a doc link in a message about the script) moves the deal to Script Sent,
  // so the PM waits for approval and follows up if the brand goes quiet
  const mine = latestText(email.text || '');
  const scriptFile = (email.attachments || []).some((a) => /script/i.test(a.filename || ''));
  const scriptLink = /script/i.test(`${email.subject || ''} ${mine}`) && (sentFiles || /docs\.google\.com|notion\.(so|site)|drive\.google\.com/i.test(mine));
  const scriptSent = deal && !invoiced && (scriptFile || scriptLink) && !deal.scriptSent && stageBefore(deal.stage, 'Script Sent') && !['Inbound', 'Negotiating'].includes(deal.stage);
  const in3 = new Date(Date.now() + 5.5 * 36e5 + 3 * 864e5).toISOString().slice(0, 10);
  // A cut shared by hand (Frame.io link in our own message) moves the deal to Submitted, so the PM never sends the cut again
  const cutLink = (mine.match(/https?:\/\/(?:[\w-]+\.)*(?:frame\.io|f\.io)\/[^\s<>")]+/i) || [])[0];
  const cutShared = deal && !invoiced && !scriptSent && cutLink && stageBefore(deal.stage, 'Submitted') && !['Inbound', 'Negotiating'].includes(deal.stage);
  if (deal) await patchDeal(deal, (set) => {
    set('Last Our Reply', at.slice(0, 10));
    if (cleared) set('Next Action', `Sent (${(email.attachments || []).map((a) => a.filename).join(', ').slice(0, 150)})`);
    if (cutShared) { set('Deal Stage', 'Submitted'); set('Follow-ups Sent', 0); set('Next Action', "Waiting for the brand's feedback on the cut"); set('Next Action Date', in3); }
    if (scriptSent) { set('Deal Stage', 'Script Sent'); set('Script Sent Date', at.slice(0, 10)); set('Follow-ups Sent', 0); set('Next Action', 'Waiting for the brand to approve the script'); set('Next Action Date', in3); }
    if (invoiced) { set('Deal Stage', 'Invoiced'); set('Invoice Sent Date', at.slice(0, 10)); if (!deal.invoiceDue) set('Invoice Due Date', dueDay); set('Next Action', 'Waiting for payment'); set('Follow-ups Sent', 0); }
  }).catch(() => {});
  if (cleared && !scriptSent && !cutShared) await clearNextDate(deal);
  await log({ event: `Our reply: ${email.subject || ''}`, outcome: 'Rule', email, deal, details: `thread:${email.threadId} at:${at}${retired.length ? ` · retired ${retired.length} waiting draft(s), you already replied` : ''}${cleared ? ' · pending "send" action marked done' : ''}${invoiced ? ' · invoice sent, deal moved to Invoiced' : ''}${stamped.length ? ` · Invoice Sent stamped on ${stamped.join(', ')}` : ''}${scriptSent ? ' · script sent, deal moved to Script Sent' : ''}${cutShared ? ` · cut shared by hand (${cutLink}), deal moved to Submitted` : ''}` });
  return { action: 'recorded', why: 'our reply noted', retired: retired.length };
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
  const g = gate(email, deals);
  if (!g.ok) {
    // A short reply from the creator's side in a thread we track ("sure, will do") still counts as answered
    const tracked = email.threadId && deals.find((d) => d.threadId === email.threadId);
    if (tracked && g.why === 'no deal signals' && domainOf(email.from) && domainOf(email.from) !== domainOf(tracked.brandEmail)) await recordOurSide(email, `${tracked.creator || 'creator'}'s side`).catch(() => {});
    if (g.why !== 'sent by us' && g.why !== 'system email') await log({ event: `Skipped (${g.why}): ${email.subject || ''}`, outcome: 'Skipped', email, x: { reason: g.why }, details: `From ${email.from || '?'}. Skipped by the free filter, no AI used.` }).catch(() => {});
    return { action: 'skipped', why: g.why };
  }
  if (await alreadyHandled(email.messageId)) return { action: 'skipped', why: 'already handled' };

  const allLinks = [...new Set(((email.text || '') + ' ' + (email.html || '')).match(LINK_RE) || [])].filter((u) => DOC_LINK.test(u));
  let docText = null;
  if (/brief/i.test(`${email.subject} ${email.text}`)) for (const u of allLinks.slice(0, 2)) { docText = await readDocLink(u); if (docText) break; }

  const { x, usage } = await readEmail(email, deals, docText);
  // The creators' own teams (Duncan's buildroom.ai, Chris's collab inbox, Valeri's Valchy) are our side, never the brand:
  // their emails are recorded, never answered, and never saved as the brand's address
  if (creatorSide(email.from) && x.from_role === 'brand') { x.from_role = 'creator'; x.needs_reply = false; }
  // Whose deal it is: the creator's own address on the thread beats the AI's guess
  const byAddress = creatorFromAddresses(email);
  if (byAddress && (!x.creator || CREATOR_KEY(x.creator) !== CREATOR_KEY(byAddress))) x.creator = byAddress;
  const cost = costOf(usage);
  if (['creator', 'noocap'].includes(x.from_role)) await recordOurSide(email, x.from_role === 'creator' ? `${x.creator || 'creator'}'s team` : 'NOOCAP').catch(() => {});
  // If the AI didn't pick a deal, match it ourselves: same Gmail thread first, then same brand + creator.
  // Stops the same thread opening a second deal.
  if (!x.deal_number) {
    const i = matchDealIndex(deals, email, x);
    if (i >= 0) x.deal_number = i + 1;
  }

  if (x.event === 'not_relevant' || x.confidence === 'low') {
    await log({ event: `Skipped: ${email.subject || ''}`, outcome: 'Skipped', email, x, details: x.reason, usage, cost });
    return { action: 'skipped', why: 'AI: ' + x.reason };
  }

  // Notes on a script we sent win over a brief link in the same email: the script writer must hear about them
  if (x.event === 'brief' && String(x.feedback || '').trim().length > 20) x.event = 'script_changes';
  if (x.event === 'brief') {
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
  if (!deal && !board && x.brand && x.from_role !== 'noocap') {
    const guess = await creatorFromCards(x.brand).catch(() => null);
    if (guess) { board = BOARDS.find((b) => b.creator === guess); x.creator = guess; }
  }
  if (!deal && board && x.brand && x.from_role !== 'noocap') { deal = await createDealFor(x, email, board); newDeal = !deal.reused; }
  // Brand approved or commented on the video but there's no deal row: act on the video in Video Intake anyway
  if (!deal && x.event === 'video_feedback' && x.brand) {
    const row = await findIntakeRowByBrand(x.brand, board?.creator).catch(() => null);
    if (row && (x.video_approved || x.feedback)) {
      if (x.video_approved) await setIntake(row, 'To Post');
      else await setIntake(row, 'Changes', { feedback: [x.feedback, ...(x.summary || [])], bumpRevision: true });
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
    await log({ event: `Unmatched ${x.event}: ${email.subject || ''}`, outcome: 'Needs approval', email, x, details: waiting ? 'Already replied, or a reply is waiting in Approvals' : 'Reply drafted for approval without a deal', usage, cost, creator: board?.creator });
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

  // One message per email. A brand-new deal always goes to #pm-alerts (someone has to check it); routine updates go to #pm-log.
  const say = (emoji, headline, lines, level = 'log', link = deal.url) => {
    if (newDeal && deal.needsCheck) { level = 'pm'; lines = [...(lines || []).slice(0, 1), 'New deal, but I could not tell the stage: please set it']; emoji = '🆕'; }
    return discord(`${emoji} ` + card(headline, lines, link), level);
  };
  const fromBrand = x.from_role === 'brand';
  const common = (set) => {
    // The PM keeps the stage itself: forward only, and only when it's sure
    if (x.deal_stage && x.confidence === 'high' && STAGES.includes(x.deal_stage) && stageBefore(deal.stage, x.deal_stage)) set('Deal Stage', x.deal_stage);
    if (fromBrand) { set('Last Brand Reply', todayIST()); set('Follow-ups Sent', 0); }
    if (email.threadId && (fromBrand || !deal.threadId)) set('Thread ID', email.threadId);
    if (email.messageId && (fromBrand || !deal.messageRfc)) { set('Message ID', email.messageId); set('Thread Subject', threadSubject(email.subject)); }
    if (fromBrand) { const cc = threadCcFrom(email, deal.threadCc); if (cc && cc !== deal.threadCc) set('Thread CC', cc); }
    if (fromBrand && !deal.brandEmail) set('Brand Email', (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0]);
  };
  const pts = (x.summary || []).slice(0, 2);
  // Catch-up safety: an email older than 36 hours is history. Recording it must not rewind the deal's stage,
  // overwrite Next Action, draft replies or ping anyone (the deal has probably moved on since).
  const ageH = email.date ? (Date.now() - Date.parse(email.date)) / 36e5 : 0;
  // Promises to the brand ("I'll send the signed contract shortly") become the deal's Next Action, due the next day.
  // The heartbeat reminds Harsh once a day until it's sent. An old email only sets it on a brand-new deal (no history to trust).
  const promised = (x.we_promised || []).filter(Boolean);
  const delivered = (x.delivers || []).filter(Boolean);
  const applyPromise = async () => {
    if (x.from_role === 'brand' || (ageH > 36 && !newDeal)) return '';
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
      const day = email.date ? new Date(Date.parse(email.date) + 5.5 * 36e5).toISOString().slice(0, 10) : null;
      await patchDeal(deal, (set) => {
        if (x.deal_stage && x.confidence === 'high' && STAGES.includes(x.deal_stage) && stageBefore(stageNow, x.deal_stage)) set('Deal Stage', x.deal_stage);
        if (fromBrand && day && (!lastBrand || lastBrand.slice(0, 10) < day)) { set('Last Brand Reply', day); set('Follow-ups Sent', 0); }
      });
    } catch { /* recording only */ }
    if (newDeal && deal.needsCheck) await say('🆕', `${deal.brand} × ${deal.creator || '?'} · found in older emails`, pts, 'pm');
    await log({ event: `Old email recorded: ${deal.brand} × ${deal.creator || '?'}`, outcome: 'Skipped', email, x, deal, details: `Email is ${Math.round(ageH)}h old, recorded without changing the deal`, usage, cost, creator: deal.creator });
    return { action: 'skipped', why: 'old email, recorded only', deal: deal.url };
  }
  const who = `${deal.brand} × ${deal.creator || '?'}`;
  let did = '';

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
      await say('✅', `${who} · script approved`, [st ? `Video moved to ${st}` : null, pts[0]], 'log', deal.linkedVideo || deal.url);
      did = `Deal Script Approved${st ? ', video ' + st : ''}`;
      break;
    }
    case 'script_changes': {
      await patchDeal(deal, (set) => { common(set); set('Next Action', 'Shreya revising the script'); });
      const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 4) : null;
      if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the script ${todayIST()}`, [x.feedback, ...(x.summary || [])]);
      await discord(`${tag()} ✏️ **Script changes requested: ${who}**\n${x.feedback ? x.feedback.slice(0, 900) : pts.map((p) => '• ' + p).join('\n')}${deal.linkedVideo ? '\nNotion: ' + deal.linkedVideo : ''}`);
      await say('✏️', `${who} · script changes requested`, ['Shreya has been tagged'], 'log', deal.linkedVideo || deal.url);
      did = `Script changes sent to Shreya${st ? ', video back to ' + st : ''}`;
      break;
    }
    case 'video_feedback': {
      await patchDeal(deal, (set) => {
        common(set);
        if (x.video_approved && stageBefore(deal.stage, 'Approved')) set('Deal Stage', 'Approved');
        set('Next Action', x.video_approved ? 'Render CTAs and post the video' : x.feedback ? 'Editor making the brand\'s changes' : 'Waiting for the brand to review the video');
      });
      if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the video ${todayIST()}`, [x.feedback, ...(x.summary || [])]);
      // Hand it to the editor through Video Intake: Changes = the editor bot asks for the revision,
      // To Post = the editor bot asks for the CTA renders. The board card follows.
      let row = null;
      try { row = await findIntakeRow(deal); } catch { /* handled below */ }
      if (x.video_approved) {
        // Your editor bot takes it from here: CTA message to the editor, "done" → Posted in Intake + card to To Post
        if (row) await setIntake(row, 'To Post');
        await say('🎉', `${who} · video approved`, [row ? 'Video Intake set to To Post, editor bot asks for the CTA renders' : null], row ? 'log' : 'pm', deal.linkedVideo || deal.url);
        if (!row) await discord(`⚠️ ` + card(`${who} · video approved, but I couldn't find it in Video Intake`, ['Set its Video Intake row to To Post so the editor renders the CTAs']), 'pm');
      } else if (x.feedback) {
        if (row) await setIntake(row, 'Changes', { feedback: [x.feedback, ...(x.summary || [])], bumpRevision: true });
        const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 8) : null;
        if (row) await say('🎬', `${who} · brand changes sent to ${row.editor || 'the editor'}`, [x.feedback, st ? `Card moved to ${st}` : null], 'log', row.url);
        else await discord(`🎬 ` + card(`${who} · brand wants changes, but I couldn't find the video in Video Intake`, [x.feedback, 'Pass this to the editor']), 'pm');
      } else {
        await say('🎬', `${who} · brand is reviewing the video`, pts, 'log', deal.linkedVideo || deal.url);
      }
      did = x.video_approved ? 'Deal Approved, Video Intake set to To Post' : x.feedback ? 'Brand changes sent to the editor (Video Intake set to Changes)' : 'Brand is reviewing, noted on the video';
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
      await patchDeal(deal, (set) => { common(set); set('Deal Stage', 'Paid'); set('Paid Date', todayIST()); set('Next Action', 'Collect NOOCAP cut'); });
      let rev = '';
      try { rev = await markRevenuePaid(deal, x); } catch (e) { rev = 'revenue not updated: ' + String(e.message).slice(0, 120); }
      await say('💸', `${who} · paid ${money(x.amount || deal.invoiceAmount, x.currency) || ''}`.trim(), [rev, 'Collect the NOOCAP cut'], 'log'); // the cut to collect shows in the 9am money digest
      did = 'Deal marked Paid; ' + rev;
      break;
    }
    default: { // brand_reply
      await patchDeal(deal, (set) => common(set));
      if (x.needs_reply && fromBrand && await weRepliedAfter(email)) {
        did = 'Brand asked something, but a newer message in the thread already moved things on';
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
  did += await applyPromise(); // after the event so its Next Action isn't overwritten
  clearCache();
  await log({ event: `${x.event.replace(/_/g, ' ')}: ${who}`, outcome: 'Rule', email, x, deal, details: did, usage, cost, creator: deal.creator });
  return { action: 'handled', event: x.event, deal: deal.url, did };
}

// Re-send a brand's script notes to the script writer, exactly like the automatic "script changes" step:
// deal Next Action, video card back to Script Draft, note on the card (optional) and the Discord ping.
// Used when an email was filed the wrong way (e.g. notes that came with a brief link).
export async function resendScriptChanges({ brand, creator, feedback, addNote = true }) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const deals = await openDeals();
  const deal = deals.find((d) => norm(d.brand).includes(norm(brand)) && (!creator || norm(d.creator) === norm(creator)));
  if (!deal) throw new Error(`No open deal found for ${brand}${creator ? ' × ' + creator : ''}`);
  const who = `${deal.brand} × ${deal.creator || '?'}`;
  await patchDeal(deal, (set) => set('Next Action', 'Shreya revising the script'));
  const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 4).catch(() => null) : null;
  if (addNote && deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the script ${todayIST()}`, String(feedback).split('\n'));
  const ok = await discord(`${tag()} ✏️ **Script changes requested: ${who}**\n${String(feedback).slice(0, 900)}${deal.linkedVideo ? '\nNotion: ' + deal.linkedVideo : ''}`);
  await log({ event: `Script changes re-sent: ${who}`, outcome: 'Rule', email: { messageId: '' }, deal, details: String(feedback).slice(0, 500), creator: deal.creator });
  return { ok, deal: who, video: st };
}
