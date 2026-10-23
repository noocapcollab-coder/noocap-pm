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
  const plainLoad = !req.query?.editors && req.query?.pricing !== '1' && req.query?.costs !== '1' && req.query?.fresh !== '1' && !req.query?.invoicing && !req.query?.connect;
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
    if (req.query?.invoicing === '1') {
      const { invoicingBoard } = await import('../lib/invoicing.js'); const { openDeals } = await import('../lib/briefs.js');
      return res.status(200).json(await invoicingBoard(await openDeals({ withClosed: true })));
    }
    // A creator's Stripe connect link: only with a PM password set, so nobody outside can attach their own Stripe
    if (req.query?.connect) {
      if (!process.env.PM_PASSWORD) return res.status(400).json({ error: 'Set PM_PASSWORD in Vercel first, so only you can make connect links.' });
      const { connectToken } = await import('../lib/invoicing.js');
      const c = String(req.query.connect).slice(0, 40);
      return res.status(200).json({ creator: c, url: `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/pay?c=${encodeURIComponent(connectToken(c))}` });
    }
    if (req.query?.costs === '1') return res.status(200).json(await aiCosts({ fresh: req.query?.fresh === '1' }));
    const data = await buildHQ({ fresh: req.query?.fresh === '1' });
    // A copy with parts missing is only kept briefly at the edge
    if ((data.errors || []).length && res.getHeader('Cache-Control') !== 'no-store') res.setHeader('Cache-Control', 'public, s-maxage=15');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
