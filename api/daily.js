// GET /api/daily — Vercel Cron, once a night (03:10 IST): the test bank of real emails (lib/evals.js).
import { cronAllowed, hookAllowed, HOOK_ERROR } from '../lib/hook.js';
import { withRun } from '../lib/runs.js';

export default async function handler(req, res) {
  if (!cronAllowed(req) && !hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  try {
    const { runEvals } = await import('../lib/evals.js');
    const out = await withRun('Test bank', 'Nightly test bank', () => runEvals(), { trigger: 'Vercel', summarize: (r) => ({ did: [`${r.summary.passed}/${r.summary.total} right${r.summary.failed ? `, ${r.summary.caughtBySecondReader} caught by the second reader` : ''}`], errors: r.results.filter((x) => x.fails.length).map((x) => `${x.id}: ${x.fails.join('; ')}`) }) });
    return res.status(200).json(out.summary);
  } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
}
