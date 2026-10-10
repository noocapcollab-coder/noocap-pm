// Ask the PM · POST /api/chat
// Body: { messages: [{ role: 'user'|'assistant', content: '...' }], channel?: 'dashboard'|'whatsapp'|'discord' }
// Header: x-pm-key: <PM_PASSWORD> (only needed if PM_PASSWORD is set in Vercel)
// Returns: { reply, usage: { input, output, cost_usd }, tools_used: [...], model }
// Tip: start a message with "deep:" to force the stronger model.
import { ask } from '../lib/ask.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const r = await ask(body);
  return res.status(r.status).json(r.data);
}
