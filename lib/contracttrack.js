// Contract tracking (Harsh, Nov 14). Every contract a brand sends, in noocapcollab or a creator's own inbox, becomes a
// row in CONTRACTS with the file on it and stays "Needs signing" until the signed copy goes back to the brand.
// Before this the PM only forwarded contracts to WhatsApp, which failed whenever the chat had been quiet for 24 hours,
// and it never looked for contracts in the creators' own inboxes: CapCut x Lindsay (Nov 12) and Panda Security x Chris
// (Nov 4) sat unsigned with nobody aware. The PM never signs, fills in or sends a contract on its own.
import { notion, plain } from './notion.js';

export const CONTRACTS_DS = process.env.CONTRACTS_DS || '6bbb0178-b0ee-4f07-a899-d52bf7df3c79';
export const OPEN = ['Needs signing', 'Sent to creator'];
export const OURS = /noocapcollab@|chriscordero\.net|automateaiconsulting\.com|buildroom\.ai|ninjaaitools\.com|noocap/i;
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
const day = (d = Date.now()) => new Date(new Date(d).getTime() + 5.5 * 36e5).toISOString().slice(0, 10); // India date
export const ageDays = (iso, now = Date.now()) => Math.floor((now - Date.parse(iso)) / 864e5);

// A copy the brand sends back already signed by both sides ("fully executed", "countersigned", "for your records") is
// the end of the contract, never a new one to sign
const FULLY_SIGNED = /\b(fully[\s-]+(executed|signed)|counter-?signed|countersignature|signed by both|executed (copy|agreement|contract)|for your records)\b/i;
export const isFullySigned = (text, files = []) => FULLY_SIGNED.test(String(text || '')) || (files || []).some((f) => /executed|countersigned|fully.?signed|signed.by.both/i.test(f.filename || ''));

// Our side sending the signed copy back: a contract-like file, or a file named "signed", or "signed contract attached"
export function signedCopyIn(email) {
  // A forward inside the team ("Fwd: Paid campaign with Panda Security") carries the unsigned contract, not a signed one
  if (/^\s*(fwd?|fw)\s*:/i.test(String(email.subject || ''))) return false;
  const to = `${email.to || ''}, ${email.cc || ''}`;
  if (to.replace(/[,\s]/g, '') && !to.split(/[,;]/).some((a) => /@/.test(a) && !OURS.test(a))) return false; // only our own addresses: not back to the brand
  const files = (email.attachments || []).filter((a) => /pdf|msword|wordprocessing/i.test(a.mimeType || '') || /\.(pdf|docx?)$/i.test(a.filename || ''));
  if (!files.length) return false;
  const text = String(email.text || '').slice(0, 3000);
  return files.some((a) => /signed|executed|contract|agreement|\bsow\b|addendum/i.test(a.filename || '')) || /\b(signed|executed)\b[^.\n]{0,40}\b(contract|agreement|copy|document)\b|\b(contract|agreement)\b[^.\n]{0,40}\bsigned\b/i.test(text);
}

const domainBrand = (from) => {
  const d = (String(from || '').match(/@([\w.-]+)/) || [])[1] || '';
  const base = d.split('.').slice(-2, -1)[0] || d;
  return base ? base.replace(/^./, (c) => c.toUpperCase()) : 'A brand';
};

async function findRows(filter) {
  const r = await notion('POST', `/data_sources/${CONTRACTS_DS}/query`, { page_size: 20, filter }).catch(() => ({ results: [] }));
  return (r.results || []).filter((p) => !p.in_trash);
}
const readRow = (p) => {
  const g = (k) => plain(p.properties?.[k]);
  return { id: p.id, url: p.url, title: g('Contract'), status: g('Status'), brand: g('Brand'), creator: g('Creator'), from: g('From'), received: g('Received'), signed: g('Signed'), threadId: g('Thread ID'), messageId: g('Message ID'), deadline: g('Brand Deadline'), lastReminder: g('Last Reminder'), inbox: g('Inbox'), dealIds: (p.properties?.Deal?.relation || []).map((x) => x.id), signLink: g('Sign Link'), docLink: g('Doc Link') };
};

// Post to #pm-alerts with the file itself attached (Discord webhooks take files as multipart); falls back to text
export async function discordWithFile(content, file) {
  const hook = process.env.DISCORD_PM_WEBHOOK;
  if (!hook) return false;
  try {
    if (file?.data) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content: content.slice(0, 1990), flags: 4, allowed_mentions: { parse: [] } }));
      form.append('files[0]', new Blob([Buffer.from(file.data, 'base64')], { type: file.mimeType || 'application/pdf' }), file.filename || 'contract.pdf');
      const r = await fetch(hook, { method: 'POST', body: form });
      if (r.ok) return true;
    }
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 1990), flags: 4, allowed_mentions: { parse: [] } }) });
    return r.ok;
  } catch (e) { console.error('contract discord', e.message); return false; }
}

// Save one contract. Same email twice, or a second copy in a thread that already has an open row: the row is updated,
// not duplicated. A fully signed copy coming back closes the open row instead. Returns { id, created } or null.
export async function recordContract({ email, contract, deal = null, brand, creator, inbox = 'noocapcollab', alert = true }) {
  const c = contract || {};
  const files = (c.files || []).filter((f) => f?.data);
  const at = email.date && !isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : new Date().toISOString();
  const mid = String(email.messageId || '').slice(0, 1900);
  if (mid && (await findRows({ property: 'Message ID', rich_text: { equals: mid } })).length) return { created: false, why: 'already saved' };
  const open = email.threadId ? (await findRows({ and: [{ property: 'Thread ID', rich_text: { equals: String(email.threadId) } }, { or: OPEN.map((s) => ({ property: 'Status', select: { equals: s } })) }] })).map(readRow) : [];
  if (isFullySigned(email.text, files)) {
    for (const r of open) await markRowSigned(r, at, 'The brand sent back the fully signed copy');
    return { created: false, why: 'fully signed copy' };
  }
  const { uploadToNotion } = await import('./briefs.js');
  const uploads = [];
  for (const f of files.slice(0, 3)) { const id = await uploadToNotion(f).catch(() => null); if (id) uploads.push({ type: 'file_upload', file_upload: { id }, name: (f.filename || 'contract.pdf').slice(0, 90) }); }
  const who = `${brand || deal?.brand || domainBrand(email.from)} × ${creator || deal?.creator || '?'}`;
  const signLink = (c.links || [])[0] || null;
  const docLink = (c.openLinks || c.docLinks || [])[0] || null;
  if (open.length) {
    const r = open[0];
    const props = { 'Message ID': { rich_text: rt(mid) }, Received: { date: { start: at } }, Notes: { rich_text: rt(`Updated copy received ${at.slice(0, 10)} from ${email.from || '?'}`) } };
    if (uploads.length) props.File = { files: uploads };
    if (signLink) props['Sign Link'] = { url: signLink };
    if (docLink) props['Doc Link'] = { url: docLink };
    await notion('PATCH', `/pages/${r.id}`, { properties: props });
    if (alert) await discordWithFile(`📄 **Updated contract: ${who}**\n• ${String(email.from || '').replace(/<.*>/, '').trim()} sent a new version${email.subject ? ` · "${String(email.subject).slice(0, 80)}"` : ''}\n• Still needs signing. The PM never signs: read it and sign it yourself.\n→ [Open in CONTRACTS](${r.url})`, files[0]);
    return { id: r.id, created: false, updated: true };
  }
  const props = {
    Contract: { title: rt(who) },
    Status: { select: { name: 'Needs signing' } },
    Brand: { rich_text: rt(brand || deal?.brand || domainBrand(email.from)) },
    From: { rich_text: rt(email.from || '') },
    Received: { date: { start: at } },
    Inbox: { select: { name: inbox } },
    'Thread ID': { rich_text: rt(email.threadId || '') },
    'Message ID': { rich_text: rt(mid) },
    Subject: { rich_text: rt(email.subject || '') },
  };
  const cr = creator || deal?.creator;
  if (cr) props.Creator = { select: { name: cr } };
  if (deal?.id) props.Deal = { relation: [{ id: deal.id }] };
  if (uploads.length) props.File = { files: uploads };
  if (signLink) props['Sign Link'] = { url: signLink };
  if (docLink) props['Doc Link'] = { url: docLink };
  if (deal?.deadline) props['Brand Deadline'] = { date: { start: String(deal.deadline).slice(0, 10) } };
  const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: CONTRACTS_DS }, properties: props });
  if (alert) {
    const lines = [
      `📄 **Contract to sign: ${who}**`,
      `• From ${String(email.from || '?').replace(/<.*>/, '').replace(/"/g, '').trim()}${email.subject ? ` · "${String(email.subject).slice(0, 80)}"` : ''} (${inbox})`,
      signLink ? `• Sign link: ${signLink}` : null,
      !files.length && docLink ? `• Contract link (not shared publicly, open it in the email): ${docLink}` : null,
      `• Saved in CONTRACTS until the signed copy goes back to the brand. The PM never signs: read it and sign it yourself.`,
      `→ [Open in CONTRACTS](${page.url})`,
    ].filter(Boolean);
    await discordWithFile(lines.join('\n'), files[0]);
  }
  return { id: page.id, created: true, url: page.url };
}

async function markRowSigned(r, at, note) {
  await notion('PATCH', `/pages/${r.id}`, { properties: { Status: { select: { name: 'Signed & returned' } }, Signed: { date: { start: String(at || new Date().toISOString()).slice(0, 10) } }, Notes: { rich_text: rt(note) } } }).catch(() => {});
}

// The signed copy went back to the brand: close the open contract for that thread (or, failing that, that deal)
export async function markSigned({ threadId, dealId, at, how = 'Signed copy sent back to the brand' }) {
  let rows = [];
  if (threadId) rows = (await findRows({ and: [{ property: 'Thread ID', rich_text: { equals: String(threadId) } }, { or: OPEN.map((s) => ({ property: 'Status', select: { equals: s } })) }] })).map(readRow);
  if (!rows.length && dealId) rows = (await findRows({ and: [{ property: 'Deal', relation: { contains: dealId } }, { or: OPEN.map((s) => ({ property: 'Status', select: { equals: s } })) }] })).map(readRow);
  for (const r of rows) await markRowSigned(r, at, how);
  return rows.map((r) => r.title);
}

export async function openContracts() {
  return (await findRows({ or: OPEN.map((s) => ({ property: 'Status', select: { equals: s } })) })).map(readRow).sort((a, b) => String(a.received).localeCompare(String(b.received)));
}

// Lines for the morning brief: one per unsigned contract, oldest first
export function briefLines(rows, now = Date.now()) {
  return rows.map((r) => {
    const age = r.received ? ageDays(r.received, now) : null;
    return `${r.title}${age != null ? ` · waiting ${age === 0 ? 'since today' : `${age} day${age === 1 ? '' : 's'}`}` : ''}${r.status === 'Sent to creator' ? ' · with the creator' : ''}${r.deadline ? ` · brand deadline ${r.deadline}` : ''}`;
  });
}

// A contract still unsigned after 2 days gets its own alert, once (then the morning brief keeps it in view)
export async function staleContractAlerts(now = Date.now()) {
  const out = [];
  for (const r of await openContracts()) {
    if (!r.received || ageDays(r.received, now) < 2 || r.lastReminder) continue;
    await discordWithFile(`⏰ **Contract still unsigned: ${r.title}**\n• Received ${r.received.slice(0, 10)} (${ageDays(r.received, now)} days ago)${r.deadline ? ` · brand deadline ${r.deadline}` : ''}\n• Sign it and send it back in the brand's thread, or drop the signed PDF in the NOOCAP MEDIA chat and the PM sends it.\n→ [Open in CONTRACTS](${r.url})`);
    await notion('PATCH', `/pages/${r.id}`, { properties: { 'Last Reminder': { date: { start: day(now) } } } }).catch(() => {});
    out.push(r.title);
  }
  return out;
}

// The weekly sweep: emails that n8n (Gmail) or the IMAP mailbox found with contract files or sign links in the last 30
// days. Anything not already in CONTRACTS is added and flagged; a thread whose later email from us carries the signed
// copy is added as already signed, so the list never shows contracts that were handled by hand.
export async function sweepEmail(email, { inbox = 'Weekly sweep', creator } = {}) {
  const I = await import('./inbox.js');
  const ours = OURS.test(String(email.from || ''));
  if (ours) {
    if (signedCopyIn(email)) return { signed: await markSigned({ threadId: email.threadId, at: email.date }) };
    return { skipped: 'ours' };
  }
  const c = await I.resolveContract(email);
  if (!c) return { skipped: 'no contract' };
  const { openDeals } = await import('./briefs.js');
  const deals = await openDeals().catch(() => []);
  const deal = deals.find((d) => email.threadId && d.threadId === email.threadId) || null;
  return recordContract({ email, contract: c, deal, brand: deal?.brand, creator: deal?.creator || creator, inbox });
}
