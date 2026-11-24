// GET /api/unanswered: Vercel Cron, every hour at :31. The reply safety net (lib/unanswered.js, sweepUnanswered):
// a brand email left unanswered 2+ hours gets a reply drafted into Approvals and a line in #pm-alerts (Harsh, Nov 24).
// ?dry=1 (hook secret) only lists them.
import { cronAllowed, hookAllowed, HOOK_ERROR } from '../lib/hook.js';
import { withRun } from '../lib/runs.js';

export default async function handler(req, res) {
  if (!cronAllowed(req) && !hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  try {
    const { sweepUnanswered } = await import('../lib/unanswered.js');
    const dry = req.query?.dry === '1';
    if (dry) return res.status(200).json(await sweepUnanswered({ dry: true }));
    const out = await withRun('Reply check', 'Unanswered brand emails', () => sweepUnanswered({}), {
      trigger: 'Vercel',
      summarize: (r) => ({ did: [`${r.drafted.length} drafted, ${r.listed.length} listed, ${r.skipped.length} skipped`, ...r.drafted, ...r.listed] }),
    });
    return res.status(200).json(out);
  } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
}
