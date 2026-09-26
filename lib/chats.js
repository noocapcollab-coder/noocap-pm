// Saves every conversation to the PM CHATS database in Notion so history works on any device.
import { notion } from './notion.js';

export const CHATS_DS = '421383c9-9734-4b1c-be37-630d0e89af7a';
const CHUNK = 1900;
const MAX_CHUNKS = 95; // Notion allows 100 text pieces per property

function toRichText(text) {
  const pieces = [];
  for (let i = 0; i < text.length && pieces.length < MAX_CHUNKS; i += CHUNK) {
    pieces.push({ type: 'text', text: { content: text.slice(i, i + CHUNK) } });
  }
  return pieces;
}
const fromRichText = (rt) => (rt || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');

// Keep the newest messages that fit in one property
function fitMessages(messages) {
  let list = messages.slice(-200);
  while (list.length > 2 && JSON.stringify(list).length > CHUNK * MAX_CHUNKS) list = list.slice(2);
  return list;
}

function transcript(messages) {
  let text = messages.map((m) => `${m.role === 'user' ? 'You' : 'PM'}: ${m.content}`).join('\n\n');
  if (text.length > CHUNK * MAX_CHUNKS) text = '…' + text.slice(-(CHUNK * MAX_CHUNKS - 1));
  return text;
}

export async function saveChat({ chatId, channel = 'dashboard', messages }) {
  const clean = fitMessages(messages.map((m) => ({ role: m.role, content: String(m.content || ''), ...(m.meta ? { meta: String(m.meta) } : {}), ...(m.at ? { at: m.at } : {}), ...(Array.isArray(m.pending) && m.pending.length ? { pending: m.pending.map((x) => ({ token: String(x.token), summary: String(x.summary) })) } : {}), ...(m.resolved ? { resolved: String(m.resolved) } : {}) })));
  const firstQ = clean.find((m) => m.role === 'user')?.content || 'Chat';
  const channelName = channel === 'whatsapp' ? 'WhatsApp' : channel === 'discord' ? 'Discord' : 'Dashboard chat';
  const properties = {
    Updated: { date: { start: new Date().toISOString() } },
    'Messages Count': { number: clean.length },
    Transcript: { rich_text: toRichText(transcript(clean)) },
    Data: { rich_text: toRichText(JSON.stringify(clean)) },
  };
  if (chatId) {
    try {
      await notion('PATCH', `/pages/${chatId}`, { properties });
      return chatId;
    } catch (e) {
      // page deleted or unreadable: start a fresh one below
    }
  }
  const page = await notion('POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: CHATS_DS },
    properties: {
      ...properties,
      Title: { title: [{ type: 'text', text: { content: firstQ.replace(/\s+/g, ' ').slice(0, 80) } }] },
      Channel: { select: { name: channelName } },
    },
  });
  return page.id;
}

export async function listChats(limit = 50) {
  const res = await notion('POST', `/data_sources/${CHATS_DS}/query`, {
    page_size: Math.min(limit, 100),
    sorts: [{ property: 'Updated', direction: 'descending' }],
  });
  return (res.results || []).filter((p) => !p.in_trash).map((p) => ({
    id: p.id,
    title: fromRichText(p.properties?.Title?.title) || 'Chat',
    updated: p.properties?.Updated?.date?.start || p.last_edited_time,
    count: p.properties?.['Messages Count']?.number || 0,
    channel: p.properties?.Channel?.select?.name || 'Dashboard chat',
  }));
}

export async function getChat(id) {
  const p = await notion('GET', `/pages/${id}`);
  let messages = [];
  try { messages = JSON.parse(fromRichText(p.properties?.Data?.rich_text) || '[]'); } catch { messages = []; }
  return { id: p.id, title: fromRichText(p.properties?.Title?.title) || 'Chat', messages };
}

export async function deleteChat(id) {
  await notion('PATCH', `/pages/${id}`, { in_trash: true });
}
