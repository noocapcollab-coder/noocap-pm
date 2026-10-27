// Creator inboxes that are NOT Gmail (Lindsay's collab@automateaiconsulting.com on PrivateEmail / Namecheap).
// The PM reads them over IMAP and sends from them over SMTP itself, so no n8n Gmail workflow is needed.
//
// Vercel env per creator (password goes straight into Vercel, never into chat):
//   LINDSAY_EMAIL_USER = collab@automateaiconsulting.com
//   LINDSAY_EMAIL_PASS = the mailbox password
//   LINDSAY_EMAIL_HOST = mail.privateemail.com   (optional, this is the default)
//
// Reading: every poll looks at the last 7 days of INBOX and Sent, skips anything already tagged PMseen, hands each
// email to the same lead flow Chris's inbox uses (handleLeadEmail), then tags it PMseen so it is never read twice.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

const CREATORS = ['Lindsay'];
const SEEN = 'PMseen';
const PER_POLL = 4; // AI reads take a few seconds each; the next poll picks up the rest

function account(creator) {
  const k = String(creator || '').toUpperCase();
  const user = String(process.env[`${k}_EMAIL_USER`] || '').trim();
  const pass = process.env[`${k}_EMAIL_PASS`];
  if (!user || !pass) return null;
  return { creator, user, pass, host: String(process.env[`${k}_EMAIL_HOST`] || 'mail.privateemail.com').trim() };
}
export const mailboxCreators = () => CREATORS.filter((c) => account(c));
export const hasMailbox = (creator) => !!account(creator);
// The From line for an email sent from the creator's inbox (LINDSAY_EMAIL_NAME sets the name shown, optional)
export const mailboxFrom = (creator) => { const a = account(creator); if (!a) return null; const name = String(process.env[`${String(creator).toUpperCase()}_EMAIL_NAME`] || '').replace(/["<>]/g, '').trim(); return name ? `"${name}" <${a.user}>` : a.user; };

// A thread that belongs to another creator ("[PAID] (valeridoesai)X(tripo)", or only Valeri's address on it besides
// ours) is not this creator's lead, even when the same agency copies both inboxes
const CREATOR_NAMES = [...new Set(String(process.env.CREATOR_DOMAINS || 'buildroom.ai:Duncan,chriscordero.net:Chris,valchy.ai:Valeri,automateaiconsulting.com:Lindsay').split(',').map((p) => (p.split(':')[1] || '').trim()).filter(Boolean))];
function otherCreatorThread(email, creator) {
  const s = String(email.subject || '').toLowerCase();
  const named = CREATOR_NAMES.filter((c) => new RegExp(`(^|[^a-z])${c.toLowerCase()}`).test(s));
  if (named.length === 1 && named[0].toLowerCase() !== String(creator).toLowerCase()) return named[0];
  return null;
}

const imap = (a) => new ImapFlow({ host: a.host, port: 993, secure: true, auth: { user: a.user, pass: a.pass }, logger: false, socketTimeout: 20000 });
const addr = (x) => (x?.value || []).map((v) => (v.name ? `${v.name} <${v.address}>` : v.address)).join(', ');
const firstId = (refs) => (Array.isArray(refs) ? refs[0] : String(refs || '').trim().split(/\s+/)[0]) || null;

// One email in the shape the lead flow expects (the same fields n8n sends for Chris's Gmail)
function toEmail(parsed, creator, sent) {
  const messageId = parsed.messageId || null;
  // The thread is named after its first message: the root of References, else the message it replies to, else itself
  const threadId = firstId(parsed.references) || parsed.inReplyTo || messageId;
  return {
    creator, sent,
    messageId, threadId,
    from: addr(parsed.from), to: addr(parsed.to), cc: addr(parsed.cc),
    subject: parsed.subject || '', date: (parsed.date || new Date()).toISOString(),
    text: parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, ' '),
    html: typeof parsed.html === 'string' ? parsed.html.slice(0, 200000) : '',
    attachments: (parsed.attachments || []).filter((a) => a.content && a.size < 8e6 && !a.related).slice(0, 5)
      .map((a) => ({ filename: a.filename || 'file', mimeType: a.contentType || 'application/octet-stream', data: a.content.toString('base64') })),
  };
}

async function sentFolder(client) {
  const list = await client.list().catch(() => []);
  const hit = list.find((m) => m.specialUse === '\\Sent') || list.find((m) => /^(sent|sent items|sent messages)$/i.test(m.name));
  return hit ? hit.path : null;
}

// Poll every configured creator inbox. Returns what was handled.
export async function pollMailboxes({ handle, limit = PER_POLL } = {}) {
  const out = [];
  for (const creator of CREATORS) {
    const a = account(creator);
    if (!a) continue;
    const client = imap(a);
    try {
      await client.connect();
      const since = new Date(Date.now() - 7 * 864e5); // a week, so nothing is missed after a pause
      const folders = [['INBOX', false]];
      const sent = await sentFolder(client);
      if (sent) folders.push([sent, true]);
      let left = limit;
      for (const [path, isSent] of folders) {
        if (left <= 0) break;
        const lock = await client.getMailboxLock(path);
        try {
          const uids = (await client.search({ since, unKeyword: SEEN }, { uid: true })) || [];
          for (const uid of uids.slice(-left)) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg?.source) continue;
            const email = toEmail(await simpleParser(msg.source), creator, isSent);
            let r;
            const other = otherCreatorThread(email, creator);
            if (/noocapcollab@/i.test(email.from)) r = { action: 'skipped', why: 'sent from noocapcollab, the main inbox already handles it' };
            else if (other) r = { action: 'skipped', why: `${other}'s thread, ${creator}'s inbox was only copied` };
            else try { r = await handle(email); } catch (e) { r = { action: 'error', error: String(e.message || e).slice(0, 200) }; }
            // Errors stay unseen so the next poll retries them (the lead flow gives up after 3 tries on its own)
            if (r?.action !== 'error') await client.messageFlagsAdd(String(uid), [SEEN], { uid: true }).catch(() => {});
            out.push({ creator, folder: path, subject: email.subject, ...r });
            left -= 1;
          }
        } finally { lock.release(); }
      }
    } catch (e) {
      out.push({ creator, action: 'error', error: `${creator}'s inbox: ${String(e.message || e).slice(0, 160)}` });
    } finally {
      await client.logout().catch(() => {});
    }
  }
  return out;
}

// Send a ready MIME message from the creator's own inbox, and file a copy in their Sent folder
export async function sendFromMailbox(creator, { raw, to, cc }) {
  // buildMime returns Gmail's base64url form; SMTP and IMAP want the plain message
  if (!/^[\w-]+:/m.test(String(raw).slice(0, 200))) raw = Buffer.from(String(raw), 'base64url').toString('utf8');
  const a = account(creator);
  if (!a) throw new Error(`${String(creator).toUpperCase()}_EMAIL_USER and ${String(creator).toUpperCase()}_EMAIL_PASS are not set in Vercel (${creator}'s inbox).`);
  const list = (s) => (String(s || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || []);
  const rcpt = [...new Set([...list(to), ...list(cc)])];
  if (!rcpt.length) throw new Error('No recipients to send to.');
  const transport = nodemailer.createTransport({ host: a.host, port: 465, secure: true, auth: { user: a.user, pass: a.pass } });
  const info = await transport.sendMail({ envelope: { from: a.user, to: rcpt }, raw });
  try {
    const client = imap(a);
    await client.connect();
    const sent = await sentFolder(client);
    // Tagged PMseen: the PM sent it, so the next poll doesn't treat it as a reply written by hand
    if (sent) await client.append(sent, raw, ['\\Seen', SEEN]);
    await client.logout();
  } catch { /* the email went out; the Sent copy is a nice-to-have */ }
  return { ok: true, messageId: info.messageId };
}
