// Brief catcher: a brand emails a brief to noocapcollab -> the PM files it in Notion and pings Rudraksh.
// Called by n8n (Gmail trigger) through /api/brief-intake. Nothing here ever emails the brand.
import { notion, plain, titleOf, queryAll, clearCache } from './notion.js';
import { BOARDS, DS, todayIST, sponsorPostDate, istStamp } from './tools.js';
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
export const DOC_LINK = /(feishu\.cn|feishu\.com|larksuite\.com|larkoffice\.com|docs\.google\.com|drive\.google\.com|notion\.so|notion\.site|dropbox\.com|frame\.io|box\.com|canva\.com|figma\.com|onedrive|sharepoint|dropbox)/i;

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

// Reply times come back from Notion in UTC: turn them into India time, so the first 10 characters are the India date
// everywhere (a 4 AM IST reply must not read as the day before) and two times still compare within a day
// Follow-ups we sent by hand (or before the counter existed) live only in the Deal Memory history. The counter said 3
// for Joylo x Chris while the history showed 8 follow-ups since the Oct 1 script, so the PM drafted a 9th with
// "follow-up 4 of 5" (system check, Nov 7). Count history lines from our side that mention a follow-up, dated after the
// brand's last reply, and never chase on a lower number than that.
export function memoryFollowUps(memory, lastBrand) {
  const hist = String(memory || '').replace(/<br\s*\/?>/gi, '\n').split(/BILLING:|OPEN NOW:/i)[0];
  const since = lastBrand ? String(lastBrand).slice(0, 10) : '';
  const re = /(\d{4}-\d{2}-\d{2})\s*:?\s*(?:us|our side|we)\b[^\n.]*?\bfollow(?:ed)?[- ]?up/gi;
  let n = 0; let m;
  while ((m = re.exec(hist))) { if (!since || m[1] > since) n += 1; }
  return n;
}
const ist = (v) => (v && String(v).length > 10 && Number.isFinite(Date.parse(v)) ? istStamp(Date.parse(v)) : v);
export async function openDeals({ withClosed = false } = {}) {
  const pages = await queryAll(DS.deals, undefined, { useCache: false });
  return pages.map((p) => {
    const get = (n) => plain(p.properties?.[n]);
    return {
      id: p.id, url: p.url, created: p.created_time,
      brand: get('Brand Name') || 'Untitled', creator: get('Creator'), stage: get('Deal Stage'),
      brandEmail: get('Brand Email'), deadline: get('Deadline'), deliverables: get('Deliverables'), // A deal filed by hand with no email thread at all came from WhatsApp (Brad, Chris and Emtech forward their
      // deals): it's run on WhatsApp until an email thread shows up, so the PM never asks the brand for anything by email
      channel: get('Channel') || (!get('Thread ID') && !get('Message ID') && get('Deal Source') === 'Manually added' ? 'WhatsApp' : 'Email'), channelGuessed: !get('Channel'),
      paymentDetails: get('Payment Details') || '', linkedVideo: get('Linked Video'), threadId: get('Thread ID'), messageRfc: get('Message ID'), threadSubject: get('Thread Subject'), threadCc: get('Thread CC') || '', agentNotes: get('Agent Notes') || '',
      finalRate: get('Final Rate USD'), invoiceAmount: get('Invoice Amount'), paused: get('Paused') === true, needsCheck: get('Needs Check') === true,
      followUps: Math.max(Number(get('Follow-ups Sent') || 0), memoryFollowUps(get('Deal Memory'), get('Last Brand Reply'))), lastBrand: ist(get('Last Brand Reply')), lastOur: ist(get('Last Our Reply')),
      confirmed: get('Confirmed Date'), teamCc: get('Team CC Date'), scriptSent: get('Script Sent Date'), scriptApproved: get('Script Approved Date'),
      linksSent: get('Links Sent Date'), delivered: get('Delivered Date'), postedLinks: get('Posted Links'), invoiceSent: get('Invoice Sent Date'), invoiceDue: get('Invoice Due Date'), paidDate: get('Paid Date'),
      hasInvoiceFile: !!get('Invoice File'), invoiceNumber: get('Invoice Number') || '', notes: get('Notes') || '',
      nextAction: get('Next Action') || '', nextActionDate: get('Next Action Date'), lastReminder: get('Last Reminder Sent'),
      billing: get('Billing Details') || '', paymentTerms: get('Payment Terms') || '', stripeInvoices: get('Stripe Invoices') || '', billingRequested: get('Billing Request Sent'), billingReminders: Number(get('Billing Reminders Sent') || 0),
      memory: get('Deal Memory') || '', invoiceRequested: get('Invoice Requested') === true,
      postingHold: get('Posting Hold') || '', postingHoldSince: get('Posting Hold Since'),
    };
  }).filter((d) => withClosed || !CLOSED.includes(d.stage));
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

// A brief belongs on a NEW card when the brand says it's another video, or the linked card is already past editing
// (approval, to post, ready, posted, archived) so it can't be the video this brief is about
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1, double: 2, pair: 2 };
// How many separate reels a deal covers: the AI's count first, else "2 reels" / "two videos" / "3 UGC" in the deliverables
// "3 promotional videos for CapCut APP" counted as 1 because "promotional" wasn't an allowed word, so the $3,000
// three-video deal got one card (CapCut x Lindsay, Nov 12): any one word right before reels/videos is allowed now.
export function videoCount(x = {}, deal = {}) {
  const n = Number(x.video_count);
  if (Number.isInteger(n) && n > 0) return Math.min(n, 6);
  const text = `${x.deliverables || ''} ${deal.deliverables || ''}`.toLowerCase();
  const m = text.match(/\b(\d+|one|two|three|four|five|six|a|an|single|double|pair)\s*(?:x\s*)?(?:of\s+)?(?:sponsored\s+|dedicated\s+|short[- ]form\s+|instagram\s+|ig\s+|tiktok\s+|ugc\s+|promotional\s+|promo\s+|branded\s+|vertical\s+|separate\s+|unique\s+|[a-z]+\s+(?=(?:reels?|videos?)\b))*(reels?|videos?|ugcs?|shorts|posts?|integrations?)\b/);
  if (!m) return 1;
  const v = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]] || 1;
  return Math.max(1, Math.min(v, 6));
}

export function isNextVideo(x, linkedStatus) {
  if (!linkedStatus) return false;
  if (x?.new_video) return true;
  return linkedStatus >= 9 && !x?.is_update;
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
      new_video: { type: 'boolean', description: 'True if the brand is starting ANOTHER video or reel (a second reel, the next video of the package, a new collaboration) instead of changing the brief of the video already in progress' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string', description: 'One short sentence' },
      brand: { type: 'string', description: 'Brand / company name as it would appear on the deal' },
      creator: { type: ['string', 'null'], enum: [...ROSTER, null], description: 'Which NOOCAP creator this is for' },
      deal_number: { type: ['integer', 'null'], description: 'Number of the matching open deal from the list, or null if none matches' },
      brief_links: { type: 'array', items: { type: 'string' }, description: 'Links to the brief or its assets, most important first' },
      brief_text: { type: 'string', description: 'The brief itself, cleaned up, if it is written in the email, the attachment or the readable doc. Keep all concrete requirements. Use short lines, "- " bullets and "## " headings. Leave out anything about the rate, budget, fee or payment. Empty if only a link was given.' },
      summary: { type: 'array', items: { type: 'string' }, description: 'The key points a scriptwriter must know for the content, max 6. Never mention the rate, price, budget, fee or payment: the scriptwriter must not see what the deal is worth.' },
      deliverables: { type: 'string' },
      video_count: { type: ['integer', 'null'], description: 'How many separate videos/reels this deal or brief covers ("2 reels" = 2, "3 UGC videos" = 3). Cross-posting the same video to other platforms does not add videos. Null if not stated.' },
      go_live_date: { type: ['string', 'null'], description: 'YYYY-MM-DD if a posting / go-live date is given' },
      draft_due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD if a script or draft deadline is given' },
      must_mention: { type: 'array', items: { type: 'string' }, description: 'Links, codes, phrases or claims that must be said or shown' },
      script_provided: { type: 'boolean', description: 'True only if the email or the readable doc already contains the finished script to film, word for word (the spoken lines, often with HOOK / INTRO / CTA sections and VISUAL notes). False when it only gives talking points, angles or examples and the script still has to be written.' },
      script_text: { type: 'string', description: 'Only when script_provided: the script exactly as given, every spoken line and VISUAL / on-screen note in order, section labels kept. Do not reword, shorten or add anything. Leave out the rate, due dates and login details.' },
    },
    required: ['is_brief', 'confidence', 'reason', 'brand', 'creator', 'deal_number', 'brief_links', 'brief_text', 'summary'],
  },
};

async function extract(email, deals, docText) {
  const dealList = deals.map((d, i) => `${i + 1}. ${d.brand} | creator: ${d.creator || '?'} | stage: ${d.stage || '?'}${d.brandEmail ? ' | brand email: ' + d.brandEmail : ''}`).join('\n') || '(no open deals)';
  const content = [];
  // PDFs go in as their text only (see pdftext.js): far cheaper than sending the file itself
  const pdfs = await (await import('./pdftext.js')).attachmentText(email.attachments);
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

${String(email.text || '').slice(0, 9000)}
${docText ? `\n--- Text of the linked brief doc ---\n${docText.slice(0, 10000)}` : ''}${pdfs ? `\n\n${pdfs}` : ''}

Decide if this email delivers a sponsored-video brief, and record the details. Match the deal by brand name, sender domain and creator. If nothing matches clearly, deal_number is null.`,
  });
  const out = await claude({
    _job: 'briefs',
    model: HAIKU,
    max_tokens: 3000,
    system: 'You file incoming brand emails for NOOCAP Media, an agency that makes sponsored videos for creators. Be precise and never invent details that are not in the email or attachments.',
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_brief' },
    messages: [{ role: 'user', content }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  const data = call?.input || { is_brief: false, confidence: 'low', reason: 'no answer' };
  if (data.summary && !Array.isArray(data.summary)) data.summary = String(data.summary).split(/\n|•|;\s/).map((t) => t.replace(/^[-*\s]+/, '').trim()).filter(Boolean);
  return { data, usage: out.usage };
}

// Video cards are seen by the script writer and editors: contracts, agreements, invoices and receipts never go on them,
// only brief files (Luma AI x Chris, Nov 6: the signed partnership agreement was attached to the card)
const PRIVATE_FILE = /contract|agreement|(?:^|[^a-z])inv[-_ ]?\d|\bnda\b|invoice|receipt|payment|w-?9|w-?8|tax|signed|docusign|sow\b|statement of work/i;
export const cardFiles = (atts) => (atts || []).filter((a) => !PRIVATE_FILE.test(a.filename || '')).slice(0, 2);

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
  // Key points are the reader's summary of the email, which also covers the contract and payment terms; none of that
  // belongs on a card the team sees (CapCut x Lindsay, Nov 12: "Collaboration agreement contract attached, needs
  // signature" and "Payment 100% within 7 days after ... invoice" reached the card). The full brief keeps its product
  // prices through noMoney below.
  const points = (x.summary || []).filter((s) => s && !CONTRACT_LINE.test(s) && !isDealMoney(s));
  if (points.length) {
    lines.push('## Key points');
    for (const s of points) lines.push('- ' + s);
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
  // The brand (or creator) already wrote the script: it goes under "Script", ready to film, instead of being buried in the brief
  const given = !heading && x.script_provided && String(x.script_text || '').trim()
    ? [{ object: 'block', type: 'callout', callout: { icon: { type: 'emoji', emoji: '✅' }, rich_text: [{ type: 'text', text: { content: 'Script provided by the brand, as they wrote it. Film from this.' } }] } },
      ...String(x.script_text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 90).map((l) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: l.slice(0, 1900) }, ...(/^[A-Z0-9 &:()\-–.]+$/.test(l) && l.length < 60 ? { annotations: { bold: true } } : {}) }] } }))]
    : [];
  return [
    { object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: label } }], children: inner.slice(0, 98) } },
    ...(heading ? [] : [{ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Script' } }] } }]),
    ...given,
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
// fee / total / package / deliverables next to an amount is what the deal is worth ("Total fee: USD $1,300 for Instagram
// Reel and Story package" reached Rudraksh's channel, Luma AI x Chris, Nov 6)
const DEAL_CONTEXT = /\b(?:fees?|total|package|deliverables?|works for|within our|agreed|offer(?:ed|ing)?|deal|confirm(?:s|ed)?|collab(?:oration)?|sponsorship|we charge|charges?|quoted?|counter(?:ed)?|clos(?:e|ed|ing)|pay(?:ing)? (?:you|chris|us|him|her|the creator)|chris|creator|rate)\b/i;
function isDealMoney(line) {
  const l = String(line);
  return DEAL_WORDS.test(l) || (AMOUNT.test(l) && DEAL_CONTEXT.test(l));
}
export function noMoney(text) {
  return String(text || '').split('\n').filter((l) => !isDealMoney(l)).join('\n');
}
export const noMoneyList = (arr) => (arr || []).filter((l) => l && !isDealMoney(l));
// Contract business is for Harsh and Pratham only (it reaches them on WhatsApp): the script writer's channel drops any
// line about the contract, its clauses, signing, legal terms or payment, the same way it drops the rate.
const CONTRACT_LINE = /\b(?:contracts?|agreements?|clauses?|addendum|exclusivity|indemnif\w*|terminat\w*|liabilit\w*|docusign|e-?sign\w*|signed|signing|signature|legal|nda|invoices?|payments?|usage rights?|licens(?:e|ing)|whitelist\w*|net ?\d{2})\b/i;
// Hard stop for the script writer's channel (Harsh, Nov 7: "make sure this doesn't happen again"): no line with ANY
// amount or money word goes out, however it is phrased. Product prices live in the brief on the card, so the ping never
// needs them. The headline (first line) keeps its words but loses any amount too.
const ANY_AMOUNT = /(?:[$€£₹]\s?\d)|\b\d[\d,.]*\s?k?\s?(?:usd|dollars?|eur|euros?|gbp|inr|rupees?|bucks)\b|\b(?:usd|eur|gbp|inr)\s?\d/i;
const MONEY_WORD = /\b(?:fees?|rates?|budget|price[ds]?|pricing|paid|payments?|pay(?:ing)?|invoices?|compensation|payout|cost|deposit|upfront|50%|net ?\d{2})\b/i;
export function forScriptWriter(text) {
  const lines = String(text || '').split('\n');
  const head = String(lines[0] || '').replace(/[$€£₹]\s?\d[\d,.]*\s?k?|\b(?:usd|eur|gbp|inr)\s?\d[\d,.]*k?|\b\d[\d,.]*\s?k?\s?(?:usd|dollars?|eur|euros?|gbp|inr|rupees?|bucks)\b/gi, '').replace(/\s{2,}/g, ' ');
  return [head, ...lines.slice(1).filter((l) => !isDealMoney(l) && !CONTRACT_LINE.test(l) && !ANY_AMOUNT.test(l) && !MONEY_WORD.test(l))].join('\n');
}

// ---------- step 3: tell Rudraksh ----------
// Channels: 'pm' = #pm-alerts, ONLY things a person has to act on. 'scripts' = Rudraksh's channel.
// 'log' = FYI updates: not posted anywhere (they're in the AGENT LOG and the HQ activity feed) unless
// DISCORD_LOG_WEBHOOK is set. Link previews are switched off (flags: 4) so messages stay compact.
// #pm-alerts keeps only what needs Harsh (Harsh, Nov 9: "it sends cluttered alerts"). Updates that need nothing from
// him (approved, cleared, sent, paid, a reply came in) are queued and posted once an hour as one short list, one line
// each. A needs-you alert already posted in the last 12 hours with the same headline is not posted again.
export const FYI_EMOJI = ['🎉', '✅', '📅', '▶️', '📝', '🤖', '🧾', '💸', '💰', '🆕', '🎬', '✏️', '⏸️', '📨', '📋', '⏳', '📎'];
const leadEmoji = (t) => (String(t).trim().match(/^(\p{Extended_Pictographic}\uFE0F?)/u) || [])[1] || '';
export const isFyi = (content) => { const e = leadEmoji(content).replace(/\uFE0F/g, ''); return !!e && FYI_EMOJI.some((f) => f.replace(/\uFE0F/g, '') === e) && !NEEDS_HARSH.test(String(content)); };
// Lines that ask Harsh to do something keep an alert in the channel whatever its emoji
const NEEDS_HARSH = /needs you|needs your|over to you|approval needed|still to send|no deal to send|couldn'?t|stopped chasing|please set|tell me|send it (?:to|from)|paste|ask \w+ to send|script ready|cut ready|chase (?:it|them|manually)|by hand|check with/i;
export const headlineOf = (content) => String(content).split('\n')[0].replace(/\*\*/g, '').replace(/<@\d+>/g, '').trim();
async function queueFyi(content) {
  await notion('POST', '/pages', { parent: { data_source_id: DS.agentLog }, properties: { Event: { title: [{ type: 'text', text: { content: ('Queued FYI · ' + headlineOf(content)).slice(0, 200) } }] }, Details: { rich_text: [{ type: 'text', text: { content: String(content).slice(0, 1900) } }] } } });
  return true;
}
async function postedRecently(content) {
  const key = ('Alert · ' + headlineOf(content)).slice(0, 200);
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { equals: key } }, { timestamp: 'created_time', created_time: { after: new Date(Date.now() - 12 * 36e5).toISOString() } }] } }).catch(() => ({ results: [] }));
  if ((r.results || []).length) return true;
  await notion('POST', '/pages', { parent: { data_source_id: DS.agentLog }, properties: { Event: { title: [{ type: 'text', text: { content: key } }] } } }).catch(() => {});
  return false;
}
// Hourly: the queued updates as one message, grouped, one line each
export async function flushFyi() {
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 60, filter: { property: 'Event', title: { starts_with: 'Queued FYI' } }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] }).catch(() => ({ results: [] }));
  const rows = (r.results || []).filter((p) => !p.in_trash);
  if (!rows.length) return 0;
  const lines = [...new Set(rows.map((p) => plain(p.properties?.Event).replace(/^Queued FYI · /, '')))].map((h) => '• ' + h.slice(0, 150));
  const pm = process.env.DISCORD_PM_WEBHOOK;
  if (pm) {
    let buf = `🗒️ **Updates, nothing needed from you (${lines.length})**`;
    for (const l of lines) { if ((buf + '\n' + l).length > 1900) { await fetch(pm, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: buf, flags: 4, allowed_mentions: { parse: [] } }) }); buf = ''; } buf += (buf ? '\n' : '') + l; }
    if (buf) await fetch(pm, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: buf, flags: 4, allowed_mentions: { parse: [] } }) });
  }
  for (const p of rows) await notion('PATCH', `/pages/${p.id}`, { properties: { Event: { title: [{ type: 'text', text: { content: plain(p.properties?.Event).replace(/^Queued FYI/, 'FYI sent').slice(0, 200) } }] } } }).catch(() => {});
  return lines.length;
}

export async function discord(content, channel = 'scripts', opts = {}) {
  if (channel === 'pm' && !opts.now) {
    try {
      if (isFyi(content)) return await queueFyi(content);
      if (await postedRecently(content)) return true;
    } catch (e) { console.error('pm alert routing', e.message); }
  }
  // Pings that need Harsh or Pratham also go to their WhatsApp (the forward list decides which ones)
  if (channel === 'pm' || channel === 'log') { try { const W = await import('./whatsapp.js'); await W.forward(content); } catch (e) { console.error('WhatsApp forward failed', e.message); } }
  // #pm-alerts carries prices, payments and contracts, so it never falls back to the script writer's channel:
  // with no DISCORD_PM_WEBHOOK those alerts go to WhatsApp only
  const pm = process.env.DISCORD_PM_WEBHOOK;
  if (channel === 'log' && !process.env.DISCORD_LOG_WEBHOOK) return true;
  const hook = channel === 'pm' ? pm : channel === 'log' ? process.env.DISCORD_LOG_WEBHOOK : process.env.DISCORD_SCRIPTS_WEBHOOK;
  if (!hook) return false;
  const shreya = process.env.SCRIPTWRITER_DISCORD_ID; // Rudraksh (was Shreya: SHREYA_DISCORD_ID is no longer used, so she is never tagged)
  if (channel === 'scripts') content = forScriptWriter(content);
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
export const tag = () => (process.env.SCRIPTWRITER_DISCORD_ID ? `<@${process.env.SCRIPTWRITER_DISCORD_ID}>` : '@Rudraksh');

export async function log({ event, outcome, email, x, deal, details, usage, cost, creator, side, area, source }) {
  const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
  const props = {
    Event: { title: rt(event.slice(0, 120)) },
    Time: { date: { start: new Date().toISOString() } },
    Area: { select: { name: area || 'Brand deals' } },
    Outcome: { select: { name: outcome } },
    Source: { select: { name: source || 'noocapcollab' } },
    Rule: { rich_text: rt('Brief catcher' + (x?.reason ? ': ' + x.reason : '') + (x?.we_owe ? ` || We owe: ${x.we_owe}` : '') + (x && x.needs_reply === false && !x.we_owe && x.from_role === 'brand' ? ' || No reply needed' : '')) },
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

// A brief email that also asks something ("when can we expect the script?") still needs an answer:
// draft a reply for Harsh, marked Needs you, since only he can promise a date
async function answerQuestions(deal, email) {
  const latest = String(email.text || '').split(/\r?\n(?:On .{4,200}wrote:|-{2,}\s*Original Message|From:\s)/i)[0];
  const qs = (latest.replace(/https?:\/\/\S+/g, ' ').replace(/\s*\n+\s*/g, '. ').replace(/\s+/g, ' ').match(/[^.?!]{8,300}\?/g) || []).map((q) => q.trim()).slice(0, 3);
  if (!qs.length || !deal?.id) return '';
  const { writeEmail, createDraft, pendingDraft } = await import('./outbox.js');
  if (await pendingDraft(deal.id, 'Reply')) return ' · question noted (a reply is already waiting in Approvals)';
  const mail = await writeEmail({ kind: 'Reply', deal, facts: { their_questions: qs, note: 'Thank them for the brief. Answer their questions. If they ask for a date or timeline and none is known, write "[DATE]" where the date goes so Harsh fills it in. Never invent a date or agree to terms.' } });
  await createDraft({ kind: 'Reply', deal, subject: mail.subject, body: mail.body, why: `Needs you: ${deal.brand} asked "${qs[0].slice(0, 140)}". Check the answer${/\[DATE\]/.test(mail.body) ? ' and fill in [DATE]' : ''} before sending.`, context: latest.slice(0, 3000) });
  return ` · reply to their question drafted for approval`;
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
export async function briefFromText({ text, subject, dealId, threadId, creator, channel }) {
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
  if (channel) x.channel = channel;
  // A creator confirmed by a person (WhatsApp forward, Approvals button) wins over the AI's guess, and so does the deal
  // it picks: a deal of another creator with the same brand is not this one
  if (!deal && creator) {
    x.creator = creator;
    const d = x.deal_number ? deals[x.deal_number - 1] : null;
    if (d && CREATOR_KEY(d.creator || '') !== CREATOR_KEY(creator)) x.deal_number = null;
  }
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
    // The month tab the team is working in right now is the one they pre-made empty rows in (Brad's "SEPTEMBER" tab
    // still holds his October videos). The calendar month is only the fallback when a board has no empty rows.
    let label = null;
    try {
      const r = await notion('POST', `/data_sources/${ds}/query`, { page_size: 25, filter: { and: [{ property: titleName, title: { is_empty: true } }, { property: monthEntry[0], select: { is_not_empty: true } }] }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] });
      label = (r.results || []).map((pg) => pg.properties?.[monthEntry[0]]?.select?.name).find(Boolean) || null;
    } catch { /* fall back */ }
    if (!label) label = monthOption(monthEntry[1].select?.options || [], monthLabel());
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

// Is this email from the people on that deal? Same Gmail thread, or the sender's company is the deal's brand contact
// or in its Thread CC. A brand name plus the creator is not enough: CapCut x Chris runs through two agencies, and Mia
// at GrowMaxValue's new CapCut brief (own thread, signed contract) was filed as a brief update on the other agency's
// CapCut x ChatGPT deal (Nov 5). A deal with no email thread (WhatsApp, added by hand) can still take it.
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail|pm|zoho|gmx|mail)\.[a-z.]{2,6}$/i;
export function sameDealParty(deal, email) {
  if (!deal || !email) return false;
  if (email.threadId && deal.threadId && deal.threadId === email.threadId) return true;
  if (!deal.threadId) return true;
  const addr = (String(email.from || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0].toLowerCase();
  if (!addr) return false;
  const key = (a) => { const d = a.split('@')[1] || ''; return FREE_MAIL.test(d) ? a : d.split('.').slice(-2).join('.'); };
  const mine = key(addr);
  const theirs = String(`${deal.brandEmail || ''},${deal.threadCc || ''}`).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  return theirs.some((a) => key(a.toLowerCase()) === mine);
}

export async function fileBrief({ email, x, deals, deal: givenDeal, allLinks = [], docText = null, usage, cost }) {
  let deal = givenDeal || (x.deal_number ? deals[x.deal_number - 1] : null);
  // The AI matched by brand name, but the email comes from another company on another thread: a new deal
  if (!givenDeal && deal && !sameDealParty(deal, email)) { x.creator = x.creator || deal.creator; deal = null; x.deal_number = null; }
  const creator = deal?.creator || x.creator || null;
  const board = creator ? BOARDS.find((b) => CREATOR_KEY(b.creator) === CREATOR_KEY(creator)) : null;

  if (!board) {
    const msg = `📨 A brief arrived but I couldn't tell which creator it's for.\n**${email.subject || '(no subject)'}** from ${email.from || '?'}\nBrand: ${x.brand || '?'}. Please file it by hand or tell the PM in chat.`;
    await discord(msg, 'pm');
    await log({ event: `Brief needs a creator: ${x.brand || email.subject}`, outcome: 'Needs approval', email, x, details: msg, usage, cost });
    return { action: 'needs_help', why: 'no creator' };
  }

  const links = [...new Set([...(x.brief_links || []), ...allLinks])].slice(0, 8);

  // An old email (catch-up) never creates cards or pings Rudraksh: the team has almost certainly handled it already
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

  if (deal && x.channel && deal.channel !== x.channel) {
    try { const ds = await schemaOf(DS.deals); const pp = {}; setIf(ds, pp, 'Channel', x.channel); if (Object.keys(pp).length) await notion('PATCH', `/pages/${deal.id}`, { properties: pp }); deal = { ...deal, channel: x.channel }; } catch { /* keep going */ }
  }
  // Updated brief for a deal that already has a video: add to that page instead of making a new one.
  const videoMatch = deal?.linkedVideo && String(deal.linkedVideo).match(/([0-9a-f]{32})(?:\?|$)/i);
  // A brief for the NEXT video (second reel of a package, a repeat collaboration) gets its own card: never pile it onto
  // the first video's card, which is filmed, posted or on its way out (SpeakOn reel 2 landed on reel 1's page, Nov 3)
  let linkedStatus = 0;
  let repeatOf = null;
  if (videoMatch) { try { const vp = await notion('GET', `/pages/${videoMatch[1]}`); linkedStatus = parseInt(plain(vp.properties?.Status || vp.properties?.status) || '0', 10) || 0; } catch { /* treat as unknown */ } }
  if (isNextVideo(x, linkedStatus)) {
    // Reel 2's card may already exist (made when the deal came in for several reels): the brief goes there
    const nb = String(x.brand || deal.brand || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
    const waiting = nb.length >= 3 ? (await queryAll(board.ds).catch(() => [])).filter((p) => !p.in_trash && !p.archived && p.id.replace(/-/g, '') !== videoMatch[1])
      .map((p) => ({ p, t: titleOf(p) || '', st: parseInt(plain(p.properties?.Status || p.properties?.status) || '0', 10) }))
      .filter(({ t, st }) => t.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(nb) && st > 0 && st <= 5)
      .sort((a, b) => Date.parse(a.p.created_time) - Date.parse(b.p.created_time)) : [];
    deal = { ...deal, linkedVideo: waiting[0]?.p.url || '' };
    // A repeat campaign on a deal that is already posted, invoiced or paid (ElevenLabs x Duncan: November's Huedini brief
    // came in the October thread, Oct 30, and was folded into October's invoiced deal, so the script never went out):
    // it gets a deal of its own, so the script is flagged and sent and October's invoice keeps being chased on its own
    if (!waiting[0] && ['Posted', 'Invoiced', 'Paid'].includes(deal.stage)) { repeatOf = deal; deal = null; }
  }
  const target = deal?.linkedVideo && String(deal.linkedVideo).match(/([0-9a-f]{32})(?:\?|$)/i);
  if (deal && target && (x.is_update || deal.linkedVideo)) {
    const pageId = target[1];
    if (!videoMatch || videoMatch[1] !== pageId) { try { const ds = await schemaOf(DS.deals); const pp = {}; setIf(ds, pp, 'Linked Video', deal.linkedVideo); if (Object.keys(pp).length) await notion('PATCH', `/pages/${deal.id}`, { properties: pp }); } catch { /* the brief still lands on the card */ } }
    const uploads = [];
    for (const a of cardFiles(email.attachments)) { const id = await uploadToNotion(a); if (id) uploads.push(id); }
    const blocks = pageBody({ x, email, links, uploads, docText, heading: `📋 Brief update ${todayIST()} from ${x.brand || deal.brand}` });
    await notion('PATCH', `/blocks/${pageId}/children`, { children: blocks });
    // The next reel's card was made with no POST DATE, so it never showed on the creator's calendar (SpeakOn x Chris (2),
    // Nov 5). When its brief lands, it gets the brand's go-live date, else the usual brief + 6 days, like a new card.
    try {
      const card = await notion('GET', `/pages/${pageId}`);
      const dp = Object.entries(card.properties || {}).find(([n, v]) => v.type === 'date' && /post/i.test(n) && !/posted/i.test(n));
      if (dp && !dp[1].date?.start) {
        const briefDay = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(Date.parse(email.date) + 5.5 * 36e5).toISOString().slice(0, 10) : todayIST();
        await notion('PATCH', `/pages/${pageId}`, { properties: { [dp[0]]: { date: { start: x.go_live_date || sponsorPostDate(briefDay) } } } });
      }
    } catch (e) { console.error('card post date', e.message); }
    await discord(`${tag()} ✏️ **Brief updated: ${deal.brand} × ${deal.creator}**\n${(x.summary || []).slice(0, 3).map((s) => '• ' + s).join('\n')}\nNotion: ${deal.linkedVideo}`);
    const asked = await answerQuestions(deal, email).catch(() => '');
    await log({ event: `Brief updated: ${deal.brand} × ${deal.creator}`, outcome: 'Rule', email, x, deal, details: `Added to ${deal.linkedVideo}${asked}`, usage, cost, creator: deal.creator });
    return { action: 'updated', video: deal.linkedVideo, deal: deal.url };
  }

  // No matching deal: create one so nothing is lost, flagged for Harsh to check.
  let createdDeal = false;
  if (!deal) {
    const dealSchema = await schemaOf(DS.deals);
    const props = { 'Brand Name': { title: [{ type: 'text', text: { content: (x.brand || repeatOf?.brand || 'Unknown brand').slice(0, 200) } }] } };
    setIf(dealSchema, props, 'Creator', board.creator);
    setIf(dealSchema, props, 'Deal Stage', 'Brief Received');
    setIf(dealSchema, props, 'Deal Source', 'Auto-captured');
    setIf(dealSchema, props, 'Needs Check', true);
    // Where the brand is handled: a deal forwarded on WhatsApp is the creator's to run with the brand, so the PM never emails them
    setIf(dealSchema, props, 'Channel', x.channel || 'Email');
    setIf(dealSchema, props, 'Deliverables', x.deliverables);
    setIf(dealSchema, props, 'Deadline', x.go_live_date);
    const fromEmail = (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
    setIf(dealSchema, props, 'Brand Email', repeatOf?.brandEmail || fromEmail);
    if (repeatOf) { setIf(dealSchema, props, 'Billing Details', repeatOf.billing); setIf(dealSchema, props, 'Notes', `Repeat campaign: new brief in the thread of the earlier ${repeatOf.brand} deal (${repeatOf.url}).`); }
    setIf(dealSchema, props, 'Thread ID', email.threadId);
    setIf(dealSchema, props, 'Message ID', email.messageId);
    setIf(dealSchema, props, 'Thread Subject', threadSubject(email.subject));
    setIf(dealSchema, props, 'Thread CC', repeatOf?.threadCc || threadCcFrom(email));
    const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.deals }, properties: props });
    deal = { id: page.id, url: page.url, brand: x.brand || repeatOf?.brand || 'Unknown brand', creator: board.creator, stage: 'Brief Received', agentNotes: '' };
    createdDeal = true;
  }

  // Create the video card
  const { title, titleName, schema } = await uniqueTitle(board.ds, `${deal.brand} × ${board.creator}`);
  const props = { [titleName]: { title: [{ type: 'text', text: { content: title } }] } };
  const statusProp = findProp(schema, 'status');
  if (statusProp) {
    const opts = statusProp[1].select?.options || statusProp[1].status?.options || [];
    const scriptGiven = x.script_provided && String(x.script_text || '').trim();
    const opt = opts.find((o) => parseInt(o.name, 10) === (scriptGiven ? 6 : SCRIPT_STATUS)); // 6- To Film when the script came with the brief
    if (opt) props[statusProp[0]] = statusProp[1].type === 'status' ? { status: { name: opt.name } } : { select: { name: opt.name } };
  }
  setIf(schema, props, 'type', 'SPONSOR');
  // The brand's own go-live date wins; otherwise the card posts 6 days after the brief came in
  const briefDay = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(Date.parse(email.date) + 5.5 * 36e5).toISOString().slice(0, 10) : todayIST();
  setIf(schema, props, 'post date', x.go_live_date || deal.deadline || sponsorPostDate(briefDay));
  const briefProp = Object.entries(schema).find(([n]) => lc(n) === 'brief');
  if (briefProp && links[0]) {
    if (briefProp[1].type === 'url') props[briefProp[0]] = { url: links[0] };
    else if (briefProp[1].type === 'rich_text') props[briefProp[0]] = { rich_text: [{ type: 'text', text: { content: links[0] } }] };
  }
  const uploads = [];
  for (const a of cardFiles(email.attachments)) { const id = await uploadToNotion(a); if (id) uploads.push(id); }
  const body = pageBody({ x, email, links, uploads, docText });
  const video = await placeCard({ ds: board.ds, schema, titleName, props, body });
  // A deal for several reels gets one card per reel from the start, so every reel moves through the board on its own
  const count = videoCount(x, deal);
  const extra = [];
  for (let i = 2; i <= count; i++) {
    try {
      const t = await uniqueTitle(board.ds, `${deal.brand} × ${board.creator}`);
      const p2 = { ...props, [titleName]: { title: [{ type: 'text', text: { content: t.title } }] } };
      const note = [{ object: 'block', type: 'callout', callout: { rich_text: [{ type: 'text', text: { content: `Reel ${i} of ${count} for this deal. The brief is the same as reel 1: ${video.url}` } }], icon: { type: 'emoji', emoji: '🎬' } } }];
      const v = await placeCard({ ds: board.ds, schema, titleName, props: p2, body: [...note, ...body] });
      extra.push(v.url);
    } catch (e) { console.error('extra reel card', e.message); }
  }

  // Update the deal
  const dealSchema = await schemaOf(DS.deals);
  const dprops = {};
  if (!createdDeal && (BEFORE_BRIEF.includes(deal.stage) || !deal.stage)) setIf(dealSchema, dprops, 'Deal Stage', 'Brief Received');
  setIf(dealSchema, dprops, 'Linked Video', video.url);
  // Only a real brand email counts as the brand writing: a brief the creator forwarded on WhatsApp is not one
  if (x.channel !== 'WhatsApp' && deal?.channel !== 'WhatsApp') setIf(dealSchema, dprops, 'Last Brand Reply', istStamp(Number.isFinite(Date.parse(email?.date || '')) ? Date.parse(email.date) : Date.now()));
  const scriptGiven = !!(x.script_provided && String(x.script_text || '').trim());
  if (scriptGiven && ['Inbound', 'Negotiating', 'Price Agreed', 'Signed', 'Brief Received', 'Script Sent', ''].includes(deal.stage || '')) { setIf(dealSchema, dprops, 'Deal Stage', 'Script Approved'); setIf(dealSchema, dprops, 'Script Approved Date', todayIST()); }
  setIf(dealSchema, dprops, 'Next Action', scriptGiven ? `${board.creator} filming (the brand sent the script)` : 'Rudraksh writing the script');
  setIf(dealSchema, dprops, 'Thread ID', email.threadId);
  setIf(dealSchema, dprops, 'Message ID', email.messageId);
  setIf(dealSchema, dprops, 'Thread Subject', threadSubject(email.subject));
  setIf(dealSchema, dprops, 'Thread CC', threadCcFrom(email, deal.threadCc));
  setIf(dealSchema, dprops, 'Agent Notes', ((deal.agentNotes ? deal.agentNotes + '\n' : '') + `[${todayIST()}] Brief received, video card created, Rudraksh notified.`).slice(-1900));
  if (!deal.deliverables && x.deliverables) setIf(dealSchema, dprops, 'Deliverables', x.deliverables);
  if (Object.keys(dprops).length) await notion('PATCH', `/pages/${deal.id}`, { properties: dprops });
  clearCache();

  // Tell Rudraksh
  const due = x.draft_due_date ? `\nScript due: ${x.draft_due_date}` : '';
  const live = x.go_live_date ? `\nGo live: ${x.go_live_date}` : '';
  const points = (x.summary || []).slice(0, 4).map((s) => '• ' + s).join('\n');
  const pinged = scriptGiven
    ? await discord(`📝 **New brand deal: ${deal.brand} × ${board.creator}** · no script needed\nThe brand sent the finished script, so it's on the card under Script and the card is at To Film.${due}${live}\nNotion: ${video.url}`)
    : await discord(`${tag()} 📝 **New brand deal: ${deal.brand} × ${board.creator}**${extra.length ? ` · ${extra.length + 1} reels` : ''}\nThe brief is in Notion, please start the script.${due}${live}\n${points}\nBrief: ${links[0] || 'inside the Notion page'}\nNotion: ${video.url}${extra.map((u, i) => `\nReel ${i + 2}: ${u}`).join('')}`);
  // A deal opened on its own from an email is Harsh's to check, so he hears it in #pm-alerts (never in Rudraksh's
  // channel). A deal a person filed (WhatsApp forward, the Approvals button) needs no warning.
  if (createdDeal && !/^manual-brief-/.test(String(email.messageId || ''))) await discord(`🆕 **New deal opened from a brief: ${deal.brand} × ${board.creator}**\n• No existing deal matched this brief, so I opened one (Needs Check). Add the rate and the brand's email.\n→ ${deal.url}`, 'pm').catch(() => {});

  await log({
    event: `Brief filed: ${deal.brand} × ${board.creator}`,
    outcome: createdDeal ? 'Needs approval' : 'Rule',
    email, x, deal, usage, cost, creator: board.creator,
    details: `Video: ${video.url}\nDeal: ${deal.url}${createdDeal ? ' (new, Needs Check)' : ''}\nRudraksh pinged: ${pinged ? 'yes' : 'no (DISCORD_SCRIPTS_WEBHOOK missing)'}`,
  });
  if (!createdDeal) await answerQuestions(deal, email).catch(() => '');
  return { action: 'filed', video: video.url, title, deal: deal.url, createdDeal, pinged, cost };
}

// More videos for a brand the creator already works with ("add 4 more videos of Higgsfield", WhatsApp, Nov 9): one
// card per video on the creator's board at Script Draft, sponsor, brief linked, post date set, then one message to
// Rudraksh with all of them. No deal row is touched, so nothing about money moves.
export async function addVideoCards({ creator, brand, videos = [] }) {
  const board = BOARDS.find((b) => lc(b.creator) === lc(creator));
  if (!board) throw new Error(`no board for ${creator}`);
  const made = [];
  const schema0 = await schemaOf(board.ds);
  const bp = Object.entries(schema0).find(([n]) => lc(n).trim() === 'brief' || lc(n).trim() === 'brand brief');
  for (const v of videos) {
    // A brief already on a card of this board is that video: never a second card for it (resent message, Nov 9)
    if (v.brief && bp && bp[1].type === 'url') {
      const hit = await notion('POST', `/data_sources/${board.ds}/query`, { page_size: 1, filter: { property: bp[0], url: { equals: v.brief } } }).catch(() => ({ results: [] }));
      const old = (hit.results || []).find((x) => !x.in_trash);
      if (old) { made.push({ title: titleOf(old) || v.title, url: old.url, post: null, brief: v.brief, existed: true }); continue; }
    }
    // A card already waiting for this brand's brief (made ahead when the deal was agreed, e.g. Higgsfield V3 and V4 for
    // Lindsay, Nov 11) takes the brief instead of a new card being made next to it
    if (v.brief && bp) {
      const key = lc(brand).replace(/[^a-z0-9]/g, '').slice(0, 6);
      const tn0 = Object.entries(schema0).find(([, x]) => x.type === 'title')?.[0];
      const sp0 = findProp(schema0, 'status');
      const waiting = tn0 && sp0 ? await notion('POST', `/data_sources/${board.ds}/query`, { page_size: 20, filter: { and: [{ property: tn0, title: { is_not_empty: true } }, { property: bp[0], [bp[1].type === 'url' ? 'url' : 'rich_text']: { is_empty: true } }] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] }).catch(() => ({ results: [] })) : { results: [] };
      const slot = (waiting.results || []).find((x) => !x.in_trash && key && lc(titleOf(x)).replace(/[^a-z0-9]/g, '').includes(key) && /^\s*2\s*-/.test(plain(x.properties?.[sp0[0]]) || ''));
      if (slot) {
        const props = { [bp[0]]: bp[1].type === 'url' ? { url: v.brief } : { rich_text: [{ type: 'text', text: { content: v.brief } }] } };
        const opt = (sp0[1].select?.options || sp0[1].status?.options || []).find((o) => parseInt(o.name, 10) === SCRIPT_STATUS);
        if (opt) props[sp0[0]] = sp0[1].type === 'status' ? { status: { name: opt.name } } : { select: { name: opt.name } };
        const day0 = /^\d{4}-\d{2}-\d{2}$/.test(String(v.post_date || '')) ? v.post_date : null;
        if (day0) setIf(schema0, props, 'post date', day0);
        await notion('PATCH', `/pages/${slot.id}`, { properties: props });
        made.push({ title: titleOf(slot), url: slot.url, post: day0, brief: v.brief });
        continue;
      }
    }
    let title = String(v.title || `${brand} × ${creator}`).trim();
    const bk = lc(brand).replace(/[^a-z0-9]/g, '').slice(0, 6);
    if (bk && !lc(title).replace(/[^a-z0-9]/g, '').includes(bk)) title = `${brand} · ${title}`;
    title = title.slice(0, 120);
    // No brief yet: the same card is not made twice when the message is sent again
    if (!v.brief) {
      const tn = Object.entries(schema0).find(([, x]) => x.type === 'title')?.[0];
      const hit = tn ? await notion('POST', `/data_sources/${board.ds}/query`, { page_size: 1, filter: { property: tn, title: { equals: title.toUpperCase() } } }).catch(() => ({ results: [] })) : { results: [] };
      const old = (hit.results || []).find((x) => !x.in_trash);
      if (old) { made.push({ title: titleOf(old) || title, url: old.url, post: null, brief: null, existed: true }); continue; }
    }
    const u = await uniqueTitle(board.ds, title.toUpperCase());
    const props = { [u.titleName]: { title: [{ type: 'text', text: { content: u.title } }] } };
    const statusProp = findProp(u.schema, 'status');
    if (statusProp) {
      const opt = (statusProp[1].select?.options || statusProp[1].status?.options || []).find((o) => parseInt(o.name, 10) === SCRIPT_STATUS);
      if (opt) props[statusProp[0]] = statusProp[1].type === 'status' ? { status: { name: opt.name } } : { select: { name: opt.name } };
    }
    setIf(u.schema, props, 'type', 'SPONSOR');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(v.post_date || '')) ? v.post_date : null;
    if (day) { setIf(u.schema, props, 'post date', day); if (u.schema['DUE DATE']) setIf(u.schema, props, 'DUE DATE', day); }
    const briefProp = Object.entries(u.schema).find(([n]) => lc(n).trim() === 'brief' || lc(n).trim() === 'brand brief');
    if (briefProp && v.brief) {
      if (briefProp[1].type === 'url') props[briefProp[0]] = { url: v.brief };
      else if (briefProp[1].type === 'rich_text') props[briefProp[0]] = { rich_text: [{ type: 'text', text: { content: v.brief } }] };
    }
    const body = !v.brief ? [{ object: 'block', type: 'callout', callout: { rich_text: [{ type: 'text', text: { content: `The brief for this video comes later from ${brand}. Start once it is added to this card.` } }], icon: { type: 'emoji', emoji: '⏳' } } }] : [{ object: 'block', type: 'callout', callout: { rich_text: [{ type: 'text', text: { content: `Brief from ${brand}: ` } }, { type: 'text', text: { content: v.brief, link: { url: v.brief } } }], icon: { type: 'emoji', emoji: '📋' } } }];
    const page = await placeCard({ ds: board.ds, schema: u.schema, titleName: u.titleName, props, body });
    made.push({ title: u.title, url: page.url, post: day, brief: v.brief || null });
  }
  const fresh = made.filter((m) => !m.existed);
  if (fresh.length) {
    const made = fresh;
    const fmt = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'no post date yet');
    await discord(`${tag()} 📝 **${made.length} new ${brand} video${made.length === 1 ? '' : 's'} for ${creator}**, script needed\n${made.map((m) => `• ${m.title} · posts ${fmt(m.post)}${m.brief ? `\n  Brief: ${m.brief}` : ''}\n  Card: ${m.url}`).join('\n')}`).catch(() => false);
    await log({ event: `More videos added: ${brand} × ${creator}`, outcome: 'Rule', email: { messageId: '' }, details: made.map((m) => `${m.title} ${m.url}`).join('\n').slice(0, 1900), creator }).catch(() => {});
  }
  return made;
}

// A brief link put on a card that is waiting for it (Harsh pasted Higgsfield × Chris #3's brief, Nov 11, and asked for it
// to go to the script writer): the card moves to Script Draft and Rudraksh is pinged, without anyone doing it by hand.
export async function briefsAddedToWaitingCards() {
  const out = [];
  for (const board of BOARDS) {
    try {
      const schema = await schemaOf(board.ds);
      const sp = findProp(schema, 'status');
      const bp = Object.entries(schema).find(([n, p]) => /^brief$/i.test(n) && ['url', 'rich_text'].includes(p.type));
      if (!sp || !bp) continue;
      const opts = sp[1].select?.options || sp[1].status?.options || [];
      const waiting = opts.find((o) => parseInt(o.name, 10) === 2);
      const draft = opts.find((o) => parseInt(o.name, 10) === SCRIPT_STATUS);
      if (!waiting || !draft) continue;
      const kind = sp[1].type === 'status' ? 'status' : 'select';
      const r = await notion('POST', `/data_sources/${board.ds}/query`, { page_size: 20, filter: { and: [{ property: sp[0], [kind]: { equals: waiting.name } }, { property: bp[0], [bp[1].type === 'url' ? 'url' : 'rich_text']: { is_not_empty: true } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: new Date(Date.now() - 2 * 864e5).toISOString() } }] } });
      // only cards touched in the last two days: old cards left at Waiting with a link are not swept up
      for (const card of r.results || []) {
        const brief = plain(card.properties?.[bp[0]]).trim();
        if (!/^https?:\/\//.test(brief)) continue;
        await notion('PATCH', `/pages/${card.id}`, { properties: { [sp[0]]: { [kind]: { name: draft.name } } } });
        await notion('PATCH', `/blocks/${card.id}/children`, { children: [{ object: 'block', type: 'callout', callout: { icon: { emoji: '📋' }, rich_text: [{ type: 'text', text: { content: `Brief from the brand: ${brief}` } }] } }] }).catch(() => {});
        const pd = Object.entries(card.properties || {}).find(([n, p]) => p.type === 'date' && /post/i.test(n))?.[1]?.date?.start;
        const title = titleOf(card);
        const ok = await discord(`${tag()} 📝 **Brief in: ${title}** (${board.creator}), please start the script.${pd ? `\nPosts ${pd}.` : ''}\nBrief: ${brief}\nNotion: ${card.url}`);
        // The marker pingNewSponsorCards looks for: without it the same new card was announced a second time as
        // "New video" nine minutes later (Dreamina x Chris (Artist Team), Nov 12)
        if (ok) await log({ event: `Writer pinged: ${title}`.slice(0, 120), outcome: 'Rule', email: { messageId: '' }, details: `Video: ${card.url} ${card.id.replace(/-/g, '')}`, creator: board.creator }).catch(() => {});
        out.push(`${title} (${board.creator})`);
      }
    } catch { /* that board next run */ }
  }
  return out;
}
