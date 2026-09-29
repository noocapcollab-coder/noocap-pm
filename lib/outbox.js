// PM OUTBOX: every email to a brand is a draft first. Harsh approves in the PM app, then n8n sends it from noocapcollab.
import { notion, plain, clearCache } from './notion.js';
import { DS, todayIST } from './tools.js';
import { schemaOf } from './actions.js';
import { setIf, discord } from './briefs.js';
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
const SIGNATURE = () => (process.env.PM_EMAIL_SIGNATURE || 'Best,\nHarsh\nNOOCAP Media').replace(/\\n/g, '\n');
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
  'Reply': 'Reply to the brand\'s latest message helpfully. If something needs Harsh\'s decision, keep it neutral and say we will confirm shortly.',
  'Other': 'Write the email described.',
};

export async function writeEmail({ kind, deal, facts = {}, instructions = '' }) {
  const out = await claude({
    model: SMART,
    max_tokens: 900,
    system: `You write short, warm, professional emails from NOOCAP Media (an agency that makes sponsored videos for creators) to brand partners. Rules: sound like a real person, no filler, no hype. Never stack three parallel items for rhythm, never use "it's not X, it's Y" contrasts, and never write chains of short choppy fragments; write flowing sentences joined with and, but, so, because. Do not invent facts, dates, amounts or links that are not given. End with this signature exactly:\n${SIGNATURE()}`,
    tools: [EMAIL_TOOL],
    tool_choice: { type: 'tool', name: 'email' },
    messages: [{ role: 'user', content: `Purpose: ${PURPOSE[kind] || PURPOSE.Other}\n${instructions ? 'Extra instructions: ' + instructions + '\n' : ''}\nDeal: ${deal.brand} × ${deal.creator || 'creator'} (stage ${deal.stage || '?'})\nFacts: ${JSON.stringify(facts)}` }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  return { ...(call?.input || { subject: `${deal.brand} × ${deal.creator}`, body: '' }), cost: costOf(out.usage, PRICES.sonnet) };
}

// ---------- drafts ----------
export async function pendingDraft(dealId, kind) {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, {
    page_size: 1,
    filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Kind', select: { equals: kind } }, { property: 'Deal', relation: { contains: dealId } }] },
  });
  return (res.results || [])[0] || null;
}

export async function createDraft({ kind, deal, subject, body, to, cc, attach = 'None', video, why, notify = true }) {
  if (deal?.id) {
    const existing = await pendingDraft(deal.id, kind);
    if (existing) return { skipped: true, reason: 'A draft of this kind is already waiting', id: existing.id };
  }
  // Replies stay in the brand's thread: Gmail needs the same subject for that
  const inThread = deal?.threadSubject && (deal?.threadId || deal?.messageRfc);
  const finalSubject = inThread ? 'Re: ' + threadSubject(deal.threadSubject) : (subject || `${deal?.brand || ''} × ${deal?.creator || ''}`);
  const props = {
    Subject: { title: rt(finalSubject) },
    Status: { select: { name: 'Draft' } },
    Kind: { select: { name: kind } },
    To: { rich_text: rt(to || deal?.brandEmail || '') },
    Cc: { rich_text: rt(cc || deal?.threadCc || '') },
    Body: { rich_text: rtLong(body) },
    Attach: { select: { name: attach } },
    Why: { rich_text: rt(why || '') },
    'Reply To Message ID': { rich_text: rt(deal?.messageRfc || '') },
    'Gmail Thread ID': { rich_text: rt(deal?.threadId || '') },
  };
  if (deal?.id) props.Deal = { relation: [{ id: deal.id }] };
  if (deal?.creator) props.Creator = { select: { name: deal.creator } };
  if (video) props.Video = { url: video };
  const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: OUTBOX_DS }, properties: props });
  if (notify) {
    const link = appUrl() ? `\n→ [Review in Approvals](${appUrl()}/#approvals)` : '';
    await discord(`📬 **${deal?.brand || '?'} × ${deal?.creator || '?'} · ${kind.toLowerCase()} email to approve**${why ? '\n• ' + String(why).slice(0, 160) : ''}${to || deal?.brandEmail ? '' : '\n• ⚠️ no brand email on the deal'}${link}`, 'pm');
  }
  return { created: true, id: page.id };
}

function readDraft(p) {
  const g = (n) => plain(p.properties?.[n]);
  const rel = p.properties?.Deal?.relation || [];
  return {
    id: p.id, url: p.url, subject: g('Subject') || '', status: g('Status'), kind: g('Kind'), to: g('To') || '', cc: g('Cc') || '',
    body: (p.properties?.Body?.rich_text || []).map((t) => t.plain_text).join(''), attach: g('Attach') || 'None', why: g('Why') || '',
    creator: g('Creator'), video: g('Video'), replyTo: g('Reply To Message ID') || '', threadId: g('Gmail Thread ID') || '',
    dealId: rel[0]?.id || null, created: p.created_time, error: g('Error') || '',
  };
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

// Approve = send through n8n, then update the deal
export async function approveAndSend(id, edits = {}) {
  await saveDraft(id, edits);
  const page = await notion('GET', `/pages/${id}`);
  const d = readDraft(page);
  if (d.status !== 'Draft' && d.status !== 'Failed') throw new Error(`This email is already ${d.status}.`);
  if (!/@/.test(d.to)) throw new Error('Add the brand\'s email address in To before sending.');
  const hook = process.env.N8N_SEND_WEBHOOK;
  if (!hook) throw new Error('N8N_SEND_WEBHOOK is not set in Vercel.');
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
  const raw = buildMime({ to: d.to, cc: d.cc, subject: d.subject, text: d.body, html: toHtml(d.body), inReplyTo, attachment });
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
