// GET /api/spend -> AI tools and subscriptions, monthly USD totals (?fresh=1 skips the 60s cache)
import { spendData } from '../lib/spend.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try { return res.status(200).json(await spendData({ fresh: req.query?.fresh === '1' })); }
  catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
}
