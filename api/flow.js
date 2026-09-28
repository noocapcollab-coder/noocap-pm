// GET /api/flow  -> the whole agency journey + automation health + results (no AI). ?fresh=1 skips the cache.
import { buildFlow } from '../lib/flow.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.status(200).json(await buildFlow({ fresh: req.query?.fresh === '1' }));
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
