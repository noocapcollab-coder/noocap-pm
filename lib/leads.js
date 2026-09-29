// Leads: brand offers that land in a creator's own collab inbox (e.g. Chris), before the deal is locked
// and noocapcollab is tagged. The PM sorts every email (brand deal / collaboration vs outreach and spam), records
// the leads, and negotiates by the Rate Card and the NOOCAP playbook (see RULES below). Once a price is agreed it asks
// for the brief and adds noocapcollab, and from there the noocapcollab automation takes over.
// The code decides every number; the AI only reads emails and writes the words.
import { notion, plain, clearCache } from './notion.js';
import { DS, todayIST } from './tools.js';
import { claude, HAIKU, costOf } from './claude.js';
import { openDeals, log, discord } from './briefs.js';
import { createDraft, writeEmail, OUTBOX_DS } from './outbox.js';
import { threadSubject } from './mime.js';

const rt = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 1900) } }];
const lc = (s) => String(s ?? '').toLowerCase();
const addrOf = (s) => (String(s || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '';
const normBrand = (s) => lc(s).replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
const PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'YouTube Shorts', 'Facebook', 'Newsletter', 'X', 'LinkedIn'];
const RATE_DS = '511a4b57-a935-47a5-8e74-cf026ff57587';
const NOOCAP = 'noocapcollab@gmail.com';
const SIGN = () => (process.env.PM_SIGNATURE_CHRIS || 'Best,\nChris Cordero Team').replace(/\\n/g, '\n');
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const emailISO = (email) => { const t = Date.parse(email.date || ''); return new Date(Number.isFinite(t) ? t : Date.now()).toISOString(); };

// The latest message, without the quoted history under it
function latestText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From:\s.+|>)/i.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

// Free filter before any AI: system mail, receipts and newsletters that aren't part of a lead thread
function obviousNoise(email) {
  const from = lc(email.from);
  if (/mailer-daemon|postmaster|no-?reply@(?!.*(collab|partner|brand))|notifications?@|@(accounts\.google|google|youtube|github|notion|stripe|paypal|apple|amazon)\.com/.test(from)) return 'system email';
  const subj = `${email.subject || ''}`;
  if (/receipt|invoice #|your order|verify your|password|security alert|terms of service/i.test(subj)) return 'receipt or account email';
  if (/@(substack|beehiiv|mailchimp|mail\.beehiiv|convertkit|kit|mailerlite|sendgrid|linkedin|medium|producthunt|skool|circle)\./.test(from) || /newsletter|digest|weekly roundup|webinar/i.test(subj)) return 'newsletter';
  // Bulk mail (has an unsubscribe link) that never mentions a collaboration: skip without paying for AI
  const body = `${email.subject || ''} ${String(email.text || '').slice(0, 4000)}`;
  if (/unsubscribe/i.test(email.text || '') && !/collab|sponsor|partnership|partner|paid|promot|campaign|creator|influencer|ambassador|affiliate|rate|budget|feature|review|brief|deal/i.test(body)) return 'bulk mail';
  return null;
}

const LEAD_TOOL = {
  name: 'record_lead',
  description: 'Record what this email means for a creator\'s brand-deal pipeline.',
  input_schema: {
    type: 'object',
    properties: {
      is_lead: { type: 'boolean', description: 'True ONLY if a brand or its agency wants the creator to PROMOTE their product in content (paid, affiliate or gifted). False when someone wants to SELL something to the creator or work for them: job applications, freelancers (editors, designers, VAs, scriptwriters), agencies offering growth, editing, ads, SEO, app building or management services, sponsorship marketplaces, courses, tools pitched for the creator to use. Also false for newsletters, receipts and platform notices.' },
      not_lead_kind: { type: ['string', 'null'], enum: ['job_or_service_pitch', 'spam', 'newsletter_or_notice', 'other', null], description: 'When is_lead is false: job_or_service_pitch = outreach from someone applying for work or selling a service/tool to the creator; spam = scams, mass cold blasts, fake "collab" offers that ask the creator to pay, phishing; newsletter_or_notice = newsletters, receipts, platform emails; other = anything else.' },
      type: { type: 'string', enum: ['Paid offer', 'Affiliate', 'Gifted', 'Unclear'], description: 'Paid offer = a flat fee is offered or asked about. Affiliate = commission or revenue share only. Gifted = free product only.' },
      brand: { type: 'string', description: 'The product or company to be promoted, as the brand calls itself. Take it from the subject or signature, not from CC addresses.' },
      stage: { type: 'string', enum: ['new_offer', 'negotiating', 'will_get_back', 'agreed', 'declined', 'other'], description: 'Where the conversation stands after this latest message: new_offer = first outreach; negotiating = price, deliverables or terms being discussed; will_get_back = the brand says they will check internally / get back to us, with no new offer; agreed = both sides have agreed the deal (price and scope confirmed, or contract/brief being sent); declined = one side said no or went with someone else.' },
      offer: { type: 'string', description: 'One line: what the brand wants and what they offer.' },
      budget_usd: { type: ['number', 'null'], description: 'The latest fee on the table in USD (their offer or our counter, whichever is most recent), null if none.' },
      deliverables: { type: ['string', 'null'] },
      platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS } },
      next_step: { type: 'string', description: 'Short: what needs to happen next and by whom, e.g. "Reply with rate for 1 reel" or "Wait for brand to confirm budget".' },
      brand_asked_something: { type: 'boolean', description: 'True if the brand\'s latest message asks the creator side a question or for something.' },
    },
    required: ['is_lead', 'type', 'brand', 'stage', 'offer', 'next_step', 'brand_asked_something'],
  },
};

async function readLead(email, creator, ours = false, items = []) {
  const tool = JSON.parse(JSON.stringify(LEAD_TOOL));
  Object.assign(tool.input_schema.properties, {
    requested: { type: 'array', items: { type: 'object', properties: { item: items.length ? { type: 'string', enum: items } : { type: 'string' }, qty: { type: 'integer' } }, required: ['item', 'qty'] }, description: 'The deliverables the brand wants, mapped to the rate card items. Empty if they have not said.' },
    brand_offer_usd: { type: ['number', 'null'], description: 'A fee the brand proposes in its LATEST message (their budget or counter-offer), in USD. null if they did not name one.' },
    brand_refuses_paid: { type: 'boolean', description: 'True if the brand\'s latest message says they only do affiliate, gifted or unpaid collaborations, or have no budget at all.' },
    brand_accepts_our_price: { type: 'boolean', description: 'True only if the brand\'s latest message clearly agrees to the price we last quoted.' },
    asks_rate: { type: 'boolean', description: 'True if the brand asks for our rate, pricing or rate card.' },
    other_questions: { type: ['string', 'null'], description: 'Anything in the latest message besides price and deliverables that needs a human answer: usage rights, whitelisting, exclusivity, contract terms, payment terms, dates, audience stats or demographics, product questions. null if none.' },
  });
  const out = await claude({
    model: HAIKU,
    max_tokens: 1400,
    system: `You sort emails in the collab inbox of ${creator}, a content creator represented by NOOCAP Media. Brands and agencies email here about sponsored videos. Be precise and never invent details.${items.length ? ` ${creator}'s rate card items: ${items.join(', ')}.` : ''}`,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'record_lead' },
    messages: [{ role: 'user', content: `Today: ${todayIST()}\n${ours ? `This email was SENT by ${creator}'s side (the NOOCAP team) to the brand. Judge whether the thread is a brand deal, and read the brand, offer and price from it.\n` : ''}From: ${email.from || ''}\nTo: ${email.to || ''}\nCc: ${email.cc || ''}\nDate: ${email.date || ''}\nSubject: ${email.subject || ''}\n\nLatest message:\n${latestText(email.text).slice(0, 3500)}\n\nEarlier in the thread (for context only, cut short):\n${String(email.text || '').slice(latestText(email.text).length, latestText(email.text).length + 1500)}` }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  return { x: call?.input || { is_lead: false, type: 'Unclear', brand: '', stage: 'other', offer: '', next_step: '', brand_asked_something: false }, usage: out.usage };
}

async function findLead(threadId) {
  if (!threadId) return null;
  const r = await notion('POST', `/data_sources/${DS.leads}/query`, { page_size: 1, filter: { property: 'Thread ID', rich_text: { equals: threadId } } });
  return (r.results || [])[0] || null;
}

// Same brand in a new thread (brands often start a fresh email): reuse the open lead instead of making a second one
async function findLeadByBrand(brand, creator) {
  const b = normBrand(brand);
  if (b.length < 3) return null;
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const r = await notion('POST', `/data_sources/${DS.leads}/query`, { page_size: 50, filter: { and: [{ property: 'Creator', select: { equals: creator } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } }] } }).catch(() => ({ results: [] }));
  return (r.results || []).find((p) => { const n = normBrand(plain(p.properties?.Brand)); return n && (n === b || n.includes(b) || b.includes(n)) && !['Lost', 'Not a fit'].includes(plain(p.properties?.Status)); }) || null;
}

async function seen(messageId) {
  if (!messageId) return false;
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Message ID', rich_text: { equals: String(messageId).slice(0, 1900) } }, { property: 'Area', select: { equals: 'Inboxes' } }] } }).catch(() => ({ results: [] }));
  return (r.results || []).length > 0;
}

// Link a locked lead to its Brand Deal once noocapcollab is tagged and the deal exists
async function matchDeal(brand, creator) {
  const b = normBrand(brand);
  if (b.length < 3) return null;
  const deals = await openDeals().catch(() => []);
  return deals.find((d) => d.creator === creator && (normBrand(d.brand).includes(b) || b.includes(normBrand(d.brand)))) || null;
}

// Gmail labels n8n puts on the thread in the creator's inbox, one per status (create them once in Gmail)
export const PITCH_LABEL = 'Deals/Outreach & spam';
export const GMAIL_LABEL = { 'New offer': 'Deals/New offer', Negotiating: 'Deals/Negotiating', 'Needs approval': 'Deals/Negotiating', 'Waiting on brand': 'Deals/Waiting on brand', Locked: 'Deals/Closed', 'Affiliate only': 'Deals/Affiliate', Lost: 'Deals/Lost', 'Not a fit': 'Deals/Lost' };
const withLabel = (res) => (res.status && GMAIL_LABEL[res.status] ? { ...res, label: GMAIL_LABEL[res.status] } : res);

const STATUS = { new_offer: 'New offer', negotiating: 'Negotiating', agreed: 'Negotiating', will_get_back: 'Waiting on brand', declined: 'Lost' }; // Locked only when the closing email goes out or noocapcollab is tagged
const newer = (a, b) => !b || Date.parse(a) >= Date.parse(b);

// ---- The conversation, kept on the lead so follow-ups can read it ----
// milda@tryholo.ai -> Milda (skips role inboxes like partnerships@ or hello@)
const nameFromEmail = (addr) => { const local = String(addr || '').split('@')[0]; const l = local.split(/[._-]/)[0]; if (!/[._-]/.test(local) && l.length > 6) return ''; return /^[a-z]{3,12}$/i.test(l) && !/^(info|hello|hi|team|partner|partners|partnerships|collab|collabs|marketing|brand|brands|creator|creators|influencer|influencers|pr|press|business|contact|support|admin|sales|growth|social|media|hey|mail|office|noreply|no|campaigns?|ads|affiliates?|hezuo\w*|shangwu\w*)$/i.test(l) ? l[0].toUpperCase() + l.slice(1).toLowerCase() : ''; };
// The newest email in the thread (ours or theirs) with the earlier messages quoted under it, up to ~8,000 characters.
const rtLong = (s) => { const t = String(s || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').slice(0, 8000); const out = []; for (let i = 0; i < t.length; i += 1900) out.push({ type: 'text', text: { content: t.slice(i, i + 1900) } }); return out.length ? out : rt(''); };
const threadOf = (page) => (page?.properties?.['Thread Text']?.rich_text || []).map((t) => t.plain_text || t.text?.content || '').join('');
async function saveThread(leadPage, email, at) {
  if (!leadPage?.id || !email?.text) return;
  const had = plain(leadPage.properties?.['Thread At']);
  if (had && Date.parse(had) > Date.parse(at)) return; // keep the newest email
  const props = { 'Thread Text': { rich_text: rtLong(`From: ${email.from || ''}\nDate: ${email.date || ''}\n\n${email.text}`) }, 'Thread At': { date: { start: at } } };
  if (!email.sent) { const n = firstName(email.from); if (n !== 'there') props['Contact Name'] = { rich_text: rt(n) }; }
  await notion('PATCH', `/pages/${leadPage.id}`, { properties: props }).catch(() => {});
}

// ---- The negotiation playbook (NOOCAP rules) ----
// Quote the short-form rate first and share bundle/dedicated rates only when asked.
// Come down $100 per round, at most 3 rounds, never below the floor; the preferred zone is list down to "preferred min".
// Offers below the floor but above the lowball line go to Harsh for approval on Discord; lowballs get "this is our rate".
// First follow-up (3 days quiet) offers a lock-in price $200 lower if they confirm that week; the second (2 days later) is a plain nudge.
export const RULES = { STEP: 100, MAX_ROUNDS: 3, LOCK_IN_OFF: 200, FIRST_NUDGE_DAYS: 3, SECOND_NUDGE_DAYS: 2, MAX_NUDGES: 2 };
const r50 = (n) => Math.round(n / 50) * 50;

// New Notion columns this playbook needs, added once if missing (Harsh doesn't have to create them)
let schemaDone = false;
async function ensureSchema() {
  if (schemaDone) return;
  schemaDone = true;
  await notion('PATCH', `/data_sources/${DS.leads}`, { properties: { 'Ask USD': { number: {} }, 'Quoted For': { rich_text: {} }, 'Rate Holds': { number: {} }, 'Approval USD': { number: {} }, 'Thread Text': { rich_text: {} }, 'Thread At': { date: {} }, 'Contact Name': { rich_text: {} } } }).catch(() => {});
  await notion('PATCH', `/data_sources/${RATE_DS}`, { properties: { 'Preferred Min USD': { number: {} }, 'Floor USD': { number: {} }, 'Reject Below USD': { number: {} }, Includes: { rich_text: {} }, Default: { checkbox: {} } } }).catch(() => {});
}

export async function rateCard(creator) {
  await ensureSchema();
  const r = await notion('POST', `/data_sources/${RATE_DS}/query`, { page_size: 100, filter: { property: 'Creator', select: { equals: creator } } }).catch(() => ({ results: [] }));
  return (r.results || []).map((p) => {
    const g = (n) => plain(p.properties?.[n]);
    const list = Number(g('List USD') || 0), maxOff = Number(g('Max Discount USD') || 0);
    return { item: g('Deliverable'), list, pref: Number(g('Preferred Min USD') || 0), floor: Number(g('Floor USD') || 0) || (maxOff ? list - maxOff : 0), reject: Number(g('Reject Below USD') || 0), includes: g('Includes') || g('Notes') || '', isDefault: g('Default') === true };
  }).filter((i) => i.item && i.list > 0);
}

// The item we lead with: the row ticked Default, else anything short-form, else the cheapest
export const defaultItem = (card) => card.find((c) => c.isDefault) || card.find((c) => /short|reel/i.test(c.item)) || [...card].sort((a, b) => a.list - b.list)[0];

// Price bands for a set of deliverables. Blank rate-card cells fall back to the NOOCAP ratios ($1,800 → prefer ≥ $1,500, floor $1,200, lowball under $650)
function bands(rows) {
  const sum = (f) => rows.reduce((n, r) => n + f(r.c) * r.qty, 0);
  const list = sum((c) => c.list);
  const pref = Math.min(list, sum((c) => c.pref || r50(c.list * 5 / 6)));
  const floor = Math.min(pref, sum((c) => c.floor || r50(c.list * 2 / 3)));
  const reject = Math.min(floor - 50, sum((c) => c.reject || r50(c.list * 0.35)));
  return { list, pref, floor, reject };
}
const bandsFromList = (list, floor) => ({ list, pref: r50(list * 5 / 6), floor: floor || r50(list * 2 / 3), reject: r50(list * 0.35) });
// A lead quoted by hand before the PM (no "Quoted For"): keep their price, but the Rate Card's lines still hold
function legacyBands(card, ask) {
  const def = card.length ? defaultItem(card) : null;
  if (!def) return bandsFromList(ask);
  const b = bands([{ c: def, qty: 1 }]);
  return { list: ask, pref: Math.min(ask, b.pref), floor: Math.min(ask, b.floor), reject: b.reject, cardPref: b.pref };
}
const keyOf = (rows) => rows.map((r) => `${r.qty > 1 ? r.qty + ' × ' : ''}${r.c.item}`).join(' + ');
const rowsFromKey = (key, card) => String(key || '').split(' + ').map((part) => { const m = part.match(/^(\d+) × (.+)$/); const item = m ? m[2] : part; return { c: card.find((c) => c.item === item), qty: m ? Number(m[1]) : 1 }; });

// Pure decision: what to send (or ask Harsh), given the lead's state and what the brand just said.
// lead = { ask, quotedFor, quoted, floor, counters, holds } read from the Leads row
export function decide({ x, card, lead = {} }) {
  if (x.other_questions) return { action: 'handoff', reason: x.other_questions };
  if (!card.length) return { action: 'handoff', reason: 'No rate card for this creator yet' };
  const req = (x.requested || []).map((r) => ({ c: card.find((c) => c.item === r.item), qty: Math.max(1, r.qty || 1) })).filter((r) => r.c);
  const reqKey = req.length ? keyOf(req) : '';
  const def = defaultItem(card);
  const askingNew = reqKey && reqKey !== lead.quotedFor && (lead.quotedFor || req.some((r) => r.c !== def || r.qty > 1));
  // Nothing quoted yet, or the brand is now asking about a different package (bundle, dedicated video): a fresh quote
  if (!lead.ask || askingNew) {
    const rows = req.length ? req : [{ c: def, qty: 1 }];
    const s = { ...bands(rows), what: keyOf(rows), quotedFor: keyOf(rows), includes: rows.map((r) => r.c.includes).filter(Boolean).join(' '), counters: 0, holds: 0 };
    return judge(x, { ...s, ask: s.list, first: !lead.ask, standard: rows.length === 1 && rows[0].c === def && rows[0].qty === 1 }, true);
  }
  let b = null;
  const rows = lead.quotedFor ? rowsFromKey(lead.quotedFor, card) : [];
  if (rows.length && rows.every((r) => r.c)) b = bands(rows);
  else b = legacyBands(card, lead.ask || lead.quoted);
  const incl = rows.filter((r) => r.c).map((r) => r.c.includes).filter(Boolean).join(' ');
  return judge(x, { ...b, ask: lead.ask, what: lead.quotedFor || 'the collaboration', quotedFor: lead.quotedFor, includes: incl, counters: lead.counters || 0, holds: lead.holds || 0 }, false);
}

function judge(x, s, first) {
  const { STEP, MAX_ROUNDS } = RULES;
  if (!first && x.brand_accepts_our_price) return { action: 'close', price: s.ask, ...s };
  const offer = x.brand_offer_usd > 0 ? x.brand_offer_usd : x.brand_refuses_paid ? 0 : null;
  if (offer === null) return first ? { action: 'quote', price: s.ask, ...s } : { action: 'none', ...s };
  if (offer >= s.ask - STEP) return { action: 'close', price: offer, ...s };
  if (offer >= s.floor) {
    if (s.counters < MAX_ROUNDS) return { action: 'counter', price: Math.max(s.floor, s.ask - STEP), round: s.counters + 1, ...s };
    return { action: 'close', price: offer, ...s }; // three rounds done and they're still inside the target range: take it
  }
  if (offer >= s.reject && offer > 0) return { action: 'approval', offer, ...s };
  if (s.holds >= 1) return { action: 'decline', ...s }; // they came back low again after "this is our rate"
  return { action: 'hold', price: s.ask, offer, ...s };
}

const KIND = { quote: 'Quote', counter: 'Counter', close: 'Close deal', hold: 'Rate hold', decline: 'Decline' };
const leadState = (g) => ({ ask: Number(g('Ask USD') || 0) || (Number(g('Our Counters') || 0) > 0 ? Number(g('Floor USD') || 0) : Number(g('Quoted USD') || 0)), quotedFor: g('Quoted For') || '', quoted: Number(g('Quoted USD') || 0), floor: Number(g('Floor USD') || 0), counters: Number(g('Our Counters') || 0), holds: Number(g('Rate Holds') || 0) });
const pseudoOf = (g, email) => ({ brand: g('Brand'), creator: g('Creator') || 'Chris', stage: 'Negotiating', brandEmail: email ? addrOf(email.from) : g('Brand Email'), threadId: email?.threadId || g('Thread ID'), messageRfc: email?.messageId || g('Message ID'), threadSubject: email ? threadSubject(email.subject) : g('Thread Subject') });
const FALLBACK = {
  quote: (d) => `Thanks for reaching out, we'd love to work with you! Our rate for ${d.what} is ${usd(d.price)}.${d.includes ? ' That includes ' + d.includes.replace(/\.$/, '') + '.' : ''} Let us know and we can get started.`,
  counter: (d) => `Thanks for coming back to us. We can do ${usd(d.price)} for ${d.what}.`,
  close: (d) => `${usd(d.price)} works for us. Please share the brief, and I'm adding our team at ${NOOCAP} to this thread, who will handle everything from here.`,
  hold: (d) => `Thanks for the offer. Our rate for ${d.what} is ${usd(d.price)}, so if that works for you we can go ahead, and if not we'll have to pass on this one.`,
  decline: () => `Thanks for coming back to us. Unfortunately that budget doesn't work for us, so we'll pass on this one, but we'd be glad to work together in the future.`,
  nudge: (d) => d.lockIn ? `Just following up on this. If you can lock it in this week, we can do ${usd(d.price)} for ${d.what}.` : `Just following up on this. Let us know if you'd like to go ahead, or if there's anything you need from us.`,
};

// NOOCAP's standard first reply for a short-form deal, word for word. Only the name, brand and price change.
const firstName = (from) => { const n = String(from || '').replace(/<.*>/, '').replace(/["']/g, '').trim().split(/\s+/)[0] || ''; return /^[A-Za-z][a-z'-]{1,20}$/.test(n) && !/team|info|hello|partner|collab|marketing|brand/i.test(n) ? n : 'there'; };
export function standardReply({ name, brand, price, extra = '', closing = '' }) {
  return `Hey ${name},

Thanks for reaching out! ${brand} looks like a great fit for our audience.
${extra ? '\n' + extra + '\n' : ''}
Our rate for a dedicated short-form video/reel is ${usd(price)}, which includes 1 video cross-posted across TikTok, Instagram Reels, YouTube Shorts, and Facebook Reels.

What's included:
• Concept & script written by us from your brief
• 2 rounds of revisions
• Multi-platform posting (TikTok, IG, YT Shorts, FB)
• Performance recap 7 days after posting

Payment terms:
• To lock in the slot on our calendar, we do 50% upfront upon contract signing and the remaining 50% once the video is published.

To get paperwork and invoicing set up, could you share:
• Legal company name & billing address
• Billing / AP email (and PO number if needed)
• Payment method (wire/ACH or PayPal)
• Contact person for script sign-off

Once the agreement is signed and deposit is confirmed, we'll deliver the script draft within 3 business days.
${closing ? '\n' + closing + '\n' : ''}
Looking forward to working together!

${SIGN()}`;
}

// Write the email and file it as a Chris-inbox draft. The price in the email must be ours exactly, or a plain template is used.
async function draftLeadEmail({ kind, action, d, leadId, pseudo, cc = '', their = '', extra = {}, why, template }) {
  if (template) return createDraft({ kind, deal: pseudo, subject: 'Re: ' + (pseudo.threadSubject || pseudo.brand), body: template, cc, sendFrom: 'Chris', leadId, notify: false, why });
  const facts = { deliverables: d.what, includes: d.includes || undefined, their_latest_message: their ? their.slice(0, 1500) : undefined, today: todayIST(), ...extra };
  if (d.price != null) facts.price_usd = usd(d.price);
  const mail = await writeEmail({ kind, deal: pseudo, signature: SIGN(), facts });
  const digits = d.price != null ? String(Math.round(d.price)) : null;
  if (!mail.body || (digits && !mail.body.replace(/[,\s]/g, '').includes(digits))) mail.body = `Hi,\n\n${FALLBACK[action](d)}\n\n${SIGN()}`;
  return createDraft({ kind, deal: pseudo, subject: mail.subject, body: mail.body, cc, sendFrom: 'Chris', leadId, notify: false, why });
}

async function negotiate({ email, x, leadPage, creator }) {
  const g = (n) => plain(leadPage.properties?.[n]);
  const card = await rateCard(creator);
  if (!card.length) return 'no rate card yet, nothing drafted';
  const d = decide({ x, card, lead: leadState(g) });
  const brand = g('Brand') || x.brand || 'Brand';
  const numbers = {};
  if (d.list && d.quotedFor && d.quotedFor !== g('Quoted For')) Object.assign(numbers, { 'Quoted USD': { number: d.list }, 'Floor USD': { number: d.floor } });
  const link = process.env.PM_PUBLIC_URL ? `\n→ Approve or decline: ${process.env.PM_PUBLIC_URL.replace(/\/$/, '')}/#deals` : `\n→ [Lead in Notion](${leadPage.url})`;
  if (d.action === 'handoff') {
    await notion('PATCH', `/pages/${leadPage.id}`, { properties: { ...numbers, 'Next Step': { rich_text: rt('Needs you: ' + d.reason) } } });
    await discord(`💬 **${brand} × ${creator} · needs you** (Chris's inbox)\n• ${String(d.reason).slice(0, 220)}\n→ [Lead in Notion](${leadPage.url})`, 'pm');
    return 'handed to Harsh: ' + d.reason;
  }
  if (d.action === 'approval') {
    await notion('PATCH', `/pages/${leadPage.id}`, { properties: { ...numbers, Status: { select: { name: 'Needs approval' } }, 'Approval USD': { number: d.offer }, 'Next Step': { rich_text: rt(`Approve or decline ${usd(d.offer)} (our ask ${usd(d.ask)}, floor ${usd(d.floor)})`) } } });
    await discord(`🟡 **${brand} × ${creator} · approval needed**\n• The brand is insisting on ${usd(d.offer)} for ${d.what} and wants to proceed at that budget\n• Our ask ${usd(d.ask)}, lowest we go on our own ${usd(d.floor)}${link}`, 'pm');
    return `asked Harsh to approve ${usd(d.offer)}`;
  }
  if (d.action === 'none') { if (Object.keys(numbers).length) await notion('PATCH', `/pages/${leadPage.id}`, { properties: numbers }); return 'nothing to answer'; }
  const kind = KIND[d.action];
  const ccs = (`${email.cc || ''}`.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).filter((a) => !/noocapcollab|chriscordero/i.test(a));
  const cc = [...ccs, ...(d.action === 'close' ? [NOOCAP] : [])].join(', ');
  const tag = `${d.price != null ? `[price:${Math.round(d.price)}]` : ''}${d.action === 'quote' ? `[for:${d.quotedFor}]` : ''}`;
  const label = { quote: `quote at ${usd(d.price)}`, counter: `counter ${d.round} of ${RULES.MAX_ROUNDS} at ${usd(d.price)}`, close: `close at ${usd(d.price)}`, hold: `"this is our rate" at ${usd(d.price)} (they offered ${usd(d.offer || 0)})`, decline: 'decline (still too low after our rate)' }[d.action];
  // First reply on a short-form deal: the standard NOOCAP email (quote, or the same email at our counter / with the "otherwise we pass" line)
  let template = null;
  if (d.first && d.standard && ['quote', 'counter', 'hold'].includes(d.action)) {
    const t = { name: firstName(email.from), brand, price: d.price };
    if (d.action === 'counter') t.extra = 'Thanks for sharing your budget. We have put together the best rate we can do for you below.';
    if (d.action === 'hold') t.closing = `If that rate works for you we can go ahead, otherwise we'll have to pass on this one.`;
    template = standardReply(t);
  }
  await draftLeadEmail({ template, kind, action: d.action, d, leadId: leadPage.id, pseudo: pseudoOf(g, email), cc, their: latestText(email.text), extra: d.action === 'quote' ? { first_reply: true } : d.action === 'hold' ? { their_offer_usd: usd(d.offer || 0) } : {}, why: `${brand}: ${label} for ${d.what} (list ${usd(d.list)}, floor ${usd(d.floor)}) ${tag}` });
  await notion('PATCH', `/pages/${leadPage.id}`, { properties: { ...numbers, 'Next Step': { rich_text: rt(`${kind} ${d.price != null ? 'at ' + usd(d.price) + ' ' : ''}waiting in Approvals`) } } });
  return `${kind.toLowerCase()} drafted${d.price != null ? ' at ' + usd(d.price) : ''}`;
}

// Harsh approved a below-floor offer on the dashboard: draft the close at that rate
export async function approveLead(leadId, price) {
  const lp = await notion('GET', `/pages/${leadId}`);
  const g = (n) => plain(lp.properties?.[n]);
  const amount = Number(price || g('Approval USD') || 0);
  if (!amount) throw new Error('No amount to approve');
  const d = { price: amount, what: g('Quoted For') || g('Deliverables') || 'the collaboration' };
  await draftLeadEmail({ kind: 'Close deal', action: 'close', d, leadId, pseudo: pseudoOf(g), cc: NOOCAP, extra: { approved_by_team: true }, why: `${g('Brand')}: close at ${usd(amount)}, approved by Harsh [price:${Math.round(amount)}]` });
  await notion('PATCH', `/pages/${leadId}`, { properties: { Status: { select: { name: 'Negotiating' } }, 'Next Step': { rich_text: rt(`Approved at ${usd(amount)}: close email waiting in Approvals`) } } });
  clearCache();
  return { ok: true, drafted: 'Close deal', price: amount };
}

// Harsh said no: draft a polite decline; the lead moves to Lost when it's sent
export async function declineLead(leadId) {
  const lp = await notion('GET', `/pages/${leadId}`);
  const g = (n) => plain(lp.properties?.[n]);
  await draftLeadEmail({ kind: 'Decline', action: 'decline', d: { price: null, what: g('Quoted For') || g('Deliverables') || 'the collaboration' }, leadId, pseudo: pseudoOf(g), why: `${g('Brand')}: decline, Harsh said no to ${usd(Number(g('Approval USD') || 0))}` });
  await notion('PATCH', `/pages/${leadId}`, { properties: { Status: { select: { name: 'Negotiating' } }, 'Next Step': { rich_text: rt('Declined by Harsh: decline email waiting in Approvals') } } });
  clearCache();
  return { ok: true, drafted: 'Decline' };
}

// After a negotiation email from Chris's inbox is sent: move the lead along
export async function afterLeadSend(draft) {
  const lp = await notion('GET', `/pages/${draft.leadId}`);
  const g = (n) => plain(lp.properties?.[n]);
  const price = Number((draft.why.match(/\[price:(\d+)\]/) || [])[1] || 0);
  const quotedFor = (draft.why.match(/\[for:([^\]]+)\]/) || [])[1];
  const props = { 'Last Our Email': { date: { start: new Date().toISOString() } } };
  const waiting = { select: { name: 'Waiting on brand' } };
  if (price && ['Quote', 'Counter', 'Rate hold', 'Lead follow-up'].includes(draft.kind)) props['Ask USD'] = { number: price };
  if (draft.kind === 'Quote') Object.assign(props, { Status: waiting, 'Our Counters': { number: 0 }, 'Rate Holds': { number: 0 }, 'Follow-ups': { number: 0 }, ...(quotedFor ? { 'Quoted For': { rich_text: rt(quotedFor) } } : {}) });
  if (draft.kind === 'Counter') Object.assign(props, { Status: waiting, 'Our Counters': { number: Number(g('Our Counters') || 0) + 1 }, 'Follow-ups': { number: 0 } });
  if (draft.kind === 'Rate hold') Object.assign(props, { Status: waiting, 'Rate Holds': { number: Number(g('Rate Holds') || 0) + 1 } });
  if (draft.kind === 'Lead follow-up') props['Follow-ups'] = { number: Number(g('Follow-ups') || 0) + 1 };
  if (draft.kind === 'Decline') Object.assign(props, { Status: { select: { name: 'Lost' } }, 'Next Step': { rich_text: rt('Declined') } });
  if (draft.kind === 'Close deal') Object.assign(props, { Status: { select: { name: 'Locked' } }, ...(price ? { 'Agreed USD': { number: price } } : {}), 'Next Step': { rich_text: rt('Handed to noocapcollab: waiting for the brief') } });
  await notion('PATCH', `/pages/${draft.leadId}`, { properties: props });
}

// Heartbeat: brand quiet after our quote (or after saying they'll get back to us).
// Nudge 1 after 3 days offers the lock-in price ($200 off if they confirm this week, never below preferred min);
// nudge 2 comes 2 days later at the same price. Then we stop.
export async function leadFollowUps() {
  const { LOCK_IN_OFF, FIRST_NUDGE_DAYS, SECOND_NUDGE_DAYS, MAX_NUDGES } = RULES;
  const r = await notion('POST', `/data_sources/${DS.leads}/query`, { page_size: 100, filter: { property: 'Status', select: { equals: 'Waiting on brand' } }, sorts: [{ property: 'Last Our Email', direction: 'ascending' }] }).catch(() => ({ results: [] }));
  const made = [];
  const PER_RUN = 8; // each follow-up is written by the AI; the rest are picked up on the next run a few minutes later
  for (const p of r.results || []) {
    if (made.length >= PER_RUN) break;
    const g = (n) => plain(p.properties?.[n]);
    const our = g('Last Our Email'), theirs = g('Last Brand Email');
    const last = [our, theirs].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    if (!last || !g('Brand Email')) continue;
    const st = leadState(g);
    if (!st.ask) continue;
    const nudges = Number(g('Follow-ups') || 0);
    const days = (Date.now() - Date.parse(last)) / 864e5;
    if (nudges >= MAX_NUDGES || days > 30 || days < (nudges === 0 ? FIRST_NUDGE_DAYS : SECOND_NUDGE_DAYS)) continue;
    const pending = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Lead', relation: { contains: p.id } }] } }).catch(() => ({ results: [] }));
    if ((pending.results || []).length) continue;
    const card = await rateCard(g('Creator') || 'Chris');
    const rows = st.quotedFor ? rowsFromKey(st.quotedFor, card) : [];
    const b = rows.length && rows.every((x) => x.c) ? bands(rows) : legacyBands(card, st.ask);
    // The lock-in discount never goes under the Rate Card's preferred minimum ($1,500 for a $1,800 short-form)
    const prefLine = Math.max(b.pref, b.cardPref || 0);
    // Leads quoted by hand before the PM: the stored price was guessed from old emails, so their follow-ups never name a price
    const legacy = !st.quotedFor;
    const lockIn = !legacy && nudges === 0 && st.counters === 0 && st.ask - LOCK_IN_OFF >= prefLine;
    const price = lockIn ? st.ask - LOCK_IN_OFF : st.ask;
    // The stored email thread if we have it; otherwise the summary the PM wrote when it read the thread
    const summary = [g('Offer') && `What this deal is about: ${g('Offer')}`, g('Deliverables') && `Deliverables: ${g('Deliverables')}`, g('Platforms') && `Platforms: ${g('Platforms')}`, g('Next Step') && `Where it stood: ${g('Next Step')}`, g('Thread Subject') && `Email subject: ${g('Thread Subject')}`].filter(Boolean).join('\n');
    const conversation = threadOf(p) || (g('Offer') ? `(Only a summary of the thread is available, not the emails themselves.)\n${summary}` : '');
    if (!conversation) continue; // nothing at all to go on: wait rather than send a blind nudge
    const what = st.quotedFor || g('Deliverables') || 'the collaboration';
    await draftLeadEmail({ kind: 'Lead follow-up', action: 'nudge', d: { price: lockIn ? price : null, what, lockIn, rate: st.ask }, leadId: p.id, pseudo: pseudoOf(g),
      extra: { conversation: conversation.slice(0, 7000), contact_name: g('Contact Name') || nameFromEmail(g('Brand Email')) || undefined, our_rate_usd: legacy ? undefined : usd(st.ask), mention_no_price: legacy || undefined, days_waiting: Math.round(days), nudge_number: nudges + 1, lock_in_this_week: lockIn, usual_price_usd: lockIn ? usd(st.ask) : undefined },
      why: `${g('Brand')}: quiet ${Math.round(days)} days, nudge ${nudges + 1} of ${MAX_NUDGES}${lockIn ? `, lock-in offer ${usd(price)} (from ${usd(st.ask)}) if they confirm this week` : legacy ? ', no price mentioned (quoted by hand before the PM)' : `, our rate ${usd(st.ask)} stands`}${legacy ? '' : ` [price:${Math.round(price)}]`}` });
    made.push(g('Brand'));
  }
  return made;
}

export async function handleLeadEmail(email) {
  const creator = email.creator || 'Chris';
  const lg = (event, outcome, details, extra = {}) => log({ event, outcome, email, details, area: 'Inboxes', source: 'Creator inbox', creator, ...extra }).catch(() => {});
  const at = emailISO(email);
  await ensureSchema();
  if (await seen(email.messageId)) {
    // Already handled, but older leads may not have the conversation stored yet: keep it for follow-ups (no AI used)
    const known = await findLead(email.threadId).catch(() => null);
    if (known && (!plain(known.properties?.['Thread At']) || Date.parse(plain(known.properties?.['Thread At'])) < Date.parse(at))) await saveThread(known, email, at);
    return { action: 'skipped', why: 'already handled' };
  }
  let lead = await findLead(email.threadId);
  const get = (n) => plain(lead?.properties?.[n]); // reads whichever lead we end up with

  // Our side wrote (the team replying from the creator's inbox)
  if (email.sent && !lead) {
    // A quote or reply we sent where the brand's earlier emails are outside the window: still a lead, now waiting on them
    const { x, usage } = await readLead(email, creator, true);
    const cost = costOf(usage);
    if (!x.is_lead) { await lg(`Lead · our email, not a deal: ${email.subject || ''}`, 'Skipped', x.offer || '', { usage, cost, side: 'ours' }); return { action: 'recorded', why: 'our email, not a lead' }; }
    const same = await findLeadByBrand(x.brand, creator);
    if (same) {
      const g2 = (n) => plain(same.properties?.[n]);
      const props = {};
      if (newer(at, g2('Last Our Email'))) props['Last Our Email'] = { date: { start: at } };
      if (['New offer', 'Negotiating'].includes(g2('Status')) && newer(at, g2('Last Brand Email'))) props.Status = { select: { name: 'Waiting on brand' } };
      if (Object.keys(props).length) await notion('PATCH', `/pages/${same.id}`, { properties: props });
      await saveThread(same, email, at);
      await lg(`Lead · we replied (other thread): ${x.brand} × ${creator}`, 'Rule', 'Matched an existing lead for this brand', { usage, cost, side: 'ours' });
      return withLabel({ action: 'recorded', why: 'our email on an existing lead', status: props.Status?.select?.name || g2('Status') });
    }
    const tagged = /noocapcollab/i.test(`${email.to || ''} ${email.cc || ''}`);
    const props = {
      Brand: { title: rt(x.brand || threadSubject(email.subject) || 'Unknown brand') },
      Creator: { select: { name: creator } },
      Status: { select: { name: tagged ? 'Locked' : x.type === 'Affiliate' ? 'Affiliate only' : 'Waiting on brand' } },
      Type: { select: { name: x.type || 'Unclear' } },
      Offer: { rich_text: rt(x.offer) },
      'Next Step': { rich_text: rt(x.next_step) },
      'Brand Email': { email: addrOf(email.to) || null },
      'Thread ID': { rich_text: rt(email.threadId) },
      'Message ID': { rich_text: rt(email.messageId) },
      'Thread Subject': { rich_text: rt(threadSubject(email.subject)) },
      'Last Our Email': { date: { start: at } },
    };
    if (x.budget_usd) Object.assign(props, { 'Budget USD': { number: x.budget_usd }, 'Ask USD': { number: x.budget_usd }, 'Quoted USD': { number: x.budget_usd } }); // our own price, so negotiation and nudges carry on from it
    if (x.deliverables) props.Deliverables = { rich_text: rt(x.deliverables) };
    const plats = (x.platforms || []).filter((p) => PLATFORMS.includes(p));
    if (plats.length) props.Platforms = { multi_select: plats.map((name) => ({ name })) };
    await ensureSchema();
    const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.leads }, properties: props });
    await saveThread(page, email, at);
    clearCache();
    await lg(`Lead added from our email: ${x.brand || email.subject} × ${creator}`, 'Rule', `Waiting on brand · ${x.offer || ''}`, { usage, cost, side: 'ours' });
    return withLabel({ action: 'filed', lead: page.url, status: props.Status.select.name });
  }
  if (email.sent) {
    if (lead) {
      const props = {};
      if (newer(at, get('Last Our Email'))) props['Last Our Email'] = { date: { start: at } };
      if (['New offer', 'Negotiating'].includes(get('Status')) && newer(at, get('Last Brand Email'))) props.Status = { select: { name: 'Waiting on brand' } };
      if (Object.keys(props).length) await notion('PATCH', `/pages/${lead.id}`, { properties: props });
      await saveThread(lead, email, at);
    }
    await lg(`Lead · we replied: ${email.subject || ''}`, 'Rule', lead ? 'Recorded our reply on the lead' : 'Our email, no lead for this thread', { side: 'ours' });
    const now = lead ? (['New offer', 'Negotiating'].includes(get('Status')) && newer(at, get('Last Brand Email')) ? 'Waiting on brand' : get('Status')) : null;
    return withLabel({ action: 'recorded', why: 'our email', status: now });
  }

  if (!lead) {
    const noise = obviousNoise(email);
    if (noise) { await lg(`Lead skipped (${noise}): ${email.subject || ''}`, 'Skipped', `From ${email.from || '?'}, no AI used`, { side: 'other' }); return { action: 'skipped', why: noise }; }
  }

  const card = await rateCard(creator);
  const { x, usage } = await readLead(email, creator, false, card.map((c) => c.item));
  const cost = costOf(usage);
  if (!lead && x.is_lead) {
    lead = await findLeadByBrand(x.brand, creator);
    // Follow the newest thread for this brand
    if (lead && newer(at, plain(lead.properties?.['Last Brand Email']))) await notion('PATCH', `/pages/${lead.id}`, { properties: { 'Thread ID': { rich_text: rt(email.threadId) }, 'Thread Subject': { rich_text: rt(threadSubject(email.subject)) } } }).catch(() => {});
  }
  if (!x.is_lead && !lead) {
    const kind = x.not_lead_kind === 'job_or_service_pitch' ? 'outreach' : x.not_lead_kind === 'spam' ? 'spam' : null;
    await lg(`Lead skipped (${kind || 'not a brand deal'}): ${email.subject || ''}`, 'Skipped', x.offer || 'Not about a sponsorship', { usage, cost, side: 'other' });
    // Outreach (job applications, people selling services) and spam are ignored and moved to their own Gmail label
    return kind ? { action: 'skipped', why: kind, label: PITCH_LABEL } : { action: 'skipped', why: 'not a lead' };
  }

  const tagged = /noocapcollab/i.test(`${email.to || ''} ${email.cc || ''}`);
  let status = tagged ? 'Locked' : STATUS[x.stage] || (lead ? 'Negotiating' : 'New offer');
  // Affiliate or gifted offers are negotiated like any other: we answer with our paid rate
  if (lead && get('Status') === 'Needs approval' && !['Locked', 'Lost'].includes(status)) status = 'Needs approval'; // waiting on Harsh, don't re-ask
  // A brand writing back reopens a lead we were waiting on
  if (lead && status === 'New offer') status = 'Negotiating';
  // Never move a lead backwards because of an older email (emails can arrive out of order during catch-up)
  if (lead && ['Locked', 'Lost'].includes(get('Status')) && !newer(at, get('Last Brand Email'))) status = get('Status');
  const oursLater = lead && get('Last Our Email') && Date.parse(get('Last Our Email')) > Date.parse(at);
  const oursLaterFlag = () => !!oursLater;
  if (oursLater && !['Locked', 'Lost'].includes(status)) status = get('Status') || 'Waiting on brand';

  const props = {
    Status: { select: { name: status } },
    Type: { select: { name: x.type || 'Unclear' } },
    Offer: { rich_text: rt(x.offer) },
    'Next Step': { rich_text: rt(x.next_step) },
  };
  if (!lead || newer(at, get('Last Brand Email'))) props['Last Brand Email'] = { date: { start: at } };
  // An older email only fills gaps; the newest email decides the price and next step
  const latest = !lead || newer(at, get('Last Brand Email')) && !oursLater;
  if (!latest) { delete props.Offer; delete props['Next Step']; delete props.Type; }
  if (x.budget_usd && (latest || !get('Budget USD'))) props['Budget USD'] = { number: x.budget_usd };
  if (x.deliverables && (latest || !get('Deliverables'))) props.Deliverables = { rich_text: rt(x.deliverables) };
  const plats = (x.platforms || []).filter((p) => PLATFORMS.includes(p));
  if (plats.length) props.Platforms = { multi_select: plats.map((name) => ({ name })) };
  if (status === 'Locked') {
    const deal = await matchDeal(x.brand, creator);
    if (deal) props.Deal = { relation: [{ id: deal.id }] };
  }

  let page;
  if (lead) {
    page = await notion('PATCH', `/pages/${lead.id}`, { properties: props });
  } else {
    Object.assign(props, {
      Brand: { title: rt(x.brand || threadSubject(email.subject) || 'Unknown brand') },
      Creator: { select: { name: creator } },
      'Brand Email': { email: addrOf(email.from) || null },
      'Thread ID': { rich_text: rt(email.threadId) },
      'Message ID': { rich_text: rt(email.messageId) },
      'Thread Subject': { rich_text: rt(threadSubject(email.subject)) },
    });
    page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.leads }, properties: props });
  }
  await saveThread(lead || page, email, at);
  clearCache();
  // Negotiate only on the newest, fresh brand email of a live paid lead
  let did = '';
  const fresh = (Date.now() - Date.parse(at)) / 36e5 <= 36;
  const isLatest = !oursLaterFlag() && (!lead || newer(at, get('Last Brand Email')));
  if (fresh && isLatest && !tagged && ['New offer', 'Negotiating', 'Waiting on brand', 'Affiliate only', 'Needs approval'].includes(status)) {
    const leadPage = lead ? await notion('GET', `/pages/${lead.id}`) : page;
    did = await negotiate({ email, x, leadPage, creator, usage, cost }).catch((e) => 'negotiation error: ' + String(e.message).slice(0, 120));
  }
  await lg(`Lead ${lead ? 'updated' : 'added'}: ${x.brand || email.subject} × ${creator}`, 'Rule', `${status} · ${x.offer || ''} · next: ${x.next_step || '?'}${did ? ' · ' + did : ''}`, { usage, cost, side: 'brand' });
  return withLabel({ action: lead ? 'updated' : 'filed', lead: page.url, status, did });
}

// For the dashboard: open leads grouped by status (watch-only view)
export async function leadsBoard({ days = 60 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const r = await notion('POST', `/data_sources/${DS.leads}/query`, { page_size: 100, filter: { or: [{ property: 'Last Brand Email', date: { on_or_after: since } }, { property: 'Last Our Email', date: { on_or_after: since } }] }, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] });
  const today = todayIST();
  const ago = (d) => (d ? Math.max(0, Math.round((Date.parse(today) - Date.parse(String(d).slice(0, 10))) / 864e5)) : null);
  const items = (r.results || []).map((p) => {
    const g = (n) => plain(p.properties?.[n]);
    const lastBrand = g('Last Brand Email'), lastOur = g('Last Our Email');
    const weOwe = lastBrand && (!lastOur || Date.parse(lastBrand) > Date.parse(lastOur));
    return { id: p.id, url: p.url, brand: g('Brand') || 'Brand', creator: g('Creator') || '?', status: g('Status') || 'New offer', type: g('Type'), offer: g('Offer') || '', budget: g('Budget USD'), next: g('Next Step') || '', weOwe, days: weOwe ? ago(lastBrand) : ago(lastOur), approval: g('Approval USD'), ask: g('Ask USD') || g('Quoted USD'), what: g('Quoted For') || g('Deliverables') || '' };
  });
  // Waiting on a brand for 30+ days: gone cold, counted but kept off the board
  const cold = items.filter((i) => i.status === 'Waiting on brand' && (i.days ?? 0) >= 30);
  for (const c of cold) c.status = 'Gone cold';
  const cols = [
    { key: 'new', title: 'New offers', match: (s) => s === 'New offer' },
    { key: 'neg', title: 'Negotiating', match: (s) => s === 'Negotiating' },
    { key: 'wait', title: 'Waiting on brand', match: (s) => s === 'Waiting on brand' },
    { key: 'locked', title: 'Locked, handed over', match: (s) => s === 'Locked' },
  ];
  return {
    // Longest-waiting first, so the follow-ups that are most overdue sit on top
    columns: cols.map((c) => ({ key: c.key, title: c.title, items: items.filter((i) => c.match(i.status)).sort((a, b) => (b.days ?? 0) - (a.days ?? 0)) })),
    // Offers below our floor that wait for Harsh's yes or no
    approvals: items.filter((i) => i.status === 'Needs approval'),
    affiliate: items.filter((i) => i.status === 'Affiliate only').length,
    cold: cold.length,
    total: items.length,
  };
}
