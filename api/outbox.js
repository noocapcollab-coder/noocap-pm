// Approvals for emails to brands.
// GET  /api/outbox                          -> drafts waiting (and failed sends)
// POST /api/outbox { id, action: 'send' | 'save' | 'reject', subject?, body?, to?, cc? }
import { listDrafts, saveDraft, rejectDraft, approveAndSend } from '../lib/outbox.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json({ drafts: await listDrafts() });
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { id, action, subject, body: text, to, cc } = body;
    if (!id) return res.status(400).json({ error: 'id required' });
    if (action === 'reject') { await rejectDraft(id); return res.status(200).json({ ok: true }); }
    if (action === 'save') { await saveDraft(id, { subject, body: text, to, cc }); return res.status(200).json({ ok: true }); }
    if (action === 'send') return res.status(200).json(await approveAndSend(id, { subject, body: text, to, cc }));
    return res.status(400).json({ error: 'action must be send, save or reject' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
