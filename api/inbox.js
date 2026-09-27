// POST /api/inbox — n8n "PM · Inbox" sends each new noocapcollab email here.
// Header: x-hook-secret. Body: one email or { emails: [...] }
import { handleInboxEmail } from '../lib/inbox.js';
import { hookAllowed, HOOK_ERROR } from '../lib/hook.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const emails = Array.isArray(body.emails) ? body.emails : [body];
  const results = [];
  for (const email of emails.slice(0, 20)) {
    try {
      results.push({ subject: email.subject, ...(await handleInboxEmail(email)) });
    } catch (e) {
      results.push({ subject: email.subject, action: 'error', error: String(e.message || e).slice(0, 300) });
    }
  }
  return res.status(200).json({ results });
}
