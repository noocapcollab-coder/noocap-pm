// GET /api/trials -> Instagram trial reels posted through Zernio, per creator (?fresh=1 skips the 10 min cache)
import { trialsData } from '../lib/trials.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try { return res.status(200).json(await trialsData({ fresh: req.query?.fresh === '1' })); }
  catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
}
