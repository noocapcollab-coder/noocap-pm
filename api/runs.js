// GET /api/runs -> every automation run in the last 24h (newest first) plus per-job health. Polled every few seconds by the Runs page.
import { listRuns } from '../lib/runs.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.status(200).json(await listRuns({ fresh: req.query?.fresh === '1' }));
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
