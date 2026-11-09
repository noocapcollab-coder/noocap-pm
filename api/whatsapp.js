// WhatsApp webhook · GET (Meta's one-time check) and POST (messages and button taps from Harsh / Pratham)
// Meta > WhatsApp > Configuration > Webhook: Callback URL https://<your app>/api/whatsapp, Verify token = WA_VERIFY_TOKEN,
// then subscribe to the "messages" field.
import {
  waOn, personByNumber, loadState, saveState, sendText, sendButtons, sendDigest, markRead, validSignature,
  draftCard, draftButtons, windowOpen, sentId, catchUp, flushPending,
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
  let text = '', button = '', file = null;
  if (m.type === 'text') text = m.text?.body || '';
  else if (m.type === 'interactive') button = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '';
  else if (m.type === 'button') button = m.button?.payload || 'DIGEST';
  else if (m.type === 'document' || m.type === 'image') {
    const f = m[m.type] || {};
    file = { mediaId: f.id, filename: f.filename || (m.type === 'image' ? 'image.jpg' : 'file'), mime: f.mime_type || '' };
    text = f.caption ? `${f.caption}\n(sent a file: ${file.filename})` : `(sent a file: ${file.filename})`;
    // A screenshot is read, so its words count like typed text: bank or PayPal details for an invoice, a brand's message,
    // an address (Harsh, Nov 5: "if I share a screenshot of the bank details, can you read it?"). The file still goes
    // with any email it is attached to.
    if (m.type === 'image') {
      try {
        const W = await import('../lib/whatsapp.js');
        const got = await W.downloadMedia(f.id);
        const { claude, HAIKU } = await import('../lib/claude.js');
        const r = await claude({ _job: 'whatsapp', model: HAIKU, max_tokens: 800, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: /^image\/(png|jpeg|gif|webp)$/.test(got.mimeType) ? got.mimeType : 'image/jpeg', data: got.data } },
          { type: 'text', text: 'Copy out all the text in this screenshot exactly as written (names, numbers, IBAN, account and routing numbers, emails, addresses), one item per line. No commentary.' },
        ] }] });
        const read = (r.content || []).map((c) => c.text || '').join('').trim();
        if (read) text = `${f.caption ? f.caption + '\n' : ''}(sent a screenshot; the text in it reads:)\n${read.slice(0, 3000)}`;
      } catch (e) { console.error('WhatsApp screenshot read', e.message); }
    }
  }
  else text = `(sent a ${m.type})`;
  const label = button ? `[tapped ${m.interactive?.button_reply?.title || m.button?.text || button}]` : text;
  // The chat had gone quiet for over 24 hours, so alerts in between could not be delivered: after answering,
  // send what they missed. Measured from the last thing we managed to send them.
  const wasClosed = !windowOpen(st);
  const lastSent = [...st.messages].reverse().find((x) => x.role === 'assistant' && x.at && x.meta !== 'pending-doc')?.at || null;
  st.messages.push({ role: 'user', content: label, wa: m.id, at, ...(button ? { meta: 'button' } : {}), ...(file ? { file } : {}) });
  await saveState(st); // saved first, so a retry from Meta is recognised
  markRead(m.id).catch(() => {});

  // A swipe-reply to one of our draft cards: whatever they typed is the change to make to that email
  const replyTo = m.context?.id ? st.messages.find((x) => x.wid && x.wid === m.context.id) : null;
  const quoted = replyTo?.draft ? replyTo : null;

  const forwarded = !!(m.context?.forwarded || m.context?.frequently_forwarded);
  try {
    if (button) await onButton(st, button);
    else if (quoted && file) { await attachFileToDraft(quoted.draft, file); await say(st, `📎 Attached *${file.filename}* to that email. It goes with it when you tap Send.`); if (text && !/^\(sent a file: /.test(text)) await applyEdit(st, quoted.draft, text.replace(/\n?\(sent a file: [^)]*\)$/, '').trim()); }
    else if (replyTo?.meta === 'reject-why' && text) await learnFromReject(st, replyTo, text);
    else if (quoted && text) await applyEdit(st, quoted.draft, text);
    else if (infoAskFor(st, replyTo, text) && (text || file)) await answerInfoAsk(st, infoAskFor(st, replyTo, text), text, file);
    else if (text && !quoted && [...st.messages].reverse().find((x) => x.role === 'assistant')?.meta !== 'edit-ask' && await maybeNewDeal(st, text, forwarded)) { /* handled */ }
    else if (file && /^\(sent a file: /.test(text)) await say(st, `📎 Got *${file.filename}*. Tell me what to do with it, e.g. "send this to Atoms × Lindsay" and I'll put the email with this file attached in the brand's thread for you to approve.`);
    else await onText(st, text, replyTo?.content || '');
  } catch (e) {
    await say(st, `⚠️ ${String(e.message || e).slice(0, 300)}`).catch(() => {});
  }
  if (wasClosed && lastSent && !(button === 'DIGEST' || /^(show me|pending|digest)/i.test(text.trim()))) {
    try { await catchUp(st, lastSent); } catch (e) { console.error('WhatsApp catch-up failed', e.message); }
  }
  // Contracts that arrived while the chat was closed or quiet come through now, file and all
  try { await flushPending(st); } catch (e) { console.error('WhatsApp pending contracts failed', e.message); }
  await saveState(st);
}

async function onButton(st, id) {
  const [action, arg] = String(id).split(':');
  if (action === 'DIGEST' || action === 'digest') { await sendDigest(st); return; }
  if (action === 'why') {
    const [code, draftId] = String(arg || '').split('|');
    const REASONS = { info: 'it had wrong or invented information (facts, dates, amounts, links that are not in the conversation)', person: 'it went to the wrong person or the wrong thread', none: 'the email was not needed (already answered, nothing to say, or not ours to send)' };
    await learnFromReject(st, { rejected: draftId, resolved: null }, REASONS[code] || code);
    return;
  }
  if (action === 'catchup') { const { catchUpList } = await import('../lib/whatsapp.js'); await catchUpList(st, new Date(Number(arg) || Date.now() - 864e5).toISOString()); return; }
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
    // One tap tells the PM what was wrong, so it learns without anyone typing (or swipe-reply with your own words)
    const r = await sendButtons(st.person.number, '✖️ Rejected. Nothing was sent.\nWhat was wrong? Tap one, or swipe-reply with your own words, and I won\'t make that mistake again.', [
      { id: `why:info|${arg}`, title: 'Wrong info' }, { id: `why:person|${arg}`, title: 'Wrong person/thread' }, { id: `why:none|${arg}`, title: 'Not needed' },
    ]);
    st.messages.push({ role: 'assistant', content: '✖️ Rejected. Nothing was sent.', meta: 'reject-why', rejected: arg, wid: sentId(r), at: new Date().toISOString() });
    return;
  }
  if (action === 'edit') {
    const { readDraftById } = await import('../lib/outbox.js');
    const d = await readDraftById(arg);
    if (d.status !== 'Draft') { await say(st, `This email is already ${String(d.status || 'gone').toLowerCase()}.`); return; }
    await sendText(st.person.number, `*${d.subject}*\nTo: ${d.to || '⚠️ no address yet'}${d.cc ? '\nCc: ' + d.cc : ''}\n\n${d.body}`);
    const ask = "✏️ What should change? Tell me in your own words (e.g. \"say the videos stay up for 30 days\") or paste the whole new email. Send *cancel* to leave it as it is.";
    await sendText(st.person.number, ask);
    // Saved on the chat itself (the webhook keeps no memory between messages), so the next message is read as the change
    st.messages.push({ role: 'assistant', content: ask, meta: 'edit-ask', draft: arg, at: new Date().toISOString() });
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
  if (action === 'dealok' || action === 'dealwa') { await fileNewDeal(st, 'WhatsApp'); return; }
  if (action === 'dealmail') { await fileNewDeal(st, 'Email'); return; }
  if (action === 'moreyes') { await addMoreVideos(st); return; }
  if (action === 'moreno') { const p = pendingMore(st); if (p) p.resolved = 'cancelled'; await say(st, 'OK, I didn\'t add anything.'); return; }
  if (action === 'noteson') { await sendScriptNotes(st); return; }
  if (action === 'notesno') { const p = pendingNotes(st); if (p) p.resolved = 'cancelled'; await say(st, 'OK, I didn\'t send it.'); return; }
  if (action === 'invpick') { const W = await import('../lib/wainvoice.js'); await W.pickInvoice(st, String(id).slice('invpick:'.length)); return; }
  if (action === 'invpage') { const W = await import('../lib/wainvoice.js'); await W.startInvoice(st, Number(arg) || 0); return; }
  if (action === 'invgo') { const W = await import('../lib/wainvoice.js'); await W.finishInvoice(st, arg); return; }
  if (action === 'dealwho') { await askWhose(st); return; }
  if (action === 'dealno') { const p = pendingDeal(st); if (p) p.resolved = 'cancelled'; await say(st, 'OK, I left it. Nothing was filed.'); return; }
  await say(st, "I didn't recognise that button. Ask me in a message instead.");
}

// Confirm or cancel the latest change the PM proposed (tokens live on the saved message, never in the button)
async function resolvePending(st, confirm) {
  const msg = [...st.messages].reverse().find((x) => x.role === 'assistant' && Array.isArray(x.pending) && x.pending.length && !x.resolved);
  if (!msg) { await say(st, 'There is no change waiting for a yes.'); return; }
  const { ask } = await import('../lib/ask.js');
  // Every change listed in the message, not just the first one
  const replies = [];
  if (confirm) { for (const pnd of msg.pending) { const r = await ask({ channel: 'whatsapp', save: false, chatId: st.chatId, messages: [], confirm: pnd.token }); replies.push(r.data.reply || r.data.error || 'Done.'); } }
  else { const r = await ask({ channel: 'whatsapp', save: false, chatId: st.chatId, messages: [], cancel: true }); replies.push(r.data.reply || r.data.error || 'Cancelled.'); }
  msg.resolved = confirm ? 'confirmed' : 'cancelled';
  await say(st, [...new Set(replies)].join('\n'));
}

async function onText(st, text, quotedText = '') {
  const t = text.trim();
  // Invoices in a few taps: "invoice" opens the pick-list, an open setup takes the answer to its question,
  // "uploaded <brand>" marks a platform invoice as sent
  {
    const W = await import('../lib/wainvoice.js');
    const pd = (await import('../lib/postdates.js')).parseDateCommand(t);
    if (pd) { const P = await import('../lib/postdates.js'); const r = await P.setDateFromChat(pd).catch((e) => ({ error: e.message })); await say(st, r.error ? `I couldn't set it: ${r.error}` : `✅ *${r.title}* (${r.creator}) now posts on ${r.day}${r.before ? ` (was ${r.before})` : ''}. It shows on the calendar now.`); return; }
    if (W.isInvoiceCommand(t)) { await W.startInvoice(st); return; }
    const q = W.quickInvoice(t);
    if (q) { await W.quickStart(st, q); return; }
    const up = W.uploadedCommand(t);
    if (up) { await W.markUploaded(st, up); return; }
    const inv = W.pendingInvoice(st);
    if (inv && inv.missing) { await W.answerInvoice(st, inv, t); return; }
  }
  // We asked whose new deal it is: a creator's name files it
  const p = pendingDeal(st);
  if (p && t.length < 40) {
    const { BOARDS } = await import('../lib/tools.js');
    const c = BOARDS.map((b) => b.creator).find((n) => n.toLowerCase().startsWith(t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4)) && t.length >= 3);
    if (c) {
      p.creator = c; p.whose = false; p.dealId = null;
      await sendButtons(st.person.number, `OK, *${p.brand} × ${c}*. Where is the brand handled?\n*WhatsApp* = ${c} deals with them, I never email the brand. *Email* = we run it from our inbox.`, [{ id: 'dealwa', title: '✅ File · WhatsApp' }, { id: 'dealmail', title: '📧 File · Email' }, { id: 'dealno', title: '✖️ Not a deal' }]);
      return;
    }
    if (/^(cancel|no|stop|leave it)\.?$/i.test(t)) { p.resolved = 'cancelled'; await say(st, 'OK, nothing was filed.'); return; }
  }
  // More videos waiting for a tap: a follow-up naming the creator or the total ("This Lindsay x Higgfield we have total
  // 4 video deals", sent right after the list) fills them in instead of starting something new
  const pm = pendingMore(st);
  if (pm && t.length < 200 && Date.now() - Date.parse(pm.at) < 30 * 6e4) {
    const { BOARDS } = await import('../lib/tools.js');
    const words = t.toLowerCase();
    const c = BOARDS.map((b) => b.creator).find((n) => new RegExp(`\\b${n.toLowerCase().split(' ')[0].slice(0, 5)}`).test(words));
    const W = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
    const cm = words.match(/\b(\d+|one|two|three|four|five|six|seven|eight)\s+(?:more\s+|new\s+)?(?:videos?|reels?)\b/);
    const total = cm ? Number(W[cm[1]] || cm[1]) : 0;
    if (/^(cancel|no|stop|leave it)\.?$/i.test(t)) { pm.resolved = 'cancelled'; await say(st, 'OK, I didn\'t add anything.'); return; }
    if (c || total) {
      if (c) pm.creator = c;
      if (total) pm.missing = Math.max(0, total - (pm.videos || []).length);
      await showMore(st, pm);
      return;
    }
  }
  // We asked whose script feedback it is (or the creator was wrong): a creator's name sets it
  const pn = pendingNotes(st);
  if (pn && t.length < 40) {
    const { BOARDS } = await import('../lib/tools.js');
    const c = BOARDS.map((b) => b.creator).find((n) => n.toLowerCase().startsWith(t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4)) && t.length >= 3);
    if (c) {
      pn.creator = c; pn.whose = false;
      await sendButtons(st.person.number, `OK, *${pn.brand} × ${c}*. Send the notes to Rudraksh?`, [{ id: 'noteson', title: '✏️ Send to Rudraksh' }, { id: 'notesno', title: '✖️ Don\'t send' }]);
      return;
    }
    if (/^(cancel|no|stop|leave it)\.?$/i.test(t)) { pn.resolved = 'cancelled'; await say(st, 'OK, I didn\'t send it.'); return; }
  }
  // Waiting for the change to a draft: our last message asked for it (after tapping Edit), within the hour
  const lastOurs = [...st.messages].reverse().find((x) => x.role === 'assistant' && x.meta !== 'pending-doc');
  if (lastOurs?.meta === 'edit-ask' && lastOurs.draft && Date.now() - Date.parse(lastOurs.at) < 36e5) {
    if (/^(cancel|stop|never ?mind|leave it)\.?$/i.test(t)) { await say(st, 'OK, the draft is unchanged.'); return; }
    await applyEdit(st, lastOurs.draft, t);
    return;
  }
  if (/^(show me|pending|what'?s pending|digest|inbox|approvals?)\??$/i.test(t)) { await sendDigest(st); return; }
  if (/^(yes|y|confirm|go ahead|do it)\.?!?$/i.test(t) && st.messages.some((x) => x.role === 'assistant' && x.pending?.length && !x.resolved)) { await resolvePending(st, true); return; }
  if (/^(no|cancel|stop|don'?t)\.?!?$/i.test(t) && st.messages.some((x) => x.role === 'assistant' && x.pending?.length && !x.resolved)) { await resolvePending(st, false); return; }

  // A change to the draft we were just talking about ("change 'confirm shortly' to 'that works'"): apply it to that
  // draft and show the new version with its buttons, instead of sending them off to Approvals
  const focus = await focusDraft(st, quotedText);
  // Only right after we were talking about a draft, and never for "send it" / "drop it" (those are the buttons' job)
  const lastA = [...st.messages].reverse().find((x) => x.role === 'assistant' && !['pending-doc', 'nudge', 'morning'].includes(x.meta));
  const aboutDraft = lastA && (lastA.draft || /\bdraft|approvals\b/i.test(lastA.content || ''));
  const verbOnly = /^(send|reject|drop|delete|cancel)( it| this| that)?\.?!?$/i.test(t);
  if (focus && aboutDraft && !verbOnly && t.length < 400 && !/https?:\/\//i.test(t) && EDIT_WORDS.test(t) && !/\?\s*$/.test(t) && !(await namesOtherBrand(t, focus))) { await applyEdit(st, focus, t); return; }

  // "Send this contract to Atoms × Lindsay" / "mail Atoms": a draft for that brand is already waiting, so show it
  // (with the file they just sent attached) instead of paying the AI to write the same email again
  if (/\b(send|mail|e-?mail|share|draft|forward|reply)\b/i.test(t) && !/\b(new|another|fresh|rewrite)\b/i.test(t)) {
    const { listDrafts } = await import('../lib/outbox.js');
    const hay = brandKey(`${t}\n${quotedText}`);
    const waiting = (await listDrafts()).filter((d) => d.status === 'Draft' && brandKey(d.brand).length >= 3 && hay.includes(brandKey(d.brand)));
    if (waiting.length) {
      const file = [...st.messages].reverse().find((x) => x.role === 'user' && x.file && Date.now() - Date.parse(x.at) < 6 * 36e5)?.file;
      if (file && waiting.length === 1 && /\b(this|it|contract|file|pdf|doc|attach)/i.test(t)) await attachFileToDraft(waiting[0].id, file);
      if (await showDrafts(st, `${t}\n${quotedText}`)) return;
    }
  }

  // "What's the email you drafted?": show the draft itself with its buttons, for the brand they named, the alert they
  // replied to, or the brand we were just talking about
  if (/\b(draft(ed)?|e-?mail|mail|reply|wrote|written)\b/i.test(t) && !/\b(draft|write|send|make|create)\s+(a|an|me|new)\b/i.test(t)) {
    if (await showDrafts(st, `${t}\n${quotedText}`)) return;
    // Falling back to the draft we were just on only for a plain "show me the mail" question, never for a long
    // message that merely contains the word "email" (a forwarded brief, an instruction)
    const askShow = t.length < 90 && /\b(show|see|what|where|which|read)\b/i.test(t) && /\b(draft(ed)?|e-?mail|mail|reply|wrote|written)\b/i.test(t);
    if (focus && askShow && await showDraftById(st, focus)) return;
  }

  // A question or instruction: the same brain as the dashboard chat, with this chat's recent history
  const history = st.messages
    .filter((x) => !['morning', 'nudge', 'pending-doc'].includes(x.meta) && x.content)
    .slice(-14)
    .map((x) => ({ role: x.role, content: x.content }));
  const { ask } = await import('../lib/ask.js');
  // The last file they sent (within 6 hours) can go out with an email: "send this contract to Atoms × Lindsay"
  const sentFile = [...st.messages].reverse().find((x) => x.role === 'user' && x.file && Date.now() - Date.parse(x.at) < 6 * 36e5)?.file || null;
  const r = await ask({ channel: 'whatsapp', save: false, chatId: st.chatId, messages: history, person: st.person.name, file: sentFile });
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

// Change a draft from WhatsApp: a short instruction is applied by the PM, a full pasted email replaces the body.
// The new version is saved in Approvals and shown again with Send / Edit / Reject, nothing goes out until Send.
// "Why did you reject it?" answered: the reason becomes a lesson the PM reads before the next similar email
async function learnFromReject(st, msg, why) {
  const { readDraftById } = await import('../lib/outbox.js');
  const d = await readDraftById(msg.rejected).catch(() => null);
  const L = await import('../lib/lessons.js');
  const r = await L.learn({ correction: `Harsh rejected this ${d?.kind || ''} email${d?.brand ? ` to ${d.brand}` : ''} because: ${why}\n\nThe rejected email:\n${String(d?.body || '').replace(/<br\s*\/?>/g, '\n').slice(0, 1500)}`, source: 'Draft rejected', example: `${d?.brand || ''} ${d?.kind || ''}: ${d?.subject || ''}`.trim() });
  msg.resolved = 'learned';
  await say(st, r?.added ? `📝 Got it, I'll remember: *${r.added}*` : r?.repeated ? `📝 Noted. That's a lesson I already had (*${r.repeated}*), now seen ${r.times} times, so I'm treating it as a priority.` : '📝 Noted.');
}

async function applyEdit(st, id, instruction) {
  const { readDraftById, saveDraft } = await import('../lib/outbox.js');
  const d = await readDraftById(id);
  if (d.status !== 'Draft') { await say(st, `That email is already ${String(d.status || 'gone').toLowerCase()}, so I left it.`); return; }
  const { claude, HAIKU } = await import('../lib/claude.js');
  const sys = [
    'You edit an email draft for a creator-management agency. You get the current draft and a message from a teammate.',
    'If the message is a complete email meant to replace the draft, return it cleaned up. Otherwise apply exactly what they asked, change nothing else, and keep the same greeting and sign-off.',
    'Never invent prices, dates, usage terms or commitments the teammate did not give. Keep the tone natural and plain, the way a person writes.',
    'Avoid stacking three parallel items for rhythm, avoid "it\'s not X, it\'s Y" phrasing, and avoid strings of short choppy fragments.',
    'Return only the email body, with no subject line and no commentary.',
  ].join(' ');
  const r = await claude({
    _job: 'whatsapp',
    model: HAIKU, max_tokens: 1500, system: sys,
    messages: [{ role: 'user', content: `CURRENT DRAFT:\n${d.body}\n\nTEAMMATE'S MESSAGE:\n${instruction}` }],
  });
  const body = (r.content || []).map((c) => c.text || '').join('').trim();
  if (!body) { await say(st, "⚠️ I couldn't rewrite that one. Try saying the change another way, or edit it in Approvals."); return; }
  await saveDraft(id, { body });
  // Harsh had to change it: what he asked for is a lesson for the next draft like this one
  try { const L = await import('../lib/lessons.js'); if (L.changedEnough(d.body, body)) await L.learn({ correction: `Harsh changed a ${d.kind || ''} email${d.brand ? ` to ${d.brand}` : ''} before sending. His instruction: "${instruction}".\nBefore:\n${String(d.body || '').replace(/<br\s*\/?>/g, '\n').slice(0, 1200)}\nAfter:\n${String(body).replace(/<br\s*\/?>/g, '\n').slice(0, 1200)}`, source: 'Draft edit', example: `${d.brand || ''} ${d.kind || ''}`.trim() }); } catch { /* learning is best-effort */ }
  try {
    const { log } = await import('../lib/briefs.js');
    await log({ event: `Draft edited on WhatsApp: ${d.subject || id}`, outcome: 'Rule', email: { messageId: '' }, details: `By ${st.person.name}: ${instruction}`.slice(0, 1800), area: 'System', source: 'WhatsApp' });
  } catch { /* the log is best-effort */ }
  const card = draftCard({ ...d, body });
  await sendText(st.person.number, `Updated ✏️\n\n${body}`);
  const sent = await sendButtons(st.person.number, `Send this version to ${d.to || '(no address yet)'}?`, draftButtons(id));
  st.messages.push({ role: 'assistant', content: card.slice(0, 1500), meta: 'draft', draft: id, wid: sentId(sent), at: new Date().toISOString() });
}

const EDIT_WORDS = /\b(change|replace|edit|rewrite|reword|remove|delete|drop|add|instead|make it|update|swap|say|mention|shorten|tweak|fix)\b/i;
// Brand names compare without "AI", "app", ".io" and the like: "higgsfield" finds the "Higgsfield.AI" draft
const brandKey = (x) => String(x || '').toLowerCase().replace(/\.(ai|io|app|co|com)\b/g, ' ').replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq|labs?|studio)\b/g, ' ').replace(/[^a-z0-9]/g, '');

// The draft this chat is about right now: one we just showed (within 2 hours), else the one whose brand came up in
// the last few messages. Only when exactly one draft fits, so a change never lands on the wrong email.
// "Runway x Chris: here are the ad codes" while another brand's draft is on screen is news for Runway, never an edit to
// that other draft. True when the message names a deal brand and the focused draft belongs to a different one.
export async function namesOtherBrand(text, draftId, { deals, drafts } = {}) {
  const hay = brandKey(text);
  if (!deals) { const { openDeals } = await import('../lib/briefs.js'); deals = await openDeals({ withClosed: true }).catch(() => []); }
  const named = [...new Set(deals.map((d) => d.brand).filter((b) => brandKey(b).length >= 3 && hay.includes(brandKey(b))))];
  if (!named.length) return false;
  if (!drafts) { const { listDrafts } = await import('../lib/outbox.js'); drafts = await listDrafts().catch(() => []); }
  const d = drafts.find((x) => x.id === draftId);
  if (!d?.brand) return true;
  return !named.some((b) => brandKey(b) === brandKey(d.brand));
}

async function focusDraft(st, quotedText = '') {
  const recent = st.messages.slice(-8).filter((x) => x.at && Date.now() - Date.parse(x.at) < 2 * 36e5);
  const shown = [...recent].reverse().find((x) => x.role === 'assistant' && x.draft);
  const { listDrafts } = await import('../lib/outbox.js');
  const drafts = (await listDrafts().catch(() => [])).filter((d) => d.status === 'Draft');
  if (shown && drafts.some((d) => d.id === shown.draft)) return shown.draft;
  const hay = brandKey(`${quotedText}\n${recent.map((x) => x.content || '').join('\n')}`);
  const hits = drafts.filter((d) => { const b = brandKey(d.brand); return b.length >= 3 && hay.includes(b); });
  return hits.length === 1 ? hits[0].id : null;
}

async function showDraftById(st, id) {
  const { readDraftById } = await import('../lib/outbox.js');
  const d = await readDraftById(id).catch(() => null);
  if (!d || d.status !== 'Draft') return false;
  if (!d.brand && d.dealId) { try { const { notion, plain } = await import('../lib/notion.js'); const p = await notion('GET', `/pages/${d.dealId}`); d.brand = plain(p.properties?.['Brand Name']); } catch { /* card says Brand */ } }
  await sendText(st.person.number, `*${d.subject}*\nTo: ${d.to || '⚠️ no address yet'}${d.cc ? '\nCc: ' + d.cc : ''}\n\n${d.body}`);
  const sent = await sendButtons(st.person.number, 'Send it, change it, or drop it? To change it, just tell me what to change.', draftButtons(id));
  st.messages.push({ role: 'assistant', content: draftCard(d).slice(0, 1500), meta: 'draft', draft: id, wid: sentId(sent), at: new Date().toISOString() });
  return true;
}

// Drafts waiting in Approvals whose brand is named in the message (or in the alert they replied to): each one in full,
// then Send / Edit / Reject. Returns false when nothing matches, so the question goes to the PM brain instead.
// Put a file sent in this chat on a waiting draft (no AI): it goes out as the email's attachment
async function attachFileToDraft(id, file) {
  const W = await import('../lib/whatsapp.js');
  const { uploadToNotion } = await import('../lib/briefs.js');
  const { notion } = await import('../lib/notion.js');
  const got = await W.downloadMedia(file.mediaId);
  const up = await uploadToNotion({ filename: file.filename, mimeType: file.mime || got.mimeType, data: got.data });
  if (!up) throw new Error('Could not save the file, send it again');
  await notion('PATCH', `/pages/${id}`, { properties: { 'Send File': { files: [{ type: 'file_upload', file_upload: { id: up }, name: String(file.filename).slice(0, 100) }] }, Attach: { select: { name: 'File' } } } });
}

// The PM asked for something a brand wants (ad codes, analytics). A swipe-reply to that question, or the next message
// within 2 hours when the question is the last thing we said, is the answer: it becomes the email draft (one AI call).
// A message that names a different creator is never the answer to this creator's question, even when the brand
// matches: "Chris X Elevenlabs brand deal, add a new card" became a made-up "we've checked, the post is live" reply to
// the ElevenLabs × Duncan Instagram question (system check, Nov 9)
const CREATOR_WORDS = { brad: 'Brad', chris: 'Chris', lindsay: 'Lindsay', emtech: 'Emtech', duncan: 'Duncan', valeri: 'Valeri', valerie: 'Valeri', david: 'David Iya', nicole: 'Nicole', dmytro: 'Dmytro', dymtro: 'Dmytro', jonathan: 'Jonathan' };
export function namesOtherCreator(text, creator) {
  const named = [...new Set((String(text).toLowerCase().match(/[a-z]+/g) || []).map((w) => CREATOR_WORDS[w]).filter(Boolean))];
  if (!named.length || !creator) return false;
  const own = CREATOR_WORDS[String(creator).split(/\s+/)[0].toLowerCase()] || creator;
  return !named.includes(own);
}
export function infoAskFor(st, replyTo, text = '') {
  if (replyTo?.meta === 'info-ask' && replyTo.infoAsk && !replyTo.resolved) return replyTo;
  const forOther = (x) => namesOtherCreator(text, x?.infoAsk?.creator);
  const open = [...st.messages].reverse().filter((x) => x.role === 'assistant' && x.meta === 'info-ask' && x.infoAsk && !x.resolved && Date.now() - Date.parse(x.at) < 3 * 864e5);
  // A swipe on the alert that followed the question, or a message that names the brand ("this is emergent ad code …")
  if (replyTo && open.length) { const q = open.find((x) => replyTo.content && brandKey(replyTo.content).includes(brandKey(x.infoAsk.brand || ''))); if (q && brandKey(q.infoAsk.brand || '').length >= 3 && !forOther(q)) return q; }
  // ...but a question about it ("any update on Emergent?") is not the answer
  const asking = /\?\s*$/.test(String(text).trim()) || /^(any|what|when|where|did|has|have|is|are|can|could|how|why|status|update|whats|what's)\b/i.test(String(text).trim());
  const named = asking ? [] : open.filter((x) => { const b = brandKey(x.infoAsk.brand || ''); return b.length >= 3 && brandKey(text).includes(b) && !forOther(x); });
  if (named.length === 1) return named[0];
  const last = [...st.messages].reverse().find((x) => x.role === 'assistant' && !['pending-doc', 'nudge', 'alert'].includes(x.meta));
  return last?.meta === 'info-ask' && last.infoAsk && !last.resolved && !forOther(last) && Date.now() - Date.parse(last.at) < 2 * 36e5 ? last : null;
}
async function answerInfoAsk(st, msg, text, file) {
  const a = msg.infoAsk;
  if (/^(cancel|skip|ignore|no|not now|leave it)\.?$/i.test(String(text || '').trim())) { msg.resolved = 'skipped'; await say(st, 'OK, I won\'t reply to them about it.'); return; }
  const { openDeals } = await import('../lib/briefs.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => d.id === a.dealId);
  if (!deal) { await say(st, 'I couldn\'t find that deal anymore.'); return; }
  const here = { ...deal, threadId: a.threadId || deal.threadId, messageRfc: a.messageRfc || deal.messageRfc, threadSubject: a.subject || deal.threadSubject, brandEmail: a.brandEmail || deal.brandEmail };
  const { writeEmail, createDraft } = await import('../lib/outbox.js');
  const mail = await writeEmail({ kind: 'Reply', deal: here, facts: { their_latest_message: a.theirMessage, they_asked_for: a.need, we_provide: text || '(see the attached file)', note: 'Give them exactly what we_provide says, word for word for any codes, links or numbers. Keep it short.' } });
  let sendFile = null;
  if (file?.mediaId) {
    const W = await import('../lib/whatsapp.js');
    const { uploadToNotion } = await import('../lib/briefs.js');
    const got = await W.downloadMedia(file.mediaId);
    const id = await uploadToNotion({ filename: file.filename, mimeType: file.mime || got.mimeType, data: got.data });
    if (id) sendFile = [{ type: 'file_upload', file_upload: { id }, name: String(file.filename).slice(0, 100) }];
  }
  msg.resolved = 'answered';
  const r = await createDraft({ kind: 'Reply', deal: here, subject: mail.subject, body: mail.body, attach: sendFile ? 'File' : 'None', sendFile, video: deal.linkedVideo, why: `${deal.brand} asked for: ${a.need}. Written from your WhatsApp answer.`, notify: true });
  if (r.skipped) await say(st, 'A reply for that thread is already waiting, so I showed that one instead.');
}

async function showDrafts(st, text) {
  const { listDrafts } = await import('../lib/outbox.js');
  const key = brandKey;
  const hay = key(text);
  const drafts = (await listDrafts()).filter((d) => d.status === 'Draft');
  const hits = drafts.filter((d) => { const b = key(d.brand); return b.length >= 3 && hay.includes(b); });
  if (!hits.length) return false;
  for (const d of hits.slice(0, 3)) {
    await sendText(st.person.number, `*${d.subject}*\nTo: ${d.to || '⚠️ no address yet'}${d.cc ? '\nCc: ' + d.cc : ''}${d.why ? `\n_${String(d.why).replace(/\s*\[[^\]]*\]/g, '').slice(0, 220)}_` : ''}\n\n${d.body}`);
    const sent = await sendButtons(st.person.number, `${d.brand || 'This'} draft · send it, change it, or drop it? To change it, just tell me what to change.`, draftButtons(d.id));
    st.messages.push({ role: 'assistant', content: draftCard(d).slice(0, 1500), meta: 'draft', draft: d.id, wid: sentId(sent), at: new Date().toISOString() });
    // The file this email will carry, so it can be opened and checked right here
    if (d.attach && d.attach !== 'None') { const W = await import('../lib/whatsapp.js'); await W.sendDraftAttachment(st.person.number, d.id).catch(() => {}); }
  }
  if (hits.length > 3) await say(st, `…and ${hits.length - 3} more for that brand in Approvals.`);
  return true;
}


// ---------- a new brand deal forwarded from a creator ----------
// Brad / Emtech / Chris send their own deal info ("Here's the Luma info, brief, due Oct 21") and Harsh forwards it here.
// The PM works out whose deal it is and which brand, shows that with buttons, and on ✅ files it exactly like a brief
// email: a deal row (Brief Received, Needs Check), a card on the creator's board with the brief, and Rudraksh pinged.
const pendingDeal = (st) => [...st.messages].reverse().slice(0, 12).find((x) => x.meta === 'deal-confirm' && !x.resolved && Date.now() - Date.parse(x.at) < 6 * 36e5);

async function maybeNewDeal(st, text, forwarded) {
  const t = text.trim();
  // A short follow-up to a video list still waiting for a tap ("we have total 4 video deals") fills that list in
  const waiting = pendingMore(st);
  if (waiting && t.length < 200 && !/https?:\/\//.test(t) && Date.now() - Date.parse(waiting.at) < 30 * 6e4) return false;
  const dealish = /\b(brand deal|brief|sponsor|collab|campaign|deliverable|due date|draft due|go live|script|ugc)\b/i.test(t);
  // Any brief link counts: Google Docs/Drive, Notion, Frame.io, Dropbox, a shared Claude artifact, or a Gmail
  // redirect wrapping one of them (google.com/url?q=...)
  const linky = /https?:\/\/((docs|drive)\.google\.com|[\w-]+\.notion\.(so|site)|notion\.(so|site)|frame\.io|(www\.)?dropbox|claude\.ai\/(artifact|public)|(www\.)?google\.com\/url\?)/i.test(t);
  // Harsh saying it outright: "Chris x ElevenLabs brand deal ... add a new card in the dashboard" (Nov 9: this went
  // to the general chat, which showed an unrelated ElevenLabs × Duncan draft instead)
  const explicit = /\b(brand deal|new deal|ugc deal|sponsor(ed)? deal|add (a )?(new )?(card|deal)|new card|open (a )?deal)\b/i.test(t);
  const morish = moreVideosAsk(t);
  const notesish = t.length > 150 && /\bscript\b/i.test(t) && /\b(feedback|changes?|notes?|additions?|instead of|could you|mention|edits?|tweaks?)\b/i.test(t);
  if (!(forwarded && (dealish || linky)) && !(t.length > 150 && dealish && linky) && !explicit && !notesish && !morish) return false;
  const { claude, HAIKU } = await import('../lib/claude.js');
  const { BOARDS } = await import('../lib/tools.js');
  const { openDeals } = await import('../lib/briefs.js');
  const roster = BOARDS.map((b) => b.creator);
  const deals = await openDeals().catch(() => []);
  const tool = { name: 'classify', description: 'Say whether this message is a brand deal for a NOOCAP creator and whose it is.', input_schema: { type: 'object', properties: {
    kind: { type: 'string', enum: ['new_deal', 'more_videos', 'script_feedback', 'other'], description: 'new_deal = hands over a sponsored brand deal or its brief for a creator to make (brief link, due date, deliverables), including a short note like "Chris x ElevenLabs brand deal, UGC, no rate, add a new card" with no rate or details. more_videos = Harsh asks for one or more NEW videos (cards) for a brand a creator already works with, usually with a brief link and a post date for each (e.g. "add 4 more videos of Higgsfield: 1. Today\'s video ... Brief: <link> 2. Tomorrow\'s video ... Brief: <link>"). Each brief link in such a message is a separate new video, never notes on an old script. script_feedback = a brand\'s notes, changes or additions on a script we ALREADY wrote and sent them (e.g. "add a line about X", "instead of Y say Z", "everything else is good"); never pick it when the message hands over new briefs or asks for new videos or cards. other = ordinary questions or instructions to the PM.' },
    videos: { type: 'array', description: 'more_videos only: one entry per new video named in the message, in order.', items: { type: 'object', properties: { title: { type: 'string', description: 'Short video title as written, e.g. "Fable 5.2 x Higgsfield: Free Unlimited V2 Racing Game"' }, brief: { type: ['string', 'null'], description: 'Its brief link, copied exactly, or null' }, post_date: { type: ['string', 'null'], description: 'Its post date as YYYY-MM-DD ("today" and "tomorrow" count from the date given above), or null' } }, required: ['title', 'brief', 'post_date'] } },
    count: { type: ['integer', 'null'], description: 'more_videos only: how many new videos Harsh asked for in total (e.g. 4 in "add 4 more videos"), even if fewer are described.' },
    is_brand_deal: { type: 'boolean', description: 'True only when kind is new_deal.' },
    creator: { type: ['string', 'null'], enum: [...roster, null], description: 'Whose deal it is, from clues in the message: their own email address (bradgainesmarketing@gmail.com is Brad), their name, their handle, or a creator who already has a deal with this brand. Null if you cannot tell.' },
    brand: { type: 'string', description: 'The brand name' },
    due: { type: ['string', 'null'], description: 'Draft or post due date as written, if any' },
    gist: { type: 'string', description: 'One short line on what the deal is' },
  }, required: ['kind', 'is_brand_deal', 'creator', 'brand', 'gist'] } };
  const r = await claude({ _job: 'whatsapp', model: HAIKU, max_tokens: 400, tools: [tool], tool_choice: { type: 'tool', name: 'classify' }, messages: [{ role: 'user', content: `Today is ${new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)} (IST).\nNOOCAP creators: ${roster.join(', ')}.\nOpen deals: ${deals.map((d) => `${d.brand} (${d.creator})`).join(', ').slice(0, 2500)}\n\nMessage Harsh ${forwarded ? 'forwarded' : 'sent'} to the PM:\n${t.slice(0, 6000)}` }] });
  const x = (r.content || []).find((c) => c.type === 'tool_use')?.input;
  // "Add 4 more videos of Higgsfield" with new brief links was read as script feedback (Nov 9) and sent to Rudraksh
  // as script changes. New briefs or an ask for more videos are new cards, whatever the model said.
  // A list of dated videos for a brand the creator already has a deal or card with is more videos, not a new deal to
  // fold into that old deal ("The brand requires three videos..." for Lindsay x Higgsfield, Nov 9)
  const hasBrand = () => { const k = String(x?.brand || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6); return !!k && deals.some((d) => (!x.creator || d.creator === x.creator) && d.brand.toLowerCase().replace(/[^a-z0-9]/g, '').includes(k)); };
  if (x && (x.kind === 'more_videos' || (morish && (x.kind === 'script_feedback' || x.kind === 'other' || (x.kind === 'new_deal' && hasBrand()))))) return offerMoreVideos(st, t, x, deals, roster);
  if (x?.kind === 'script_feedback') return offerScriptNotes(st, t, x, deals, roster);
  if (!x?.is_brand_deal || x.kind === 'other') return false;
  const already = x.creator && deals.find((d) => d.creator === x.creator && d.brand.toLowerCase().replace(/[^a-z0-9]/g, '').includes(String(x.brand || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)));
  const head = `🆕 *New brand deal: ${x.brand || 'brand?'} × ${x.creator || 'whose?'}*\n• ${x.gist}${x.due ? `\n• Due: ${x.due}` : ''}${already ? `\n• ${x.creator} already has a "${already.brand}" deal (${already.stage}), so I'd add this brief to it` : ''}`;
  const unwrapped = t.replace(/https?:\/\/(?:www\.)?google\.com\/url\?q=([^&\s]+)[^\s]*/gi, (m, q) => { try { return decodeURIComponent(q); } catch { return m; } });
  const entry = { role: 'assistant', content: head, meta: 'deal-confirm', dealText: unwrapped.slice(0, 9000), brand: x.brand, creator: x.creator || null, dealId: already?.id || null, at: new Date().toISOString() };
  if (!x.creator) {
    entry.whose = true;
    await sendText(st.person.number, `${head}\n\nWhose deal is this? Reply with the creator's name (${roster.join(', ')}).`);
  } else {
    await sendButtons(st.person.number, `${head}\n\nFile it? I'll ${already ? 'add the brief to that deal and its card' : `open the deal, make the card on ${x.creator}'s board with the brief`} and tell Rudraksh.\n\n*WhatsApp* = ${x.creator} handles the brand, so I never email them. *Email* = we run it from our inbox.\nWrong creator? Just reply with the right name.`, [{ id: 'dealwa', title: '✅ File · WhatsApp' }, { id: 'dealmail', title: '📧 File · Email' }, { id: 'dealno', title: '✖️ Not a deal' }]);
  }
  st.messages.push(entry);
  return true;
}

// ---------- more videos for a brand the creator already works with ----------
// "I am telling you to add 4 more videos of Higgsfield: 1. Today's video ... Brief: <link> 2. ..." (Harsh, Nov 9).
// Each described video becomes its own card on the creator's board (Script Draft, sponsor, brief link, post date), and
// Rudraksh hears about them in one message. Videos asked for without a brief are listed as still to come.
export function moreVideosAsk(text) {
  // WhatsApp pastes hide word-joiners and zero-width spaces after list numbers ("1.\u2060 \u2060Today's Video")
  const t = String(text || '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
  const n = '(\\d+|one|two|three|four|five|six|seven|eight)';
  // "The brand requires three videos on the following dates", "we have total 4 video deals"
  if (new RegExp(`\\b(requires?|needs?|wants?|asked for|asking for|booked|confirmed)\\s+(the\\s+)?${n}\\s+(more\\s+|new\\s+)?(videos?|reels?)\\b`, 'i').test(t)) return true;
  if (new RegExp(`\\b${n}\\s+(videos?|reels?)\\s+(deals?|campaigns?)\\b`, 'i').test(t)) return true;
  // A numbered list of two or more videos, with at least one brief link
  const items = t.match(/(^|\n)\s*\d+[.)]\s*[^\n]*\b(video|reel)\b/gi) || [];
  if (items.length >= 2 && /https?:\/\//.test(t)) return true;
  const num = '(\\d+|one|two|three|four|five|six|a few|some)';
  if (new RegExp(`\\b(add|make|create|open|need)\\b[^.\\n]{0,40}\\b${num}?\\s*(more|new|extra|other)\\s+(videos?|cards?|reels?|briefs?)\\b`, 'i').test(t)) return true;
  if (/\b(here'?s|here is|these are|sending)\b[^.\n]{0,30}\b(the\s+)?(briefs?|breifs?)\b/i.test(t) && (t.match(/https?:\/\//g) || []).length >= 1) return true;
  return false;
}
const pendingMore = (st) => [...st.messages].reverse().slice(0, 12).find((x) => x.meta === 'more-confirm' && !x.resolved && Date.now() - Date.parse(x.at) < 6 * 36e5);
async function offerMoreVideos(st, t, x, deals, roster) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = norm(x.brand).slice(0, 6);
  const same = key ? deals.filter((d) => norm(d.brand).includes(key) && (!x.creator || d.creator === x.creator)) : [];
  const deal = same[0];
  // Guess the creator from the deal only when exactly one creator works with this brand right now
  const creator = x.creator || (new Set(same.map((d) => d.creator)).size === 1 ? deal.creator : null);
  const links = t.match(/https?:\/\/[^\s)>\]]+/g) || [];
  let videos = (x.videos || []).filter((v) => v && v.title);
  // The model missed the list: one card per brief link at least
  if (!videos.length && links.length) videos = links.map((l, i) => ({ title: `${x.brand || 'Brand'} video ${i + 1}`, brief: l, post_date: null }));
  const total = Math.max(Number(x.count) || 0, videos.length);
  const missing = Math.max(0, total - videos.length);
  const entry = { role: 'assistant', meta: 'more-confirm', brand: deal?.brand || x.brand, creator, videos, missing, at: new Date().toISOString() };
  st.messages.push(entry);
  await showMore(st, entry, roster);
  return true;
}
async function showMore(st, entry, roster) {
  if (!roster) { const { BOARDS } = await import('../lib/tools.js'); roster = BOARDS.map((b) => b.creator); }
  const { videos = [], missing = 0, creator } = entry;
  const day = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'no date');
  const list = videos.map((v, i) => `${i + 1}. ${v.title} · posts ${day(v.post_date)}${v.brief ? '' : ' · brief comes later'}`).join('\n');
  entry.content = `🎬 *${videos.length} new video${videos.length === 1 ? '' : 's'}: ${entry.brand || 'brand?'} × ${creator || 'whose?'}*\n${list}${missing ? `\n+ ${missing} more you mentioned, waiting for their brief${missing === 1 ? '' : 's'}` : ''}`;
  if (!creator) {
    await sendText(st.person.number, `${entry.content}\n\nWhose videos are these? Reply with the creator's name (${roster.join(', ')}).`);
  } else if (!videos.length) {
    await sendText(st.person.number, `${entry.content}\n\nSend me the brief link and post date for each one and I'll make the cards.`);
  } else {
    await sendButtons(st.person.number, `${entry.content}\n\nAdd them? I'll make ${videos.length === 1 ? 'a card' : 'one card each'} on ${creator}'s board (Script Draft, sponsor, brief linked, post date set) and send Rudraksh the briefs. A brief already on the board keeps its card.\nWrong creator? Just reply with the right name.`, [{ id: 'moreyes', title: `➕ Add ${videos.length} card${videos.length === 1 ? '' : 's'}` }, { id: 'moreno', title: '✖️ Don\'t add' }]);
  }
}
async function addMoreVideos(st) {
  const p = pendingMore(st);
  if (!p) { await say(st, 'Those videos are no longer waiting. Send them again.'); return; }
  if (!p.creator) { await say(st, 'Whose videos are they? Reply with the creator\'s name.'); return; }
  p.resolved = 'adding'; await saveState(st);
  const { addVideoCards } = await import('../lib/briefs.js');
  try {
    const made = await addVideoCards({ creator: p.creator, brand: p.brand, videos: p.videos });
    p.resolved = 'added';
    const fresh = made.filter((m) => !m.existed), old = made.filter((m) => m.existed);
    const lines = [
      fresh.length ? `✅ Added ${fresh.length} card${fresh.length === 1 ? '' : 's'} on ${p.creator}'s board and sent Rudraksh the brief${fresh.length === 1 ? '' : 's'}:\n${fresh.map((m) => `• ${m.title}: ${m.url}`).join('\n')}` : null,
      old.length ? `${fresh.length ? '' : '👍 Nothing new to add. '}Already on the board with this brief, so I didn't make another card:\n${old.map((m) => `• ${m.title}: ${m.url}`).join('\n')}` : null,
      p.missing ? `Still to come: ${p.missing} more. Send their briefs and I'll add them.` : null,
    ].filter(Boolean);
    await say(st, lines.join('\n'));
  } catch (e) { p.resolved = 'failed'; await say(st, `⚠️ I couldn't add them: ${e.message}`); }
}

// ---------- a brand's script feedback forwarded on WhatsApp ----------
// Chris pastes the brand's notes in the creator group, Harsh forwards them here: the PM says whose script it is and,
// on ✏️, sends the notes to Rudraksh exactly like script-change emails (Discord ping, notes on the card, card back to Script Draft).
const pendingNotes = (st) => [...st.messages].reverse().slice(0, 12).find((x) => x.meta === 'notes-confirm' && !x.resolved && Date.now() - Date.parse(x.at) < 6 * 36e5);
async function offerScriptNotes(st, t, x, deals, roster) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = norm(x.brand).slice(0, 6);
  const deal = key && deals.find((d) => norm(d.brand).includes(key) && (!x.creator || d.creator === x.creator));
  const creator = x.creator || deal?.creator || null;
  const entry = { role: 'assistant', meta: 'notes-confirm', notes: t.slice(0, 6000), brand: deal?.brand || x.brand, creator, at: new Date().toISOString() };
  entry.content = `✏️ *Script feedback: ${entry.brand || 'brand?'} × ${creator || 'whose?'}*\n• ${x.gist}`;
  if (!creator) {
    entry.whose = true;
    await sendText(st.person.number, `${entry.content}\n\nWhose script is this? Reply with the creator's name (${roster.join(', ')}).`);
  } else {
    await sendButtons(st.person.number, `${entry.content}\n\nSend it to Rudraksh? I'll ping him on Discord with the notes, add them to the video card and move the card back to Script Draft.\nWrong creator? Just reply with the right name.`, [{ id: 'noteson', title: '✏️ Send to Rudraksh' }, { id: 'notesno', title: '✖️ Don\'t send' }]);
  }
  st.messages.push(entry);
  return true;
}
async function sendScriptNotes(st) {
  const p = pendingNotes(st);
  if (!p) { await say(st, 'Those notes are no longer waiting. Forward them again.'); return; }
  if (!p.creator) { await say(st, 'Whose script is it? Reply with the creator\'s name.'); return; }
  p.resolved = 'sending'; await saveState(st);
  const { resendScriptChanges } = await import('../lib/inbox.js');
  const { forScriptWriter } = await import('../lib/briefs.js');
  try {
    const r = await resendScriptChanges({ brand: p.brand, creator: p.creator, feedback: forScriptWriter(p.notes) });
    p.resolved = 'sent';
    await say(st, `✅ Sent *${r.deal}*'s script notes to Rudraksh${r.ok ? '' : ' (the Discord ping failed, but the notes are on the video card)'}.${r.video ? ` Card moved to ${r.video}.` : ''}`);
  } catch (e) { p.resolved = 'failed'; await say(st, `⚠️ I couldn't send it: ${e.message}. Tell me the brand name as it is on the board and I'll try again.`); }
}

async function askWhose(st) {
  const p = pendingDeal(st);
  if (!p) { await say(st, 'That deal is no longer waiting. Forward it again.'); return; }
  const { BOARDS } = await import('../lib/tools.js');
  p.whose = true; p.creator = null; p.dealId = null;
  await say(st, `Whose deal is it? Reply with the creator's name (${BOARDS.map((b) => b.creator).join(', ')}).`);
}

async function fileNewDeal(st, channel = 'WhatsApp') {
  const p = pendingDeal(st);
  if (!p) { await say(st, 'That deal is no longer waiting. Forward it again.'); return; }
  if (!p.creator) { await askWhose(st); return; }
  p.resolved = 'filing';
  await saveState(st);
  const { briefFromText } = await import('../lib/briefs.js');
  const r = await briefFromText({ text: `From: ${p.creator} (forwarded on WhatsApp by ${st.person.name})\nDate: ${new Date().toISOString()}\n\n${p.dealText}`, subject: `${p.brand || 'Brand'} brand deal`, dealId: p.dealId, creator: p.creator, channel });
  p.resolved = 'filed';
  const link = r.video || r.card || r.url || r.deal;
  const done = r.action === 'needs_help' ? `⚠️ I couldn't file it: ${r.why || 'unknown reason'}.` : `✅ Filed *${p.brand} × ${p.creator}*.${r.action === 'updated' ? ' The brief was added to the existing deal and card.' : ` New deal (marked Needs Check so you can add the rate) and a card on the board with the brief. Rudraksh has been told.`}${channel === 'WhatsApp' ? `\nHandled on WhatsApp: I won't email the brand. When the cut is ready I'll send you the link here to pass on.` : `\nHandled on email: add the brand's email on the deal so I can follow up.`}${''}${link ? `\n${link}` : ''}`;
  await say(st, done);
}
