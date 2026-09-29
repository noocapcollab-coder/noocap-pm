// GET /api/hq?costs=1 -> AI spend this month by creator
// GET /api/hq  -> live agency snapshot for the HQ tab (no AI, free to load). ?fresh=1 skips the 45s cache.
import { buildHQ, aiCosts } from '../lib/hq.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.query?.costs === '1') return res.status(200).json(await aiCosts({ fresh: req.query?.fresh === '1' }));
    return res.status(200).json(await buildHQ({ fresh: req.query?.fresh === '1' }));
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
