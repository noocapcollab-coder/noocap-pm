// WhatsApp webhook · GET (Meta's one-time check) and POST (messages and button taps from Harsh / Pratham)
// Meta > WhatsApp > Configuration > Webhook: Callback URL https://<your app>/api/whatsapp, Verify token = WA_VERIFY_TOKEN,
// then subscribe to the "messages" field.
import {
  waOn, personByNumber, loadState, saveState, sendText, sendButtons, sendDigest, markRead, validSignature,
  draftCard, draftButtons, windowOpen,
} from '../lib/whatsapp.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) return [Buffer.from(req.rawBody)];
  const chunks = [];
  try { for await (const c of req) chunks.push(Buffer.from(c)); } catch { /* already read */ }
  if (chunks.length) return [Buffer.concat(chunks)];
  // The platform parsed the body already: rebuild it the way Meta writes JSON (non-ASCII as \uXXXX, slashes escaped)
  const b = req.body;
  if (typeof b === 'string') return [Buffer.from(b)];
  if (b && typeof b === 'object') {
    const plainJson = JSON.stringify(b);
    const ascii = plainJson.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    return [Buffer.from(plainJson), Buffer.from(ascii), Buffer.from(ascii.replace(/\//g, '\\/'))];
  }
  return [Buffer.alloc(0)];
}

async function logProblem(event, details) {
  try {
    const { log } = await import('../lib/briefs.js');
    await log({ event, outcome: 'Error', email: { messageId: '' }, details, area: 'System' });
  } catch { /* ignore */ }
}

// Keep working after answering Meta (it wants a fast 200), using Vercel's waitUntil when available
async function later(fn) {
  if (!process.env.VERCEL) return true;
  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(fn());
    return false;
  } catch {
    return true; // run inline
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) return res.status(200).send(String(q['hub.challenge'] || ''));
    if ('check' in q) return res.status(200).json({ configured: waOn(), people: (process.env.WA_NUMBERS || '').split(',').filter(Boolean).length, secret: !!process.env.WA_APP_SECRET });
    return res.status(403).send('Forbidden');
  }
  if (req.method !== 'POST') return res.status(405).end();

  const candidates = await rawBody(req);
  const raw = candidates.find((c) => c.length && validSignature(c, req.headers['x-hub-signature-256']));
  if (!raw) {
    const empty = !candidates.some((c) => c.length);
    console.error('WhatsApp webhook:', empty ? 'empty body' : 'bad signature');
    await logProblem(`WhatsApp webhook rejected (${empty ? 'empty body' : 'signature did not match'})`, 'Check WA_APP_SECRET in Vercel matches the App Secret in Meta (App settings > Basic).');
    return res.status(empty ? 200 : 401).end();
  }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(200).end(); }

  const incoming = [];
  for (const e of payload.entry || []) for (const ch of e.changes || []) for (const m of ch.value?.messages || []) incoming.push(m);
  if (!incoming.length) return res.status(200).end(); // delivery / read receipts

  const work = async () => { for (const m of incoming) { try { await handleMessage(m); } catch (err) { console.error('WhatsApp message failed', err.message); } } };
  const inline = await later(work);
  if (inline) await work();
  return res.status(200).end();
}

const say = async (st, text) => { await sendText(st.person.number, text); st.messages.push({ role: 'assistant', content: text, meta: 'wa', at: new Date().toISOString() }); };

async function handleMessage(m) {
  const person = personByNumber(m.from);
  if (!person) { console.log('WhatsApp: ignored message from unknown number', m.from); return; }
  const st = await loadState(person);
  if (st.messages.some((x) => x.wa === m.id)) return; // Meta retried a message we already have
  const at = new Date(Number(m.timestamp || Date.now() / 1000) * 1000).toISOString();

  // What they sent: a typed message, a reply-button tap, or the template's "Show me"
  let text = '', button = '';
  if (m.type === 'text') text = m.text?.body || '';
  else if (m.type === 'interactive') button = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '';
  else if (m.type === 'button') button = m.button?.payload || 'DIGEST';
  else text = `(sent a ${m.type})`;
  const label = button ? `[tapped ${m.interactive?.button_reply?.title || m.button?.text || button}]` : text;
  st.messages.push({ role: 'user', content: label, wa: m.id, at, ...(button ? { meta: 'button' } : {}) });
  await saveState(st); // saved first, so a retry from Meta is recognised
  markRead(m.id).catch(() => {});

  try {
    if (button) await onButton(st, button);
    else await onText(st, text);
  } catch (e) {
    await say(st, `⚠️ ${String(e.message || e).slice(0, 300)}`).catch(() => {});
  }
  await saveState(st);
}

async function onButton(st, id) {
  const [action, arg] = String(id).split(':');
  if (action === 'DIGEST' || action === 'digest') { await sendDigest(st); return; }
  if (action === 'send') {
    const { approveAndSend, readDraftById } = await import('../lib/outbox.js');
    const { withRun } = await import('../lib/runs.js');
    const d = await readDraftById(arg);
    await withRun('Send', `Send: ${d.subject || arg}`, () => approveAndSend(arg), { trigger: 'WhatsApp', summarize: () => ({ did: [`Sent to ${d.to || 'brand'} from WhatsApp`] }) });
    await say(st, `✅ Sent to ${d.to}${d.subject ? ` · "${d.subject}"` : ''}`);
    return;
  }
  if (action === 'reject') {
    const { rejectDraft } = await import('../lib/outbox.js');
    await rejectDraft(arg);
    await say(st, '✖️ Rejected. Nothing was sent.');
    return;
  }
  if (action === 'full') {
    const { readDraftById } = await import('../lib/outbox.js');
    const d = await readDraftById(arg);
    if (d.status !== 'Draft') { await say(st, `This email is already ${String(d.status || 'gone').toLowerCase()}.`); return; }
    await sendText(st.person.number, `*${d.subject}*\nTo: ${d.to}${d.cc ? '\nCc: ' + d.cc : ''}${d.attach && d.attach !== 'None' ? '\n📎 ' + d.attach : ''}\n\n${d.body}`);
    await sendButtons(st.person.number, 'Send this one?', draftButtons(arg).filter((b) => !b.id.startsWith('full:')));
    st.messages.push({ role: 'assistant', content: `(full email shown: ${d.subject})\n${d.body}`.slice(0, 1500), meta: 'draft', at: new Date().toISOString() });
    return;
  }
  if (action === 'yes' || action === 'no') { await resolvePending(st, action === 'yes'); return; }
  await say(st, "I didn't recognise that button. Ask me in a message instead.");
}

// Confirm or cancel the latest change the PM proposed (tokens live on the saved message, never in the button)
async function resolvePending(st, confirm) {
  const msg = [...st.messages].reverse().find((x) => x.role === 'assistant' && Array.isArray(x.pending) && x.pending.length && !x.resolved);
  if (!msg) { await say(st, 'There is no change waiting for a yes.'); return; }
  const { ask } = await import('../lib/ask.js');
  const r = await ask({ channel: 'whatsapp', save: false, chatId: st.chatId, messages: [], ...(confirm ? { confirm: msg.pending[0].token } : { cancel: true }) });
  msg.resolved = confirm ? 'confirmed' : 'cancelled';
  await say(st, r.data.reply || r.data.error || 'Done.');
}

async function onText(st, text) {
  const t = text.trim();
  if (/^(show me|pending|what'?s pending|digest|inbox|approvals?)\??$/i.test(t)) { await sendDigest(st); return; }
  if (/^(yes|y|confirm|go ahead|do it)\.?!?$/i.test(t) && st.messages.some((x) => x.role === 'assistant' && x.pending?.length && !x.resolved)) { await resolvePending(st, true); return; }
  if (/^(no|cancel|stop|don'?t)\.?!?$/i.test(t) && st.messages.some((x) => x.role === 'assistant' && x.pending?.length && !x.resolved)) { await resolvePending(st, false); return; }

  // A question or instruction: the same brain as the dashboard chat, with this chat's recent history
  const history = st.messages
    .filter((x) => !['morning', 'nudge'].includes(x.meta) && x.content)
    .slice(-14)
    .map((x) => ({ role: x.role, content: x.content }));
  const { ask } = await import('../lib/ask.js');
  const r = await ask({ channel: 'whatsapp', save: false, chatId: st.chatId, messages: history });
  const reply = r.data.reply || `⚠️ ${r.data.error || 'Something went wrong, try again.'}`;
  const pending = r.data.pending || [];
  if (pending.length) {
    await sendText(st.person.number, reply);
    await sendButtons(st.person.number, `Make this change?\n${pending.map((p) => '• ' + p.summary).join('\n')}`, [{ id: 'yes', title: '✅ Yes, do it' }, { id: 'no', title: '✖️ Cancel' }]);
  } else {
    await sendText(st.person.number, reply);
  }
  st.messages.push({ role: 'assistant', content: reply, meta: r.data.meta || 'wa', at: new Date().toISOString(), ...(pending.length ? { pending } : {}) });
}
