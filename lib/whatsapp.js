// WhatsApp for the PM (official WhatsApp Cloud API). Harsh and Pratham get the "needs you" alerts, approve drafts with
// buttons, and ask the PM questions, all in their own WhatsApp chat with the PM's number.
//
// Env (Vercel):
//   WA_TOKEN          permanent access token (System User token from Meta Business settings)
//   WA_PHONE_ID       the PM number's "Phone number ID" (WhatsApp > API Setup)
//   WA_APP_SECRET     the Meta app's App Secret (checks every webhook really comes from Meta)
//   WA_VERIFY_TOKEN   any phrase you choose, typed again in Meta when connecting the webhook
//   WA_NUMBERS        who the PM talks to, e.g. "Harsh:919812345678,Pratham:919876543210" (country code, digits only)
//   WA_TEMPLATE       approved template that opens the chat when it has been quiet for 24h (default pm_needs_you)
//   WA_TEMPLATE_LANG  its language code (default en)
//   WA_QUIET          quiet hours in India time, "23-9" means nothing is pushed from 11 PM to 9 AM (default 23-9)
//   WA_MORNING        hour (India time) of the morning round-up (default 9)
//
// Cost: Meta only charges for a template (the nudge that reopens a quiet chat, about once a day each). Everything
// inside the 24 hours after you last wrote or tapped a button is free, so alerts and answers ride on that window.
import crypto from 'node:crypto';
import { notion, plain } from './notion.js';
import { CHATS_DS, saveChat } from './chats.js';

const GRAPH = () => `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v23.0'}/${process.env.WA_PHONE_ID}`;
const WINDOW_MS = 23.5 * 36e5; // a little under Meta's 24 hours, to be safe
const nowIST = () => new Date(Date.now() + 5.5 * 36e5);
const todayIST = () => nowIST().toISOString().slice(0, 10);
const appUrl = () => process.env.PM_PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '');

export function people() {
  return String(process.env.WA_NUMBERS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [name, num] = x.includes(':') ? x.split(':') : ['', x];
    return { name: name.trim() || 'there', number: String(num).replace(/\D/g, '') };
  }).filter((p) => p.number.length >= 8);
}
export const waOn = () => !!(process.env.WA_TOKEN && process.env.WA_PHONE_ID && people().length);
export const personByNumber = (n) => people().find((p) => p.number === String(n || '').replace(/\D/g, ''));

// ---------- sending ----------
async function api(payload) {
  const res = await fetch(`${GRAPH()}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(process.env.WA_TOKEN || '').trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  return data;
}

// Discord-style text -> WhatsApp: **bold** -> *bold*, [text](url) -> text: url, no Discord mentions
export function waText(s) {
  return String(s || '')
    .replace(/<@\d+>\s*/g, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2')
    .replace(/^#+\s*/gm, '')
    .trim();
}

export async function sendText(to, text) {
  const t = waText(text);
  for (let i = 0; i < t.length; i += 4000) await api({ to, type: 'text', text: { body: t.slice(i, i + 4000), preview_url: false } });
}

// Up to 3 reply buttons, titles of 20 characters at most, body of 1024 at most
export async function sendButtons(to, text, buttons) {
  const body = waText(text);
  return api({
    to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body.length > 1024 ? body.slice(0, 1020) + '…' : body },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) },
    },
  });
}

async function sendNudge(person, count) {
  return api({
    to: person.number, type: 'template',
    template: {
      name: process.env.WA_TEMPLATE || 'pm_needs_you',
      language: { code: process.env.WA_TEMPLATE_LANG || 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: person.name }, { type: 'text', text: String(Math.max(1, count)) }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'DIGEST' }] },
      ],
    },
  });
}

export async function markRead(messageId) {
  return api({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }).catch(() => api({ status: 'read', message_id: messageId }).catch(() => {}));
}

// ---------- per-person chat state (a page in PM CHATS, "WhatsApp · Harsh") ----------
const stateCache = new Map();
export async function loadState(person) {
  // Reused only within one run: another run (the heartbeat, the webhook) may have written since
  const hit = stateCache.get(person.number);
  if (hit && Date.now() - hit.t < 20000) return hit.st;
  const title = `WhatsApp · ${person.name}`;
  const r = await notion('POST', `/data_sources/${CHATS_DS}/query`, { page_size: 1, filter: { property: 'Title', title: { equals: title } } }).catch(() => ({ results: [] }));
  const p = (r.results || []).find((x) => !x.in_trash);
  let messages = [];
  if (p) { try { messages = JSON.parse((p.properties?.Data?.rich_text || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('') || '[]'); } catch { messages = []; } }
  const st = { person, chatId: p?.id || null, messages };
  stateCache.set(person.number, { st, t: Date.now() });
  return st;
}
export async function saveState(st) {
  if (!st.chatId) {
    // First message: create the page with a fixed title so it's found again next time
    const page = await notion('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id: CHATS_DS },
      properties: { Title: { title: [{ type: 'text', text: { content: `WhatsApp · ${st.person.name}` } }] }, Channel: { select: { name: 'WhatsApp' } } },
    });
    st.chatId = page.id;
  }
  st.chatId = await saveChat({ chatId: st.chatId, channel: 'whatsapp', messages: st.messages });
  return st;
}
const lastInbound = (st) => st.messages.filter((m) => m.role === 'user' && m.at).map((m) => Date.parse(m.at)).sort().pop() || 0;
export const windowOpen = (st) => Date.now() - lastInbound(st) < WINDOW_MS;
function quietNow() {
  const [a, b] = String(process.env.WA_QUIET || '23-9').split('-').map(Number);
  const h = nowIST().getUTCHours();
  if (Number.isNaN(a) || Number.isNaN(b) || a === b) return false;
  return a > b ? h >= a || h < b : h >= a && h < b;
}
// One nudge per quiet spell: not again until they write back
const nudgedSinceInbound = (st) => st.messages.some((m) => m.meta === 'nudge' && Date.parse(m.at) > lastInbound(st));

// ---------- what needs a person right now (live from Notion) ----------
export async function digestItems() {
  const { listDrafts } = await import('./outbox.js');
  const { openDeals } = await import('./briefs.js');
  const today = todayIST();
  const [drafts, deals] = await Promise.all([listDrafts().catch(() => []), openDeals().catch(() => [])]);
  const waiting = drafts.filter((d) => d.status === 'Draft');
  const failed = drafts.filter((d) => d.status === 'Failed');
  const decide = deals.filter((d) => d.needsCheck);
  const overdue = deals.filter((d) => d.stage === 'Invoiced' && !d.paidDate && d.invoiceDue && String(d.invoiceDue).slice(0, 10) < today);
  return { waiting, failed, decide, overdue, count: waiting.length + failed.length + decide.length + overdue.length };
}

export function draftCard(d) {
  const lines = [
    `📬 *${d.brand || 'Brand'}${d.creator ? ' × ' + d.creator : ''}* · ${String(d.kind || 'email').toLowerCase()}`,
    `To: ${d.to || '⚠️ no address yet'}`,
    d.why ? `_${String(d.why).replace(/\s*\[[^\]]*\]/g, '').slice(0, 220)}_` : '',
    d.attach && d.attach !== 'None' ? `📎 ${d.attach} attached` : '',
    '',
    String(d.body || '').slice(0, 520) + (String(d.body || '').length > 520 ? '…' : ''),
  ];
  return lines.filter((l, i) => l || i === 4).join('\n');
}
export const draftButtons = (id) => [{ id: `send:${id}`, title: '✅ Send' }, { id: `full:${id}`, title: '📄 Full email' }, { id: `reject:${id}`, title: '✖️ Reject' }];

export async function sendDigest(st, { intro = true } = {}) {
  const to = st.person.number;
  const it = await digestItems();
  if (!it.count) { await sendText(to, 'All clear: nothing is waiting for you right now.'); record(st, 'All clear: nothing waiting.', 'digest'); return 0; }
  const head = [
    intro ? `Here's what needs you, ${st.person.name}:` : '',
    it.waiting.length ? `• *${it.waiting.length}* email${it.waiting.length > 1 ? 's' : ''} to approve` : '',
    it.failed.length ? `• *${it.failed.length}* email${it.failed.length > 1 ? 's' : ''} failed to send (open Approvals)` : '',
    ...it.decide.slice(0, 5).map((d) => `• 🙋 ${d.brand} × ${d.creator}: ${String(d.nextAction || 'your call').slice(0, 120)}`),
    ...it.overdue.slice(0, 5).map((d) => `• ⏳ ${d.brand} × ${d.creator}: invoice overdue since ${String(d.invoiceDue).slice(0, 10)}`),
  ].filter(Boolean).join('\n');
  await sendText(to, head);
  record(st, head, 'digest');
  for (const d of it.waiting.slice(0, 5)) {
    await sendButtons(to, draftCard(d), draftButtons(d.id));
    record(st, draftCard(d), 'draft');
  }
  if (it.waiting.length > 5) await sendText(to, `…and ${it.waiting.length - 5} more in Approvals${appUrl() ? ': ' + appUrl() + '/#approvals' : ''}`);
  return it.count;
}

function record(st, content, meta) {
  st.messages.push({ role: 'assistant', content: waText(content).slice(0, 1500), meta, at: new Date().toISOString() });
}

// ---------- pushing alerts ----------
// Free text while the chat is open; otherwise one template nudge, and the details come when they tap "Show me".
async function push(build) {
  if (!waOn() || quietNow()) return;
  for (const person of people()) {
    try {
      const st = await loadState(person);
      let open = windowOpen(st);
      if (open) {
        try { await build(st); } catch (e) {
          // 131047: Meta says the 24-hour window has closed after all, so fall back to the nudge
          if (!/131047|re-engagement/i.test(e.message)) throw e;
          open = false;
        }
      }
      if (!open && !nudgedSinceInbound(st)) {
        const it = await digestItems();
        if (!it.count) continue;
        await sendNudge(person, it.count);
        record(st, `(nudge: ${it.count} items waiting)`, 'nudge');
      }
      await saveState(st);
    } catch (e) {
      console.error('WhatsApp push failed', person.name, e.message);
    }
  }
}

// A new draft waiting in Approvals
export async function alertDraft(id) {
  if (!waOn()) return;
  const { readDraftById } = await import('./outbox.js');
  const d = await readDraftById(id).catch(() => null);
  if (!d || d.status !== 'Draft') return;
  if (!d.brand && d.dealId) { try { const p = await notion('GET', `/pages/${d.dealId}`); d.brand = plain(p.properties?.['Brand Name']); } catch { /* ignore */ } }
  await push(async (st) => {
    await sendButtons(st.person.number, draftCard(d), draftButtons(d.id));
    record(st, draftCard(d), 'draft');
  });
}

// Discord pings that need a person get mirrored to WhatsApp (drafts come through alertDraft, with buttons)
const FORWARD = () => String(process.env.WA_FORWARD || '🙋,💬,🟡,⏳,📎,⏰,⏸️,🧾,📝,⚠️,💸,▶️').split(',').map((x) => x.trim()).filter(Boolean);
export async function forward(content) {
  if (!waOn()) return;
  const text = waText(content).replace(/^\s+/, '');
  if (!FORWARD().some((e) => text.startsWith(e))) return;
  await push(async (st) => { await sendText(st.person.number, text); record(st, text, 'alert'); });
}

// Morning round-up, once a day per person (the heartbeat calls this every run)
export async function morning() {
  if (!waOn()) return;
  const h = nowIST().getUTCHours();
  const at = Number(process.env.WA_MORNING || 9);
  if (h < at || h >= at + 3) return;
  const today = todayIST();
  for (const person of people()) {
    try {
      const st = await loadState(person);
      if (st.messages.some((m) => m.meta === 'morning' && m.content === `(morning check ${today})`)) continue;
      const it = await digestItems();
      if (it.count) {
        if (windowOpen(st)) await sendDigest(st);
        else { await sendNudge(person, it.count); record(st, `(morning nudge: ${it.count} items waiting)`, 'nudge'); }
      }
      st.messages.push({ role: 'assistant', content: `(morning check ${today})`, meta: 'morning', at: new Date().toISOString() });
      await saveState(st);
    } catch (e) {
      console.error('WhatsApp morning failed', person.name, e.message);
    }
  }
}

// ---------- webhook security ----------
export function validSignature(raw, header) {
  const secret = String(process.env.WA_APP_SECRET || '').trim();
  if (!secret) return true; // not set up yet: rely on the number allow-list
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = String(header || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
