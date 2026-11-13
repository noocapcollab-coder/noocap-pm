// GET /api/daily — Vercel Cron, once a night (03:10 IST): the whole test bank (lib/testbank.js).
// GET /api/daily?gate=commit|lesson — started by the heartbeat after a deploy or a new lesson: the same run, and a case
// that passed before and fails now is a regression (a new lesson that caused it is switched off).
import { cronAllowed, hookAllowed, HOOK_ERROR } from '../lib/hook.js';
import { withRun } from '../lib/runs.js';

export default async function handler(req, res) {
  if (!cronAllowed(req) && !hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  try {
    const { runBank } = await import('../lib/testbank.js');
    const gate = ['commit', 'lesson', 'manual'].includes(req.query?.gate) ? req.query.gate : '';
    const since = String(req.query?.since || '').slice(0, 40);
    const out = await withRun('Test bank', gate ? `Test bank after a new ${gate}` : 'Nightly test bank', () => runBank({ reason: gate || 'nightly', since }), {
      trigger: 'Vercel',
      summarize: (r) => ({
        did: [`${r.summary.passed}/${r.summary.total} right${r.regressions.length ? `, ${r.regressions.length} broken by this change` : ''}${r.switchedOff.length ? `, switched off ${r.switchedOff.length} lesson(s)` : ''}`],
        errors: [...r.regressions.map((x) => `BROKEN ${x.id}: ${x.fails.join('; ')}`), ...r.stillBroken.map((x) => `not fixed yet ${x.id}: ${x.fails.join('; ')}`)],
      }),
    });
    return res.status(200).json({ ...out.summary, regressions: out.regressions.map((r) => r.id), stillBroken: out.stillBroken.map((r) => r.id), switchedOff: out.switchedOff });
  } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
}
