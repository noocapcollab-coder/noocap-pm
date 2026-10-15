// GET /api/hq?costs=1 -> AI spend this month by creator
// GET /api/hq?editors=2026-10 -> each editor's month: videos delivered, finished, changes, and every video
// GET /api/hq  -> live agency snapshot for the HQ tab (no AI, free to load). ?fresh=1 skips the 45s cache.
import { buildHQ, aiCosts } from '../lib/hq.js';
import { editorOutput } from '../lib/tools.js';
import { checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const m = String(req.query?.editors || '');
    if (/^\d{4}-\d{2}$/.test(m)) {
      const [y, mo] = m.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      return res.status(200).json(await editorOutput({ from: m + '-01', to: last, include_videos: true, video_limit: 500 }));
    }
    // GET /api/hq?audience=1 -> each creator's YouTube audience + connect link; &refresh=Lindsay pulls fresh numbers
    if (req.query?.audience) {
      const Y = await import('../lib/youtube.js');
      if (req.query.refresh) await Y.refreshAudience(String(req.query.refresh));
      const have = await Y.audiences();
      const names = ['Brad', 'Chris', 'Lindsay', 'Duncan', 'Valeri', 'Emtech', 'Dymtro', 'Jonathan'];
      return res.status(200).json({ ready: Y.ytReady(), creators: names.map((c) => ({ creator: c, link: Y.connectLink(c), ...(have.find((a) => a.creator === c) || {}) })) });
    }
    if (req.query?.costs === '1') return res.status(200).json(await aiCosts({ fresh: req.query?.fresh === '1' }));
    return res.status(200).json(await buildHQ({ fresh: req.query?.fresh === '1' }));
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
