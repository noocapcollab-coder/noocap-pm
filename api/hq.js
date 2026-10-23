// GET /api/hq?costs=1 -> AI spend this month by creator
// GET /api/hq?editors=2026-10 -> each editor's month: videos delivered, finished, changes, and every video
// GET /api/hq  -> live agency snapshot for the HQ tab (no AI, free to load). ?fresh=1 skips the 45s cache.
import { buildHQ, aiCosts } from '../lib/hq.js';
import { editorOutput } from '../lib/tools.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  // The password can also come as ?k= so the main snapshot can be cached at Vercel's edge per password: the URL
  // (with the password in it) is the cache key, so only someone with the password ever gets that copy
  const viaQuery = typeof req.query?.k === 'string' && req.query.k.length > 0;
  if (viaQuery) req.headers['x-pm-key'] = req.query.k;
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  const plainLoad = !req.query?.editors && req.query?.pricing !== '1' && req.query?.costs !== '1' && req.query?.fresh !== '1';
  // Served instantly from the edge (even when a minute or more old) while Vercel rebuilds it in the background
  if (plainLoad && (viaQuery || !process.env.PM_PASSWORD)) res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=1800');
  try {
    const m = String(req.query?.editors || '');
    if (/^\d{4}-\d{2}$/.test(m)) {
      const [y, mo] = m.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      return res.status(200).json(await editorOutput({ from: m + '-01', to: last, include_videos: true, video_limit: 500 }));
    }
    if (req.query?.pricing === '1') { const { pricingStats } = await import('../lib/leads.js'); return res.status(200).json(await pricingStats({ days: Number(req.query?.days) || 120 })); }
    if (req.query?.costs === '1') return res.status(200).json(await aiCosts({ fresh: req.query?.fresh === '1' }));
    return res.status(200).json(await buildHQ({ fresh: req.query?.fresh === '1' }));
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
