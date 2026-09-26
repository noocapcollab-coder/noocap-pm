// PM · Inbox brain. Every new noocapcollab email lands here (from n8n).
// Code filters obvious noise, Haiku reads the rest, then the right deal / video / outbox action happens.
import { notion, plain, clearCache, queryAll } from './notion.js';
import { BOARDS, DS, todayIST } from './tools.js';
import { schemaOf, findProp, CREATOR_KEY } from './actions.js';
import { claude, HAIKU, costOf } from './claude.js';
import { openDeals, readDocLink, alreadyHandled, fileBrief, uploadToNotion, setIf, discord, log, tag, LINK_RE, DOC_LINK } from './briefs.js';
import { createDraft, writeEmail, stageBefore } from './outbox.js';
import { threadSubject } from './mime.js';

const lc = (s) => String(s ?? '').toLowerCase().trim();
const ROSTER = BOARDS.map((b) => b.creator);
const pageIdFromUrl = (u) => (String(u || '').match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1] || null;
const domainOf = (s) => (String(s || '').match(/@([\w.-]+\.\w+)/) || [])[1]?.toLowerCase() || '';

const SIGNALS = /\b(brief|guideline|talking points?|script|approv|looks good|lgtm|feedback|changes?|revision|edit|invoice|payment|paid|wire|transfer|remit|rate|price|budget|fee|agreed|confirm|contract|deal|go[- ]live|posted|link|deliverable|draft|campaign|sponsor)/i;
const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|icloud|proton|protonmail|aol|live)\./;

export function gate(email, deals) {
  const from = lc(email.from);
  if (from.includes('noocapcollab')) return { ok: false, why: 'sent by us' };
  const text = `${email.subject || ''}\n${email.text || ''}`;
  const dom = domainOf(email.from);
  const knownBrand = dom && !FREE_MAIL.test(dom) && deals.some((d) => domainOf(d.brandEmail) === dom);
  if (knownBrand) return { ok: true };
  if (/unsubscribe|view in browser|newsletter/i.test(text) && !/brief|invoice|script/i.test(email.subject || '')) return { ok: false, why: 'newsletter' };
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
      event: { type: 'string', enum: EVENTS, description: `brief = brand sends/updates the content brief; price_agreed = brand confirms the rate/deal; script_approved = brand approves the script; script_changes = brand wants script changes; video_feedback = brand comments on or approves the edited video; invoice_from_creator = a creator (or their team) sends NOOCAP their invoice for a deal; payment_confirmed = brand says the invoice is paid; brand_reply = any other message from a brand about a deal; not_relevant = anything else` },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string' },
      from_role: { type: 'string', enum: ['brand', 'creator', 'noocap', 'other'] },
      brand: { type: 'string' },
      creator: { type: ['string', 'null'], enum: [...ROSTER, null] },
      deal_number: { type: ['integer', 'null'], description: 'Number of the matching open deal from the list, or null' },
      summary: { type: 'array', items: { type: 'string' }, description: 'Key points, max 6' },
      needs_reply: { type: 'boolean', description: 'True if the brand asked something that needs an answer from NOOCAP' },
      amount: { type: ['number', 'null'], description: 'Agreed rate or invoice amount if stated' },
      currency: { type: ['string', 'null'] },
      video_approved: { type: ['boolean', 'null'], description: 'For video_feedback: true if they approved the video' },
      feedback: { type: 'string', description: 'For script_changes / video_feedback: the exact requested changes' },
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
  const dealList = deals.map((d, i) => `${i + 1}. ${d.brand} | creator: ${d.creator || '?'} | stage: ${d.stage || '?'}${d.brandEmail ? ' | brand email: ' + d.brandEmail : ''}`).join('\n') || '(no open deals)';
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

Classify the latest message in this email (ignore quoted older replies unless needed for context) and record it. Match the deal by brand name, sender domain and creator; if nothing matches clearly, deal_number is null.`,
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
  const kids = lines.filter(Boolean).slice(0, 60).map((l) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: String(l).slice(0, 1900) } }] } }));
  await notion('PATCH', `/blocks/${id}/children`, { children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: label } }], children: kids.length ? kids : [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }] } }] });
}

async function createDealFor(x, email, board) {
  const schema = await schemaOf(DS.deals);
  const props = { 'Brand Name': { title: [{ type: 'text', text: { content: (x.brand || 'Unknown brand').slice(0, 200) } }] } };
  setIf(schema, props, 'Creator', board.creator);
  setIf(schema, props, 'Deal Source', 'Auto-captured');
  setIf(schema, props, 'Needs Check', true);
  setIf(schema, props, 'Brand Email', (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0]);
  setIf(schema, props, 'Thread ID', email.threadId);
  setIf(schema, props, 'Message ID', email.messageId);
  setIf(schema, props, 'Thread Subject', threadSubject(email.subject));
  const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.deals }, properties: props });
  return { id: page.id, url: page.url, brand: x.brand || 'Unknown brand', creator: board.creator, stage: null, agentNotes: '', followUps: 0, brandEmail: props['Brand Email']?.email || null, threadId: email.threadId, messageRfc: email.messageId, threadSubject: threadSubject(email.subject) };
}

const money = (n, c) => (n == null ? '' : `${c && c !== 'USD' ? c + ' ' : '$'}${Number(n).toLocaleString('en-US')}`);

export async function handleInboxEmail(email) {
  const deals = await openDeals();
  const g = gate(email, deals);
  if (!g.ok) return { action: 'skipped', why: g.why };
  if (await alreadyHandled(email.messageId)) return { action: 'skipped', why: 'already handled' };

  const allLinks = [...new Set(((email.text || '') + ' ' + (email.html || '')).match(LINK_RE) || [])].filter((u) => DOC_LINK.test(u));
  let docText = null;
  if (/brief/i.test(`${email.subject} ${email.text}`)) for (const u of allLinks.slice(0, 2)) { docText = await readDocLink(u); if (docText) break; }

  const { x, usage } = await readEmail(email, deals, docText);
  const cost = costOf(usage);

  if (x.event === 'not_relevant' || x.confidence === 'low') {
    await log({ event: `Skipped: ${email.subject || ''}`, outcome: 'Skipped', email, x, details: x.reason, usage, cost });
    return { action: 'skipped', why: 'AI: ' + x.reason };
  }

  if (x.event === 'brief') {
    x.is_brief = true;
    const r = await fileBrief({ email, x, deals, allLinks, docText, usage, cost });
    return { event: 'brief', ...r };
  }

  let deal = x.deal_number ? deals[x.deal_number - 1] : null;
  const creator = deal?.creator || x.creator;
  const board = creator ? BOARDS.find((b) => CREATOR_KEY(b.creator) === CREATOR_KEY(creator)) : null;
  if (!deal && x.event === 'price_agreed' && board) deal = await createDealFor(x, email, board);
  if (!deal) {
    const msg = `📨 **${x.event.replace(/_/g, ' ')}** email I couldn't match to a deal\n**${email.subject || '(no subject)'}** from ${email.from || '?'}\n${(x.summary || []).slice(0, 3).map((s) => '• ' + s).join('\n')}`;
    await discord(msg, 'pm');
    await log({ event: `Unmatched ${x.event}: ${email.subject || ''}`, outcome: 'Needs approval', email, x, details: msg, usage, cost, creator: board?.creator });
    return { action: 'needs_help', event: x.event, why: 'no matching deal' };
  }

  const fromBrand = x.from_role === 'brand';
  const common = (set) => {
    if (fromBrand) { set('Last Brand Reply', todayIST()); set('Follow-ups Sent', 0); }
    if (email.threadId && (fromBrand || !deal.threadId)) set('Thread ID', email.threadId);
    if (email.messageId && (fromBrand || !deal.messageRfc)) { set('Message ID', email.messageId); set('Thread Subject', threadSubject(email.subject)); }
    if (fromBrand && !deal.brandEmail) set('Brand Email', (String(email.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0]);
  };
  const points = (x.summary || []).slice(0, 4).map((s) => '• ' + s).join('\n');
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
      await discord(`💰 **Price agreed: ${who}** ${money(x.amount, x.currency)}\n${points}`, 'pm');
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
      await discord(`✅ **Brand approved the script: ${who}**${st ? `\nVideo moved to ${st}.` : ''}${deal.linkedVideo ? '\nVideo: ' + deal.linkedVideo : ''}\n${points}`, 'pm');
      did = `Deal Script Approved${st ? ', video ' + st : ''}`;
      break;
    }
    case 'script_changes': {
      await patchDeal(deal, (set) => { common(set); set('Next Action', 'Shreya revising the script'); });
      const st = deal.linkedVideo ? await setVideoStatus(deal.linkedVideo, 4) : null;
      if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the script ${todayIST()}`, [x.feedback, ...(x.summary || [])]);
      await discord(`${tag()} ✏️ **Script changes requested: ${who}**\n${x.feedback ? x.feedback.slice(0, 900) : points}${deal.linkedVideo ? '\nNotion: ' + deal.linkedVideo : ''}`);
      await discord(`✏️ Script changes requested for ${who}. Shreya has been tagged.`, 'pm');
      did = `Script changes sent to Shreya${st ? ', video back to ' + st : ''}`;
      break;
    }
    case 'video_feedback': {
      await patchDeal(deal, (set) => {
        common(set);
        if (x.video_approved && stageBefore(deal.stage, 'Approved')) set('Deal Stage', 'Approved');
        set('Next Action', x.video_approved ? 'Schedule and post the video' : 'Harsh to review the brand\'s video feedback');
      });
      if (deal.linkedVideo) await addNoteToVideo(deal.linkedVideo, `📋 Brand feedback on the video ${todayIST()}`, [x.feedback, ...(x.summary || [])]);
      await discord(`${x.video_approved ? '🎉 **Brand approved the video' : '🎬 **Brand feedback on the video'}: ${who}**\n${x.feedback ? x.feedback.slice(0, 900) : points}${deal.linkedVideo ? '\nVideo: ' + deal.linkedVideo : ''}`, 'pm');
      did = x.video_approved ? 'Deal marked Approved' : 'Feedback added to the video, Harsh notified';
      break;
    }
    case 'invoice_from_creator': {
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
      // mark the sponsor revenue row paid if it exists
      const vid = pageIdFromUrl(deal.linkedVideo);
      if (vid) {
        const rows = await queryAll(DS.revenue, undefined, { useCache: false });
        const row = rows.find((r) => pageIdFromUrl(plain(r.properties?.['Video Link'])) === vid);
        if (row) await notion('PATCH', `/pages/${row.id}`, { properties: { Paid: { checkbox: true }, 'Payment Received': { date: { start: todayIST() } } } });
      }
      await discord(`💸 **Paid: ${who}** ${money(x.amount || deal.invoiceAmount, x.currency)}\nRemember to collect the NOOCAP cut.`, 'pm');
      did = 'Deal marked Paid';
      break;
    }
    default: { // brand_reply
      await patchDeal(deal, (set) => common(set));
      if (x.needs_reply && fromBrand) {
        const mail = await writeEmail({ kind: 'Reply', deal, facts: { their_message: (x.summary || []).join(' | '), subject: email.subject } });
        await createDraft({ kind: 'Reply', deal, subject: mail.subject, body: mail.body, video: deal.linkedVideo, why: `${deal.brand} asked: ${(x.summary || [])[0] || email.subject}` });
        did = 'Reply drafted for approval';
      } else {
        await discord(`📩 **${deal.brand} replied** (${deal.creator || '?'})\n${points}`, 'pm');
        did = 'Harsh notified';
      }
    }
  }
  clearCache();
  await log({ event: `${x.event.replace(/_/g, ' ')}: ${who}`, outcome: 'Rule', email, x, deal, details: did, usage, cost, creator: deal.creator });
  return { action: 'handled', event: x.event, deal: deal.url, did };
}
