// PM OUTBOX: every email to a brand is a draft first. Harsh approves in the PM app, then n8n sends it from noocapcollab.
import { notion, plain, clearCache } from './notion.js';
import { DS, todayIST } from './tools.js';
import { schemaOf } from './actions.js';
import { setIf, discord, uploadToNotion } from './briefs.js';
import { buildScriptPdf } from './pdf.js';
import { claude, costOf, PRICES } from './claude.js';
import { buildMime, threadSubject } from './mime.js';

export const OUTBOX_DS = '12116e41-602e-431f-9907-3154545889ab';
const SMART = process.env.PM_MODEL_SMART || 'claude-sonnet-5';
export const STAGES = ['Inbound', 'Negotiating', 'Price Agreed', 'Signed', 'Brief Received', 'Script Sent', 'Script Approved', 'In Production', 'Submitted', 'Approved', 'Posted', 'Invoiced', 'Paid'];
export const stageBefore = (stage, target) => { const a = STAGES.indexOf(stage || 'Inbound'); const b = STAGES.indexOf(target); return a === -1 || a < b; };
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
const rtLong = (s) => { const out = []; const t = String(s || ''); for (let i = 0; i < t.length && out.length < 90; i += 1900) out.push({ type: 'text', text: { content: t.slice(i, i + 1900) } }); return out; };
const addDays = (n) => new Date(Date.now() + 5.5 * 36e5 + n * 864e5).toISOString().slice(0, 10);
const pageIdFromUrl = (u) => (String(u || '').match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1] || null;
const appUrl = () => process.env.PM_PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '');

// ---------- writing emails ----------
// Emails sign off as the creator's team, never with a person's name: "Best,\nLindsay's Team"
const possessive = (n) => `${n}'s`;
export const teamSign = (creator) => `Best,\n${creator ? possessive(String(creator).trim()) + ' Team' : 'The Team'}`;
// Whatever sign-off the AI wrote, the email ends with exactly one team signature
export function withSignature(body, sig) {
  let lines = String(body || '').replace(/\s+$/, '').split('\n');
  const from = Math.max(0, lines.length - 6);
  let k = -1; // the last sign-off line ("Best,") near the end
  for (let i = lines.length - 1; i >= from; i--) if (/^\s*(best|thanks|thank you|cheers|regards|kind regards|warm regards|warmly|sincerely|all the best)\s*,?\s*$/i.test(lines[i])) { k = i; break; }
  if (k >= 0) lines = lines.slice(0, k);
  while (lines.length > 1 && /^\s*(harsh|noocap media|[\w .'’|-]{0,40}\bteam( \| noocap media)?)?\s*$/i.test(lines[lines.length - 1])) lines.pop();
  return `${lines.join('\n').replace(/\s+$/, '')}\n\n${sig}`;
}
const EMAIL_TOOL = {
  name: 'email',
  description: 'The email to send',
  input_schema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string', description: 'Plain text body including greeting and the signature' } }, required: ['subject', 'body'] },
};
const PURPOSE = {
  'Script': 'Send the script for the brand to review and approve. The script PDF is attached. Ask them to approve or share feedback.',
  'Follow-up': 'Politely follow up because the brand has not replied. Keep it short and make the next step easy.',
  'Posted links': 'Share that the video is live and give the posted link(s).',
  'Invoice': 'Send the creator\'s invoice (attached) for the completed deal and state the amount and payment due date if known.',
  'Payment chase': 'Politely remind the brand that the invoice is unpaid, mention when it was sent and the amount, and ask for a payment date.',
  'Draft video': 'Share the edited video with the brand for review. Give the Frame.io link, say which round it is if it is a revised cut, and ask for their approval or feedback.',
  'Reply': 'Reply to the brand\'s latest message (facts.their_latest_message) and nothing else. Answer what they asked us; if they asked us to send something we do not have in the facts, say we will send it over. If something needs Harsh\'s decision, keep it neutral and say we will confirm shortly. Never echo back points the brand said are still undecided on their side, and never ask them for details they did not offer.',
  'Quote': 'First reply to a brand about a collaboration. Say we are interested in working with them, give our rate for facts.deliverables at exactly facts.price_usd, and say briefly what it includes (facts.includes, if given). Invite them to go ahead. Only mention the deliverables in facts.deliverables: do not pitch bundles, dedicated videos or other packages, and do not offer a discount.',
  'Counter': 'The brand offered less than our rate. Thank them and say we can do facts.price_usd for facts.deliverables. Keep it warm and short, and do not hint at going lower. If facts.first_reply is true, also say we are interested in working with them and what the rate includes (facts.includes).',
  'Close deal': 'The price is agreed at facts.price_usd. Say that works, ask them to share the brief, and say we are adding noocapcollab@gmail.com (our team) to this thread, who will handle the rest from here.',
  'Rate hold': 'The brand offered far below our rate (facts.their_offer_usd). Thank them and say plainly that our rate for facts.deliverables is facts.price_usd: if that works we can proceed, otherwise we will have to pass on this collaboration. Friendly, two or three sentences, no negotiation.',
  'Decline': 'Politely decline the collaboration because the budget does not work for us. Thank them, keep the door open for the future, two or three sentences. Do not mention any price.',
  'Lead follow-up': 'The brand has gone quiet. First read facts.conversation: the latest email in the thread, with the earlier messages quoted under it. Write the natural next message from our side that picks up exactly where the conversation stopped and makes it easy for them to reply. Greet them by first name (facts.contact_name, or the name the brand signed with in the conversation; just "Hi," if there is none). Refer to what was actually discussed (their product, the platforms, anything they asked or we promised). Do not restate a price they have already been given; only if facts.lock_in_this_week is true, offer facts.price_usd (down from facts.usual_price_usd) if they can confirm this week. Never mention any other number, and if facts.mention_no_price is true do not mention any price or amount at all, even one from the conversation. If the brand\'s last message offered a budget far below our rate or said they have no budget, do not negotiate: say kindly that our rate stands and we would be glad to go ahead if it works for them. End with the signature only, with no extra sign-off line before it. If facts.nudge_number is 2, keep it to one or two short sentences. If facts.nudge_number is 3, it is the last check-in: one or two short sentences that close the loop kindly (for example, that we will assume the timing is not right for now and they can reply whenever it is), without any pressure. Two to four sentences otherwise, warm and human, never pushy, and never invent details that are not in the conversation.',
  'Other': 'Write the email described.',
};

let lastWriteCost = 0;
let costColumn = false;
export async function writeEmail({ kind, deal, facts = {}, instructions = '', signature }) {
  const out = await claude({
    model: SMART,
    max_tokens: 900,
    system: `You write short, warm, professional emails from NOOCAP Media (an agency that makes sponsored videos for creators) to brand partners. Rules: sound like a real person, no filler, no hype. Never stack three parallel items for rhythm, never use "it's not X, it's Y" contrasts, and never write chains of short choppy fragments; write flowing sentences joined with and, but, so, because. Do not invent facts, dates, amounts or links that are not given. Today is ${new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)}. For a reply, answer only what the brand asks in their latest message in one or two short paragraphs, and do not repeat dates, payments or events from earlier in the thread. Never sign with a person's name. End with this signature exactly:\n${signature || teamSign(deal?.creator)}`,
    tools: [EMAIL_TOOL],
    tool_choice: { type: 'tool', name: 'email' },
    messages: [{ role: 'user', content: `Purpose: ${PURPOSE[kind] || PURPOSE.Other}\n${instructions ? 'Extra instructions: ' + instructions + '\n' : ''}\nDeal: ${deal.brand} × ${deal.creator || 'creator'} (stage ${deal.stage || '?'})\nFacts: ${JSON.stringify(facts)}` }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  const cost = costOf(out.usage, /haiku/i.test(SMART) ? PRICES.haiku : PRICES.sonnet);
  lastWriteCost += cost; // picked up by the next createDraft, so each draft carries what it cost to write
  const mail = { ...(call?.input || { subject: `${deal.brand} × ${deal.creator}`, body: '' }), cost };
  if (mail.body) mail.body = withSignature(mail.body, signature || teamSign(deal?.creator));
  return mail;
}

// ---------- drafts ----------
export async function pendingDraft(dealId, kind) {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, {
    page_size: 1,
    filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Kind', select: { equals: kind } }, { property: 'Deal', relation: { contains: dealId } }] },
  });
  return (res.results || [])[0] || null;
}

const OUR_DOMAINS = String(process.env.CREATOR_DOMAINS || 'buildroom.ai:Duncan,chriscordero.net:Chris,valchy.ai:Valeri,automateaiconsulting.com:Lindsay').split(',').map((p) => p.split(':')[0].trim().toLowerCase()).filter(Boolean);
export const oursAddr = (a) => { const d = (String(a).toLowerCase().split('@')[1] || ''); return /^noocapcollab@/i.test(a) || OUR_DOMAINS.some((x) => d === x || d.endsWith('.' + x)); };
// Cc without the person in To, without our own sending inbox, and without repeats
function cleanCc(cc, to, sendFrom) {
  const toSet = new Set((String(to).match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map((a) => a.toLowerCase()));
  const own = /chris/i.test(sendFrom || '') ? /chriscordero\.net$/i : /^noocapcollab@/i;
  const seen = new Set();
  return (String(cc).match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).filter((a) => { const k = a.toLowerCase(); if (toSet.has(k) || own.test(k) || seen.has(k)) return false; seen.add(k); return true; }).join(', ');
}

export async function createDraft({ kind, deal, subject, body, to, cc, attach = 'None', video, why, notify = true, sendFrom, leadId, context, files }) {
  if (leadId) {
    // One live draft per lead: a newer situation replaces the older draft
    const old = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 10, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Lead', relation: { contains: leadId } }] } }).catch(() => ({ results: [] }));
    for (const o of old.results || []) await notion('PATCH', `/pages/${o.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
  } else if (deal?.id) {
    const existing = await pendingDraft(deal.id, kind);
    if (existing) return { skipped: true, reason: 'A draft of this kind is already waiting', id: existing.id };
  }
  // Replies stay in the brand's thread: Gmail needs the same subject for that
  const inThread = deal?.threadSubject && (deal?.threadId || deal?.messageRfc);
  // Never address a brand email to our own side (noocapcollab or a creator's own team): use the brand address
  // from the thread's Cc instead, and if there is none, leave To empty so it can't send until someone fills it in
  const addrs = (v) => String(v || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
  let toAddr = to || deal?.brandEmail || '';
  if (addrs(toAddr).length && addrs(toAddr).every(oursAddr)) {
    const brandCc = addrs(cc || deal?.threadCc || '').find((a) => !oursAddr(a));
    if (brandCc) { cc = [toAddr, cc || deal?.threadCc || ''].join(', '); toAddr = brandCc; }
    else { why = `⚠️ No brand address on this deal, add one in To before sending · ${why || ''}`; toAddr = ''; }
  }
  const finalSubject = inThread ? 'Re: ' + threadSubject(deal.threadSubject) : (subject || `${deal?.brand || ''} × ${deal?.creator || ''}`);
  const props = {
    Subject: { title: rt(finalSubject) },
    Status: { select: { name: 'Draft' } },
    Kind: { select: { name: kind } },
    To: { rich_text: rt(toAddr) },
    Cc: { rich_text: rt(cleanCc(cc || deal?.threadCc || '', toAddr, sendFrom)) },
    Body: { rich_text: rtLong(body) },
    Attach: { select: { name: attach } },
    Why: { rich_text: rt(why || '') },
    'Reply To Message ID': { rich_text: rt(deal?.messageRfc || '') },
    'Gmail Thread ID': { rich_text: rt(deal?.threadId || '') },
  };
  if (deal?.id && !leadId) props.Deal = { relation: [{ id: deal.id }] };
  if (leadId) props.Lead = { relation: [{ id: leadId }] };
  props['Send From'] = { select: { name: sendFrom || 'noocapcollab' } };
  if (deal?.creator) props.Creator = { select: { name: deal.creator } };
  if (video) props.Video = { url: video };
  if (!costColumn) { costColumn = true; await notion('PATCH', `/data_sources/${OUTBOX_DS}`, { properties: { 'Cost USD': { number: {} }, Context: { rich_text: {} }, 'Brand Files': { files: {} } } }).catch(() => {}); }
  if (context) props.Context = { rich_text: rtLong(String(context).slice(0, 4000)) };
  // Files the brand attached to the email this draft answers (a contract, a brief, an invoice): saved on the draft so
  // they can be downloaded from Approvals. Names without data still show, with a link to open the thread in Gmail.
  const brandFiles = await saveBrandFiles(files);
  if (brandFiles.uploaded.length) props['Brand Files'] = { files: brandFiles.uploaded };
  if (brandFiles.names.length) props.Context = { rich_text: rtLong((context ? String(context).slice(0, 3600) + '\n\n' : '') + 'Attached: ' + brandFiles.names.join(', ')) };
  if (lastWriteCost) { props['Cost USD'] = { number: Math.round(lastWriteCost * 10000) / 10000 }; lastWriteCost = 0; }
  const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: OUTBOX_DS }, properties: props });
  if (notify) {
    const link = appUrl() ? `\n→ [Review in Approvals](${appUrl()}/#approvals)` : '';
    await discord(`📬 **${deal?.brand || '?'} × ${deal?.creator || '?'} · ${kind.toLowerCase()} email to approve**${why ? '\n• ' + String(why).slice(0, 160) : ''}${to || deal?.brandEmail ? '' : '\n• ⚠️ no brand email on the deal'}${link}`, 'pm');
  }
  return { created: true, id: page.id };
}

// Inline images in signatures (logos, icons) are skipped; real documents and media are kept, up to 4 files of 20 MB
async function saveBrandFiles(files) {
  const out = { uploaded: [], names: [] };
  const real = (files || []).filter((a) => a && (a.filename || a.data) && !(/^image\//i.test(a.mimeType || '') && /^(image\d*|outlook|logo|icon|signature)/i.test(a.filename || '') && Number(a.size || 0) < 60000));
  for (const a of real.slice(0, 4)) {
    out.names.push(a.filename || 'file');
    if (!a.data || Buffer.byteLength(String(a.data), 'base64') > 20e6) continue;
    const id = await uploadToNotion(a);
    if (id) out.uploaded.push({ type: 'file_upload', file_upload: { id }, name: String(a.filename || 'file').slice(0, 100) });
  }
  return out;
}

export async function readDraftById(id) { return readDraft(await notion('GET', `/pages/${id}`)); }

function readDraft(p) {
  const g = (n) => plain(p.properties?.[n]);
  const rel = p.properties?.Deal?.relation || [];
  return {
    id: p.id, url: p.url, subject: g('Subject') || '', status: g('Status'), kind: g('Kind'), to: g('To') || '', cc: g('Cc') || '',
    body: (p.properties?.Body?.rich_text || []).map((t) => t.plain_text).join(''), attach: g('Attach') || 'None', why: g('Why') || '',
    creator: g('Creator'), video: g('Video'), replyTo: g('Reply To Message ID') || '', threadId: g('Gmail Thread ID') || '',
    dealId: rel[0]?.id || null, created: p.created_time, error: g('Error') || '',
    leadId: (p.properties?.Lead?.relation || [])[0]?.id || null, sendFrom: g('Send From') || 'noocapcollab',
    context: (p.properties?.Context?.rich_text || []).map((t) => t.plain_text).join(''),
    // Notion hands out a fresh download link (valid for an hour) on every read
    files: (p.properties?.['Brand Files']?.files || []).map((f) => ({ name: f.name, url: f.file?.url || f.external?.url || '' })).filter((f) => f.url),
    gmail: gmailLink(g('Gmail Thread ID'), g('Send From')),
  };
}

// Opens the thread in the right Gmail account (the one the draft sends from)
function gmailLink(threadId, sendFrom) {
  if (!threadId) return '';
  const box = /chris/i.test(sendFrom || '') ? (process.env.CHRIS_INBOX || 'collab@chriscordero.net') : (process.env.NOOCAP_INBOX || 'noocapcollab@gmail.com');
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(box)}#all/${threadId}`;
}

// Keep the header (From/Date) and the newest message, drop the quoted history under it
function latestOnly(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l, i) => i > 3 && /^\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From:\s.+|>)/i.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim().slice(0, 3000);
}

export async function listDrafts() {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, {
    page_size: 50,
    filter: { or: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Status', select: { equals: 'Failed' } }] },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });
  const drafts = (res.results || []).filter((p) => !p.in_trash).map(readDraft);
  // add brand names for display
  for (const d of drafts) {
    if (d.leadId) {
      try {
        const lp = await notion('GET', `/pages/${d.leadId}`); d.brand = plain(lp.properties?.Brand); d.dealUrl = lp.url;
        // The message this draft answers: the latest email in the thread (stored on the lead), else the lead's summary
        if (!d.context) {
          const thread = (lp.properties?.['Thread Text']?.rich_text || []).map((t) => t.plain_text).join('');
          d.context = thread ? latestOnly(thread) : plain(lp.properties?.Offer) ? 'Summary of the thread: ' + plain(lp.properties?.Offer) : '';
        }
      } catch { d.brand = 'Brand'; }
      continue;
    }
    if (!d.dealId) { d.brand = (d.why.match(/^(.+?) asked:/) || [])[1] || (d.to.split('@')[1] || '').split('.')[0] || 'Brand'; continue; }
    try { const dp = await notion('GET', `/pages/${d.dealId}`); d.brand = plain(dp.properties?.['Brand Name']); d.dealUrl = dp.url; } catch { /* ignore */ }
  }
  return drafts;
}

export async function saveDraft(id, { subject, body, to, cc }) {
  const props = {};
  if (subject !== undefined) props.Subject = { title: rt(subject) };
  if (body !== undefined) props.Body = { rich_text: rtLong(body) };
  if (to !== undefined) props.To = { rich_text: rt(to) };
  if (cc !== undefined) props.Cc = { rich_text: rt(cc) };
  if (Object.keys(props).length) await notion('PATCH', `/pages/${id}`, { properties: props });
}

export async function rejectDraft(id) {
  await notion('PATCH', `/pages/${id}`, { properties: { Status: { select: { name: 'Rejected' } } } });
  // Rejecting a follow-up to a lead means "stop chasing this one": otherwise the next run would draft it again.
  // A reply from the brand still reopens the conversation as normal.
  try {
    const d = readDraft(await notion('GET', `/pages/${id}`));
    if (d.kind === 'Lead follow-up' && d.leadId) {
      await notion('PATCH', `/pages/${d.leadId}`, { properties: { 'Follow-ups': { number: 3 }, 'Next Step': { rich_text: rt('Follow-ups stopped: Harsh rejected the follow-up') } } });
    }
  } catch { /* the draft is rejected either way */ }
}

async function invoiceAttachment(dealPage) {
  const files = dealPage.properties?.['Invoice File']?.files || [];
  const f = files[0];
  if (!f) throw new Error('The deal has no Invoice File to attach.');
  const url = f.file?.url || f.external?.url;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the invoice file from Notion.');
  const buf = Buffer.from(await res.arrayBuffer());
  return { filename: f.name || 'Invoice.pdf', mimeType: res.headers.get('content-type') || 'application/pdf', data: buf.toString('base64') };
}

const toHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');

// The lead's stored thread (latest email with the earlier ones quoted under it) as a reply quote block
function quoteThread(leadPage) {
  const t = (leadPage?.properties?.['Thread Text']?.rich_text || []).map((x) => x.plain_text || x.text?.content || '').join('');
  const m = t.match(/^From:\s*(.*)\nDate:\s*(.*)\n\n([\s\S]*)$/);
  if (!m || !m[3].trim()) return null;
  const [, from, date, body] = m;
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = `On ${date.trim() || 'an earlier date'}, ${from.trim() || 'the brand'} wrote:`;
  const quoted = body.trim().split('\n').map((l) => '> ' + l).join('\n');
  const linked = body.trim().split(/(https?:\/\/[^\s<>"]+)/g).map((part, i) => (i % 2 ? `<a href="${esc(part)}">${esc(part)}</a>` : esc(part))).join('').replace(/\n/g, '<br>');
  return {
    text: `\n\n${head}\n${quoted}\n`,
    html: `<br><div class="gmail_quote"><div>${esc(head)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${linked}</blockquote></div>`,
  };
}

// Approve = send through n8n, then update the deal
export async function approveAndSend(id, edits = {}) {
  await saveDraft(id, edits);
  const page = await notion('GET', `/pages/${id}`);
  const d = readDraft(page);
  if (d.status !== 'Draft' && d.status !== 'Failed') throw new Error(`This email is already ${d.status}.`);
  if (!/@/.test(d.to)) throw new Error('Add the brand\'s email address in To before sending.');
  if ((d.to.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).every(oursAddr)) throw new Error('To is our own team\'s address, not the brand. Put the brand\'s email in To before sending.');
  // Gmail rejects the whole email ("Bad request") if one address is broken, so name the bad one instead
  const bad = [['To', d.to], ['Cc', d.cc]].flatMap(([f, v]) => String(v || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)
    .filter((a) => !/^(?:[^<>@]*<)?[^<>@\s]+@[^<>@\s]+\.[a-z]{2,}>?$/i.test(a)).map((a) => `${f}: ${a}`));
  if (bad.length) throw new Error(`This address looks broken, fix it and send again (${bad.join(' · ')})`);
  const chris = d.sendFrom === 'Chris';
  const hook = chris ? process.env.N8N_SEND_WEBHOOK_CHRIS : process.env.N8N_SEND_WEBHOOK;
  if (!hook) throw new Error(chris ? 'N8N_SEND_WEBHOOK_CHRIS is not set in Vercel (the send workflow for Chris\'s inbox).' : 'N8N_SEND_WEBHOOK is not set in Vercel.');
  const dealPage = d.dealId ? await notion('GET', `/pages/${d.dealId}`) : null;
  const deal = dealPage ? { id: dealPage.id, brand: plain(dealPage.properties?.['Brand Name']), creator: plain(dealPage.properties?.Creator), stage: plain(dealPage.properties?.['Deal Stage']), followUps: Number(plain(dealPage.properties?.['Follow-ups Sent']) || 0), invoiceDue: plain(dealPage.properties?.['Invoice Due Date']) } : null;

  let attachment = null;
  if (d.attach === 'Script PDF') {
    const vid = pageIdFromUrl(d.video);
    if (!vid) throw new Error('No video page is linked to attach the script from.');
    attachment = await buildScriptPdf({ pageId: vid, brand: deal?.brand, creator: deal?.creator });
  } else if (d.attach === 'Invoice') {
    attachment = await invoiceAttachment(dealPage);
  }

  // Old deals may hold a Message-ID in Thread ID; only a Gmail thread id (hex) can be passed as threadId
  const gmailThread = /^[0-9a-f]{10,}$/i.test(d.threadId) ? d.threadId : '';
  const inReplyTo = d.replyTo || (/@/.test(d.threadId) ? d.threadId : '');
  // Chris's replies carry the earlier thread underneath, like a normal Gmail reply, so anyone copied in
  // (noocapcollab) sees the brand's brief and links even when they were sent before we joined the thread
  let text = d.body, html = toHtml(d.body);
  if (chris && d.leadId) {
    try {
      const q = quoteThread(await notion('GET', `/pages/${d.leadId}`));
      if (q) { text += q.text; html += q.html; }
    } catch { /* send without the quote rather than fail */ }
  }
  const raw = buildMime({ to: d.to, cc: d.cc, subject: d.subject, text, html, inReplyTo, attachment });
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hook-secret': process.env.PM_HOOK_SECRET || '' },
    // lookup = the brand message we reply to; n8n uses it to find the Gmail thread when we don't know the thread id yet
    body: JSON.stringify({ raw, ...(gmailThread ? { threadId: gmailThread } : {}), ...(inReplyTo ? { lookup: inReplyTo } : {}) }),
  });
  let result = {};
  try { result = await res.json(); } catch { /* n8n may return empty */ }
  if (!res.ok || result.ok === false) {
    const err = result.error || `n8n returned ${res.status}`;
    await notion('PATCH', `/pages/${id}`, { properties: { Status: { select: { name: 'Failed' } }, Error: { rich_text: rt(err) } } });
    throw new Error(err);
  }
  await notion('PATCH', `/pages/${id}`, { properties: { Status: { select: { name: 'Sent' } }, 'Sent At': { date: { start: new Date().toISOString() } }, Error: { rich_text: [] } } });

  if (d.leadId) {
    try { const { afterLeadSend } = await import('./leads.js'); await afterLeadSend(d); } catch (e) { console.error('lead update after send failed', e.message); }
  }
  if (deal) {
    const schema = await schemaOf(DS.deals);
    const p = {};
    setIf(schema, p, 'Last Our Reply', todayIST());
    if (result.threadId) setIf(schema, p, 'Thread ID', result.threadId);
    switch (d.kind) {
      case 'Script':
        if (stageBefore(deal.stage, 'Script Sent')) setIf(schema, p, 'Deal Stage', 'Script Sent');
        setIf(schema, p, 'Script Sent Date', todayIST());
        setIf(schema, p, 'Follow-ups Sent', 0);
        setIf(schema, p, 'Next Action', 'Waiting for the brand to approve the script');
        setIf(schema, p, 'Next Action Date', addDays(3));
        break;
      case 'Follow-up':
      case 'Payment chase':
        setIf(schema, p, 'Follow-ups Sent', deal.followUps + 1);
        setIf(schema, p, 'Next Action Date', addDays(d.kind === 'Payment chase' ? 7 : 3));
        break;
      case 'Draft video':
        if (stageBefore(deal.stage, 'Submitted')) setIf(schema, p, 'Deal Stage', 'Submitted');
        setIf(schema, p, 'Delivered Date', todayIST());
        setIf(schema, p, 'Follow-ups Sent', 0);
        setIf(schema, p, 'Next Action', 'Waiting for the brand to review the video');
        setIf(schema, p, 'Next Action Date', addDays(3));
        break;
      case 'Posted links':
        if (stageBefore(deal.stage, 'Posted')) setIf(schema, p, 'Deal Stage', 'Posted');
        setIf(schema, p, 'Links Sent Date', todayIST());
        setIf(schema, p, 'Next Action', 'Send the invoice');
        break;
      case 'Invoice':
        if (stageBefore(deal.stage, 'Invoiced')) setIf(schema, p, 'Deal Stage', 'Invoiced');
        setIf(schema, p, 'Invoice Sent Date', todayIST());
        if (!deal.invoiceDue) setIf(schema, p, 'Invoice Due Date', addDays(14));
        setIf(schema, p, 'Follow-ups Sent', 0);
        setIf(schema, p, 'Next Action', 'Waiting for payment');
        setIf(schema, p, 'Next Action Date', addDays(7));
        try { const { markRevenueInvoiced } = await import('./inbox.js'); await markRevenueInvoiced(deal, { amount: deal.invoiceAmount || deal.finalRate }); } catch { /* revenue row can be ticked by hand */ }
        break;
      default:
        break;
    }
    await notion('PATCH', `/pages/${deal.id}`, { properties: p });
  }
  clearCache();
  return { sent: true, kind: d.kind, to: d.to, subject: d.subject, attachment: attachment?.filename || null };
}
