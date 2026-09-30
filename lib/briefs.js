// Brief catcher: a brand emails a brief to noocapcollab -> the PM files it in Notion and pings Shreya.
// Called by n8n (Gmail trigger) through /api/brief-intake. Nothing here ever emails the brand.
import { notion, plain, titleOf, queryAll, clearCache } from './notion.js';
import { BOARDS, DS, todayIST } from './tools.js';
import { schemaOf, findProp, buildValue, briefBlocks, CREATOR_KEY } from './actions.js';
import { claude, HAIKU, costOf } from './claude.js';
import { threadSubject } from './mime.js';

const lc = (s) => String(s ?? '').toLowerCase().trim();
const CLOSED = ['Paid', 'Lost'];
const BEFORE_BRIEF = ['Inbound', 'Negotiating', 'Price Agreed', 'Signed'];
const ROSTER = BOARDS.map((b) => b.creator);
const SCRIPT_STATUS = 4; // "4- Script Draft"

// ---------- step 0: cheap filter, no AI ----------
const BRIEF_WORDS = /\b(brief|guideline|talking points?|key messag|creative direction|campaign|deliverable|script|requirements?|do'?s and don'?ts|dos and donts|mandator|messaging|go[- ]live|posting date|content plan)\b/i;
export const LINK_RE = /https?:\/\/[^\s<>"')\]]+/g;
export const DOC_LINK = /(docs\.google\.com|drive\.google\.com|notion\.so|notion\.site|dropbox\.com|frame\.io|box\.com|canva\.com|figma\.com|onedrive|sharepoint|dropbox)/i;

export function looksLikeBrief(email) {
  const from = lc(email.from);
  if (from.includes('noocapcollab')) return { ok: false, why: 'sent by us' };
  const text = `${email.subject || ''}\n${email.text || ''}`;
  const hasWords = BRIEF_WORDS.test(text);
  const hasDocLink = (text.match(LINK_RE) || []).some((u) => DOC_LINK.test(u));
  const hasFile = (email.attachments || []).some((a) => /pdf|word|document|presentation|slides|text/i.test(a.mimeType || '') || /\.(pdf|docx?|pptx?|key|txt)$/i.test(a.filename || ''));
  if (hasWords && (hasDocLink || hasFile || text.length > 400)) return { ok: true };
  if (/\bbrief\b/i.test(text) || /brief/i.test((email.attachments || []).map((a) => a.filename).join(' '))) return { ok: true };
  return { ok: false, why: 'no brief signals' };
}

// ---------- helpers ----------
// Everyone else on the brand's email (the creator, their manager, other brand people), so our replies keep them in the loop.
// Leaves out noocapcollab and the person we reply to. Merges with what the deal already has.
const ADDR_RE = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
export function threadCcFrom(email, existing = '') {
  const sender = ((String(email.from || '').match(ADDR_RE) || [])[0] || '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const a of [...(String(existing || '').match(ADDR_RE) || []), ...(`${email.to || ''} ${email.cc || ''}`.match(ADDR_RE) || [])]) {
    const k = a.toLowerCase();
    if (seen.has(k) || k === sender || /noocapcollab@/i.test(k)) continue;
    seen.add(k); out.push(a);
  }
  return out.slice(0, 6).join(', ');
}

export async function alreadyHandled(messageId) {
  if (!messageId) return false;
  const res = await notion('POST', `/data_sources/${DS.agentLog}/query`, {
    page_size: 10,
    filter: { and: [{ property: 'Message ID', rich_text: { equals: String(messageId).slice(0, 1900) } }, { property: 'Area', select: { equals: 'Brand deals' } }] },
  });
  // Emails the PM couldn't place or skipped can be re-run (remove the PM-seen label in Gmail); real actions can't repeat
  return (res.results || []).some((p) => !/^(Unmatched|Skipped|Our side)/i.test(plain(p.properties?.Event) || ''));
}

export async function openDeals() {
  const pages = await queryAll(DS.deals, undefined, { useCache: false });
  return pages.map((p) => {
    const get = (n) => plain(p.properties?.[n]);
    return {
      id: p.id, url: p.url,
      brand: get('Brand Name') || 'Untitled', creator: get('Creator'), stage: get('Deal Stage'),
      brandEmail: get('Brand Email'), deadline: get('Deadline'), deliverables: get('Deliverables'),
      linkedVideo: get('Linked Video'), threadId: get('Thread ID'), messageRfc: get('Message ID'), threadSubject: get('Thread Subject'), threadCc: get('Thread CC') || '', agentNotes: get('Agent Notes') || '',
      finalRate: get('Final Rate USD'), invoiceAmount: get('Invoice Amount'), paused: get('Paused') === true, needsCheck: get('Needs Check') === true,
      followUps: Number(get('Follow-ups Sent') || 0), lastBrand: get('Last Brand Reply'), lastOur: get('Last Our Reply'),
      confirmed: get('Confirmed Date'), teamCc: get('Team CC Date'), scriptSent: get('Script Sent Date'), scriptApproved: get('Script Approved Date'),
      linksSent: get('Links Sent Date'), postedLinks: get('Posted Links'), invoiceSent: get('Invoice Sent Date'), invoiceDue: get('Invoice Due Date'), paidDate: get('Paid Date'),
      hasInvoiceFile: !!get('Invoice File'), notes: get('Notes') || '',
      nextAction: get('Next Action') || '', nextActionDate: get('Next Action Date'), lastReminder: get('Last Reminder Sent'),
    };
  }).filter((d) => !CLOSED.includes(d.stage));
}

// Public Google Docs can be read directly; anything private is just linked.
export async function readDocLink(url) {
  const m = String(url).match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  if (!m) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://docs.google.com/document/d/${m[1]}/export?format=txt`, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!/text\/plain/.test(type)) return null; // a sign-in page means the doc is private
    const text = (await res.text()).trim();
    return text ? text.slice(0, 20000) : null;
  } catch {
    return null;
  }
}

// ---------- step 1: AI reads the email ----------
const EXTRACT_TOOL = {
  name: 'record_brief',
  description: 'Record what this email is and the brief details.',
  input_schema: {
    type: 'object',
    properties: {
      is_brief: { type: 'boolean', description: 'True if this email delivers (or updates) a content brief / guidelines for a sponsored video. Creative direction counts even without a formal brief document: example or reference videos, inspiration links, angles or use cases to cover, or a request to send concepts / scripts before filming.' },
      is_update: { type: 'boolean', description: 'True if it revises a brief that was already sent' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string', description: 'One short sentence' },
      brand: { type: 'string', description: 'Brand / company name as it would appear on the deal' },
      creator: { type: ['string', 'null'], enum: [...ROSTER, null], description: 'Which NOOCAP creator this is for' },
      deal_number: { type: ['integer', 'null'], description: 'Number of the matching open deal from the list, or null if none matches' },
      brief_links: { type: 'array', items: { type: 'string' }, description: 'Links to the brief or its assets, most important first' },
      brief_text: { type: 'string', description: 'The brief itself, cleaned up, if it is written in the email, the attachment or the readable doc. Keep all concrete requirements. Use short lines, "- " bullets and "## " headings. Leave out anything about the rate, budget, fee or payment. Empty if only a link was given.' },
      summary: { type: 'array', items: { type: 'string' }, description: 'The key points a scriptwriter must know for the content, max 6. Never mention the rate, price, budget, fee or payment: the scriptwriter must not see what the deal is worth.' },
      deliverables: { type: 'string' },
      go_live_date: { type: ['string', 'null'], description: 'YYYY-MM-DD if a posting / go-live date is given' },
      draft_due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD if a script or draft deadline is given' },
      must_mention: { type: 'array', items: { type: 'string' }, description: 'Links, codes, phrases or claims that must be said or shown' },
    },
    required: ['is_brief', 'confidence', 'reason', 'brand', 'creator', 'deal_number', 'brief_links', 'brief_text', 'summary'],
  },
};

async function extract(email, deals, docText) {
  const dealList = deals.map((d, i) => `${i + 1}. ${d.brand} | creator: ${d.creator || '?'} | stage: ${d.stage || '?'}${d.brandEmail ? ' | brand email: ' + d.brandEmail : ''}`).join('\n') || '(no open deals)';
  const content = [];
  for (const a of (email.attachments || []).slice(0, 2)) {
    if (a.data && /pdf/i.test(a.mimeType || a.filename || '')) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    }
  }
  content.push({
    type: 'text',
    text: `NOOCAP creators: ${ROSTER.join(', ')}. (Valeri may be spelled Valerie, David Iya may be just David.)

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

Decide if this email delivers a sponsored-video brief, and record the details. Match the deal by brand name, sender domain and creator. If nothing matches clearly, deal_number is null.`,
  });
  const out = await claude({
    model: HAIKU,
    max_tokens: 3000,
    system: 'You file incoming brand emails for NOOCAP Media, an agency that makes sponsored videos for creators. Be precise and never invent details that are not in the email or attachments.',
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_brief' },
    messages: [{ role: 'user', content }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  return { data: call?.input || { is_brief: false, confidence: 'low', reason: 'no answer' }, usage: out.usage };
}

// ---------- Notion file upload for attachments ----------
export async function uploadToNotion(att) {
  if (!att?.data) return null;
  try {
    const created = await notion('POST', '/file_uploads', { mode: 'single_part', filename: att.filename || 'brief.pdf', content_type: att.mimeType || 'application/pdf' });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(att.data, 'base64')], { type: att.mimeType || 'application/pdf' }), att.filename || 'brief.pdf');
    const res = await fetch(created.upload_url || `https://api.notion.com/v1/file_uploads/${created.id}/send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.NOTION_TOKEN, 'Notion-Version': '2025-09-03' },
      body: form,
    });
    if (!res.ok) return null;
    return created.id;
  } catch {
    return null;
  }
}

// ---------- step 2: build the Notion page ----------
export function pageBody({ x, email, links, uploads, docText, heading }) {
  const lines = [];
  if (x.summary?.length) {
    lines.push('## Key points');
    for (const s of x.summary) lines.push('- ' + s);
  }
  if (x.must_mention?.length) {
    lines.push('## Must mention');
    for (const s of x.must_mention) lines.push('- ' + s);
  }
  if (x.deliverables) { lines.push('## Deliverables'); lines.push(x.deliverables); }
  const dates = [x.draft_due_date ? `Script / draft due: ${x.draft_due_date}` : '', x.go_live_date ? `Go live: ${x.go_live_date}` : ''].filter(Boolean);
  if (dates.length) { lines.push('## Dates'); for (const d of dates) lines.push('- ' + d); }
  if (links.length) { lines.push('## Brief links'); for (const l of links) lines.push('- ' + l); }
  const full = x.brief_text || docText || '';
  if (full) { lines.push('## Full brief'); lines.push(full); }
  lines.push('## Source email');
  lines.push(`- From: ${email.from || ''}`);
  lines.push(`- Subject: ${email.subject || ''}`);
  lines.push(`- Received: ${email.date || ''}`);
  const inner = briefBlocks(noMoney(lines.join('\n'))).slice(1); // drop the default "Brief" heading
  for (const id of uploads) inner.push({ object: 'block', type: 'file', file: { type: 'file_upload', file_upload: { id } } });
  // Everything sits inside one collapsible "📋" block so the script (written below it) stays separate
  const label = heading || `📋 Brief from ${x.brand || 'the brand'} (auto-added, script goes below)`;
  return [
    { object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: label } }], children: inner.slice(0, 98) } },
    ...(heading ? [] : [{ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Script' } }] } }]),
  ];
}

export async function uniqueTitle(ds, base) {
  const schema = await schemaOf(ds);
  const titleName = Object.entries(schema).find(([, p]) => p.type === 'title')?.[0];
  const res = await notion('POST', `/data_sources/${ds}/query`, { page_size: 50, filter: { property: titleName, title: { starts_with: base } } });
  const n = (res.results || []).filter((p) => !p.in_trash).length;
  return { title: n ? `${base} #${n + 1}` : base, titleName, schema };
}

export function setIf(schema, props, field, value) {
  if (value === null || value === undefined || value === '') return;
  // Exact field names are allowed even for ID fields (the chat's safety block does not apply to the system itself)
  const found = schema[field] ? [field, schema[field]] : findProp(schema, field);
  if (!found) return;
  try { props[found[0]] = buildValue(found[1], value); } catch { /* option missing on this board: skip */ }
}

// The script writer never sees what the deal is worth: drop any line about the rate, budget, fee or payment
// Only lines about what the DEAL is worth go. Product prices in the brief ("$500 for 10 architect hours",
// "plans from $25 a month") stay, because the script has to say them.
const DEAL_WORDS = /\b(?:compensation|remuneration|payout|paypal|wire transfer|net ?(?:15|30|45|60))\b|\b(?:our|your|his|her|their|the|agreed|final|flat|creator|base|usual|collab|collaboration|sponsorship) (?:rates?|fees?)\b|\brate (?:card|works|of|is|stands|agreed)\b|\b(?:our|your|their|marketing|campaign) budget\b|\bbudget (?:is|of|for (?:this|the (?:collab|campaign|deal))|works|range)\b|\bpayment (?:terms|on|upon|within|details|method|schedule|after)\b|\b(?:send|sent|our|your) invoice\b|\binvoice (?:us|to|will|on|upon)\b/i;
const AMOUNT = /(?:[$€£₹]\s?\d|\b\d[\d,.]*\s?k?\s?(?:usd|dollars?|eur|euros?|gbp|inr|rupees?)\b)/i;
const DEAL_CONTEXT = /\b(?:works for|within our|agreed|offer(?:ed|ing)?|deal|confirm(?:s|ed)?|collab(?:oration)?|sponsorship|we charge|charges?|quoted?|counter(?:ed)?|clos(?:e|ed|ing)|pay(?:ing)? (?:you|chris|us|him|her|the creator)|chris|creator|rate)\b/i;
function isDealMoney(line) {
  const l = String(line);
  return DEAL_WORDS.test(l) || (AMOUNT.test(l) && DEAL_CONTEXT.test(l));
}
export function noMoney(text) {
  return String(text || '').split('\n').filter((l) => !isDealMoney(l)).join('\n');
}
export const noMoneyList = (arr) => (arr || []).filter((l) => l && !isDealMoney(l));

// ---------- step 3: tell Shreya ----------
// Channels: 'pm' = #pm-alerts, ONLY things a person has to act on. 'scripts' = Shreya's channel.
// 'log' = FYI updates: not posted anywhere (they're in the AGENT LOG and the HQ activity feed) unless
// DISCORD_LOG_WEBHOOK is set. Link previews are switched off (flags: 4) so messages stay compact.
export async function discord(content, channel = 'scripts') {
  const pm = process.env.DISCORD_PM_WEBHOOK || process.env.DISCORD_SCRIPTS_WEBHOOK;
  if (channel === 'log' && !process.env.DISCORD_LOG_WEBHOOK) return true;
  const hook = channel === 'pm' ? pm : channel === 'log' ? process.env.DISCORD_LOG_WEBHOOK : process.env.DISCORD_SCRIPTS_WEBHOOK;
  if (!hook) return false;
  const shreya = process.env.SHREYA_DISCORD_ID;
  if (channel === 'scripts') content = noMoney(content);
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1990), flags: 4, allowed_mentions: { users: shreya ? [shreya] : [] } }),
  });
  return res.ok;
}

// One compact message: bold headline, at most two short bullets, one link.
export function card(headline, lines = [], link, linkText = 'Open deal') {
  const bullets = (lines || []).filter(Boolean).slice(0, 2).map((l) => '• ' + String(l).replace(/\s+/g, ' ').slice(0, 160));
  return [`**${headline}**`, ...bullets, link ? `→ [${linkText}](${link})` : ''].filter(Boolean).join('\n');
}
export const tag = () => (process.env.SHREYA_DISCORD_ID ? `<@${process.env.SHREYA_DISCORD_ID}>` : 'Shreya');

export async function log({ event, outcome, email, x, deal, details, usage, cost, creator, side, area, source }) {
  const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
  const props = {
    Event: { title: rt(event.slice(0, 120)) },
    Time: { date: { start: new Date().toISOString() } },
    Area: { select: { name: area || 'Brand deals' } },
    Outcome: { select: { name: outcome } },
    Source: { select: { name: source || 'noocapcollab' } },
    Rule: { rich_text: rt('Brief catcher' + (x?.reason ? ': ' + x.reason : '')) },
    Details: { rich_text: rt(details) },
    'Message ID': { rich_text: rt(email.messageId || '') },
    Model: { select: { name: usage ? 'Haiku' : 'None' } },
    'Approved By': { select: { name: 'Auto' } },
  };
  if (usage) {
    props['Tokens In'] = { number: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) };
    props['Tokens Out'] = { number: usage.output_tokens || 0 };
    props['Cost USD'] = { number: cost || 0 };
  }
  if (creator) props.Creator = { select: { name: creator } };
  if (deal?.id) props.Deal = { relation: [{ id: deal.id }] };
  // Thread memory: every email the PM sees is kept with its thread and date, so it can tell which message is the latest
  if (email?.threadId) props['Thread ID'] = { rich_text: rt(email.threadId) };
  const when = Date.parse(email?.date || '');
  if (Number.isFinite(when)) props['Email Date'] = { date: { start: new Date(when).toISOString() } };
  const fromSide = side || (x?.from_role === 'brand' ? 'brand' : ['creator', 'noocap'].includes(x?.from_role) ? 'ours' : /noocapcollab/i.test(email?.from || '') ? 'ours' : null);
  if (fromSide) props['From Side'] = { select: { name: fromSide } };
  try {
    await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.agentLog }, properties: props });
  } catch (e) {
    console.error('AGENT LOG write failed', e.message);
  }
}

// ---------- main ----------
export async function handleBriefEmail(email) {
  const gate = looksLikeBrief(email);
  if (!gate.ok) return { action: 'skipped', why: gate.why };
  if (await alreadyHandled(email.messageId)) return { action: 'skipped', why: 'already handled' };

  const deals = await openDeals();
  const allLinks = [...new Set(((email.text || '') + ' ' + (email.html || '')).match(LINK_RE) || [])].filter((u) => DOC_LINK.test(u));
  let docText = null;
  for (const u of allLinks.slice(0, 2)) { docText = await readDocLink(u); if (docText) break; }

  const { data: x, usage } = await extract(email, deals, docText);
  const cost = costOf(usage);

  if (!x.is_brief || x.confidence === 'low') {
    await log({ event: `Not a brief: ${email.subject || ''}`, outcome: 'Skipped', email, x, details: x.reason, usage, cost });
    return { action: 'skipped', why: 'AI: not a brief', reason: x.reason };
  }

  return fileBrief({ email, x, deals, allLinks, docText, usage, cost });
}

// "Send to script writer" button: Harsh decides a brand message is a brief even if the PM didn't file it as one.
// text = the brand's message ("From: ...\nDate: ...\n\nbody", as stored on a draft's Context).
export async function briefFromText({ text, subject, dealId, threadId, creator }) {
  const m = String(text || '').match(/^From:\s*(.*)\nDate:\s*(.*)\n\n([\s\S]*)$/);
  const email = {
    from: m ? m[1] : '', subject: subject || '', text: m ? m[3] : String(text || ''), html: '',
    date: new Date().toISOString(), // filed now, so the "old email" guard never skips it
    messageId: `manual-brief-${Date.now()}`, threadId: threadId || '', attachments: [],
  };
  if (!email.text.trim()) throw new Error('There is no brand message on this email to file as a brief.');
  const deals = await openDeals();
  const deal = dealId ? deals.find((d) => d.id === dealId) || null : null;
  const allLinks = [...new Set(email.text.match(LINK_RE) || [])].filter((u) => DOC_LINK.test(u));
  let docText = null;
  for (const u of allLinks.slice(0, 2)) { docText = await readDocLink(u); if (docText) break; }
  const { data: x, usage } = await extract(email, deals, docText);
  x.is_brief = true; x.confidence = 'high';
  if (!deal && creator && !x.creator) x.creator = creator;
  return fileBrief({ email, x, deals, deal, allLinks, docText, usage, cost: costOf(usage) });
}

// Files a brief once the email has been read. Also used by the inbox brain.
// Boards are planned month by month: the team pre-makes empty rows tagged with the month (MONTH = "SEPTEMBER").
// A new brand deal fills the first empty row of this month so it sits right under the last planned video.
// If there's no empty row left, a new card is created with the month set so it still shows in the month's view.
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
export const monthLabel = (d = todayIST()) => MONTHS[Number(String(d).slice(5, 7)) - 1];

// Boards name their month tabs differently (SEPTEMBER, SEPT-OCT, AUGUST-SEPT...). Use the board's own option:
// one that starts with this month first, then any that contains it, else the plain month name.
export function monthOption(options, full) {
  const ab = full.slice(0, 3);
  const toks = (n) => String(n).toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const names = options.map((o) => o.name);
  const starts = names.filter((n) => toks(n)[0]?.startsWith(ab));
  const has = names.filter((n) => toks(n).some((t) => t.startsWith(ab)));
  return starts[starts.length - 1] || has[has.length - 1] || full;
}

export async function placeCard({ ds, schema, titleName, props, body }) {
  const monthEntry = Object.entries(schema).find(([n, v]) => lc(n) === 'month' && v.type === 'select');
  if (monthEntry) {
    const label = monthOption(monthEntry[1].select?.options || [], monthLabel());
    props[monthEntry[0]] = { select: { name: label } };
    try {
      const res = await notion('POST', `/data_sources/${ds}/query`, {
        page_size: 1,
        filter: { and: [{ property: monthEntry[0], select: { equals: label } }, { property: titleName, title: { is_empty: true } }] },
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      });
      const blank = (res.results || [])[0];
      if (blank) {
        const page = await notion('PATCH', `/pages/${blank.id}`, { properties: props });
        if (body?.length) await notion('PATCH', `/blocks/${blank.id}/children`, { children: body });
        return page;
      }
    } catch { /* fall back to a new card */ }
  }
  return notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: ds }, properties: props, ...(body?.length ? { children: body } : {}) });
}

export async function fileBrief({ email, x, deals, deal: givenDeal, allLinks = [], docText = null, usage, cost }) {
  let deal = givenDeal || (x.deal_number ? deals[x.deal_number - 1] : null);
  const creator = deal?.creator || x.creator || null;
  const board = creator ? BOARDS.find((b) => CREATOR_KEY(b.creator) === CREATOR_KEY(creator)) : null;

  if (!board) {
    const msg = `📨 A brief arrived but I couldn't tell which creator it's for.\n**${email.subject || '(no subject)'}** from ${email.from || '?'}\nBrand: ${x.brand || '?'}. Please file it by hand or tell the PM in chat.`;
    await discord(msg, 'pm');
    await log({ event: `Brief needs a creator: ${x.brand || email.subject}`, outcome: 'Needs approval', email, x, details: msg, usage, cost });
    return { action: 'needs_help', why: 'no creator' };
  }

  const links = [...new Set([...(x.brief_links || []), ...allLinks])].slice(0, 8);

  // An old email (catch-up) never creates cards or pings Shreya: the team has almost certainly handled it already
  const ageH = email.date ? (Date.now() - Date.parse(email.date)) / 36e5 : 0;
  if (ageH > 36) {
    await log({ event: `Old brief recorded: ${x.brand || deal?.brand || email.subject}`, outcome: 'Skipped', email, x, deal, details: `Email is ${Math.round(ageH)}h old, no card created`, usage, cost, creator: board.creator });
    return { action: 'skipped', why: 'old brief, recorded only' };
  }

  // The team often makes the card themselves ("TRIPO 3D - HOLD FOR NOW"): reuse a live card named after the brand
  if (deal && !deal.linkedVideo) {
    const nb = String(x.brand || deal.brand || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
    if (nb.length >= 3) {
      const pages = await queryAll(board.ds).catch(() => []);
      const live = pages.filter((p) => !p.in_trash && !p.archived).map((p) => ({ p, t: titleOf(p) || '', st: parseInt(plain(p.properties?.Status || p.properties?.status) || '0', 10) }))
        .filter(({ t, st }) => t.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(nb) && st < 12);
      if (live.length) {
        const url = live.sort((a, b) => Date.parse(b.p.created_time) - Date.parse(a.p.created_time))[0].p.url;
        const ds = await schemaOf(DS.deals); const pp = {}; setIf(ds, pp, 'Linked Video', url);
        if (Object.keys(pp).length) await notion('PATCH', `/pages/${deal.id}`, { properties: pp }).catch(() => {});
        deal = { ...deal, linkedVideo: url };
      }
    }
  }

  // Updated brief for a deal that already has a video: add to that page instead of making a new one.
  const videoMatch = deal?.linkedVideo && String(deal.linkedVideo).match(/([0-9a-f]{32})(?:\?|$)/i);
  if (deal && videoMatch && (x.is_update || deal.linkedVideo)) {
    const pageId = videoMatch[1];
    const uploads = [];
    for (const a of (email.attachments || []).slice(0, 2)) { const id = await uploadToNotion(a); if (id) uploads.push(id); }
    const blocks = pageBody({ x, email, links, uploads, docText, heading: `📋 Brief update ${todayIST()} from ${x.brand || deal.brand}` });
    await notion('PATCH', `/blocks/${pageId}/children`, { children: blocks });
    await discord(`${tag()} ✏️ **Brief updated: ${deal.brand} × ${deal.creator}**\n${(x.summary || []).slice(0, 3).map((s) => '• ' + s).join('\n')}\nNotion: ${deal.linkedVideo}`);
    await log({ event: `Brief updated: ${deal.brand} × ${deal.creator}`, outcome: 'Rule', email, x, deal, details: `Added to ${deal.linkedVideo}`, usage, cost, creator: deal.creator });
    return { action: 'updated', video: deal.linkedVideo, deal: deal.url };
  }

  // No matching deal: create one so nothing is lost, flagged for Harsh to check.
  let createdDeal = false;
  if (!deal) {
    const dealSchema = await schemaOf(DS.deals);
    const props = { 'Brand Name': { title: [{ type: 'text', text: { content: (x.brand || 'Unknown brand').slice(0, 200) } }] } };
    setIf(dealSchema, props, 'Creator', board.creator);
    setIf(dealSchema, props, 'Deal Stage', 'Brief Received');
    setIf(dealSchema, props, 'Deal Source', 'Auto-captured');
    setIf(dealSchema, props, 'Needs Check', true);
    setIf(dealSchema, props, 'Deliverables', x.deliverables);
    setIf(dealSchema, props, 'Deadline', x.go_live_date);
    const fromEmail = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
    setIf(dealSchema, props, 'Brand Email', fromEmail);
    setIf(dealSchema, props, 'Thread ID', email.threadId);
    setIf(dealSchema, props, 'Message ID', email.messageId);
    setIf(dealSchema, props, 'Thread Subject', threadSubject(email.subject));
    setIf(dealSchema, props, 'Thread CC', threadCcFrom(email));
    const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.deals }, properties: props });
    deal = { id: page.id, url: page.url, brand: x.brand || 'Unknown brand', creator: board.creator, stage: 'Brief Received', agentNotes: '' };
    createdDeal = true;
  }

  // Create the video card
  const { title, titleName, schema } = await uniqueTitle(board.ds, `${deal.brand} × ${board.creator}`);
  const props = { [titleName]: { title: [{ type: 'text', text: { content: title } }] } };
  const statusProp = findProp(schema, 'status');
  if (statusProp) {
    const opts = statusProp[1].select?.options || statusProp[1].status?.options || [];
    const opt = opts.find((o) => parseInt(o.name, 10) === SCRIPT_STATUS);
    if (opt) props[statusProp[0]] = statusProp[1].type === 'status' ? { status: { name: opt.name } } : { select: { name: opt.name } };
  }
  setIf(schema, props, 'type', 'SPONSOR');
  setIf(schema, props, 'post date', x.go_live_date || deal.deadline);
  const briefProp = Object.entries(schema).find(([n]) => lc(n) === 'brief');
  if (briefProp && links[0]) {
    if (briefProp[1].type === 'url') props[briefProp[0]] = { url: links[0] };
    else if (briefProp[1].type === 'rich_text') props[briefProp[0]] = { rich_text: [{ type: 'text', text: { content: links[0] } }] };
  }
  const uploads = [];
  for (const a of (email.attachments || []).slice(0, 2)) { const id = await uploadToNotion(a); if (id) uploads.push(id); }
  const body = pageBody({ x, email, links, uploads, docText });
  const video = await placeCard({ ds: board.ds, schema, titleName, props, body });

  // Update the deal
  const dealSchema = await schemaOf(DS.deals);
  const dprops = {};
  if (!createdDeal && (BEFORE_BRIEF.includes(deal.stage) || !deal.stage)) setIf(dealSchema, dprops, 'Deal Stage', 'Brief Received');
  setIf(dealSchema, dprops, 'Linked Video', video.url);
  setIf(dealSchema, dprops, 'Last Brand Reply', todayIST());
  setIf(dealSchema, dprops, 'Next Action', 'Shreya writing the script');
  setIf(dealSchema, dprops, 'Thread ID', email.threadId);
  setIf(dealSchema, dprops, 'Message ID', email.messageId);
  setIf(dealSchema, dprops, 'Thread Subject', threadSubject(email.subject));
  setIf(dealSchema, dprops, 'Thread CC', threadCcFrom(email, deal.threadCc));
  setIf(dealSchema, dprops, 'Agent Notes', ((deal.agentNotes ? deal.agentNotes + '\n' : '') + `[${todayIST()}] Brief received, video card created, Shreya notified.`).slice(-1900));
  if (!deal.deliverables && x.deliverables) setIf(dealSchema, dprops, 'Deliverables', x.deliverables);
  if (Object.keys(dprops).length) await notion('PATCH', `/pages/${deal.id}`, { properties: dprops });
  clearCache();

  // Tell Shreya
  const due = x.draft_due_date ? `\nScript due: ${x.draft_due_date}` : '';
  const live = x.go_live_date ? `\nGo live: ${x.go_live_date}` : '';
  const points = (x.summary || []).slice(0, 4).map((s) => '• ' + s).join('\n');
  const pinged = await discord(`${tag()} 📝 **New brand deal: ${deal.brand} × ${board.creator}**\nThe brief is in Notion, please start the script.${due}${live}\n${points}\nBrief: ${links[0] || 'inside the Notion page'}\nNotion: ${video.url}${createdDeal ? '\n⚠️ No matching deal was found, so a new deal was added and flagged Needs Check for Harsh.' : ''}`);

  await log({
    event: `Brief filed: ${deal.brand} × ${board.creator}`,
    outcome: createdDeal ? 'Needs approval' : 'Rule',
    email, x, deal, usage, cost, creator: board.creator,
    details: `Video: ${video.url}\nDeal: ${deal.url}${createdDeal ? ' (new, Needs Check)' : ''}\nShreya pinged: ${pinged ? 'yes' : 'no (DISCORD_SCRIPTS_WEBHOOK missing)'}`,
  });
  return { action: 'filed', video: video.url, title, deal: deal.url, createdDeal, pinged, cost };
}
