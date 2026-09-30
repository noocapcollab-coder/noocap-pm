// GET  /api/revenue            -> sponsor videos x revenue rows x creator cuts (?fresh=1 skips the 60s cache)
// POST /api/revenue {action}   -> 'set' (upsert a revenue row), 'cut' (creator cut %), 'delete' (trash a revenue row)
import { revenueData, setRevenue, setCut, deleteRevenue } from '../lib/revenue.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await revenueData({ fresh: req.query?.fresh === '1' }));
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (b.action === 'set') return res.status(200).json(await setRevenue(b));
    if (b.action === 'cut') return res.status(200).json(await setCut(b.creator, b.pct));
    if (b.action === 'delete') return res.status(200).json(await deleteRevenue(b.revPageId));
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
