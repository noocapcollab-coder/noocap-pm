// Chat history
// GET /api/chats          -> list of saved chats (newest first)
// GET /api/chats?id=...   -> one chat with its messages
// DELETE /api/chats?id=... -> delete a chat
import { listChats, getChat, deleteChat } from '../lib/chats.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  const id = req.query?.id;
  try {
    if (req.method === 'DELETE' && id) {
      await deleteChat(id);
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET or DELETE only' });
    if (id) return res.status(200).json(await getChat(id));
    return res.status(200).json({ chats: await listChats(50) });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
