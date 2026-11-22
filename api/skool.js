// GET /api/skool?days=30 -> per-platform Skool link clicks and Skool member growth, per creator
import { skoolLinksData } from '../lib/skoollinks.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try { return res.status(200).json(await skoolLinksData({ days: req.query?.days })); }
  catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
}
