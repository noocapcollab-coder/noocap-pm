// GET /api/duewatch: Vercel Cron, every 30 minutes. The due watch (lib/duewatch.js): anything we owe a brand or an
// editor that is overdue goes to Harsh on WhatsApp once (Harsh, Nov 25). ?dry=1 (hook secret) lists without sending.
import { cronAllowed, hookAllowed, HOOK_ERROR } from '../lib/hook.js';
import { withRun } from '../lib/runs.js';

export default async function handler(req, res) {
  if (!cronAllowed(req) && !hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  try {
    const { runDueWatch } = await import('../lib/duewatch.js');
    if (req.query?.dry === '1') return res.status(200).json(await runDueWatch({ dry: true }));
    const out = await withRun('Due watch', 'Overdue things we owe', () => runDueWatch({}), {
      trigger: 'Vercel',
      summarize: (r) => ({ did: [`${r.found} overdue, ${r.new} new`, ...(r.items || []).map((i) => i.line)] }),
    });
    return res.status(200).json(out);
  } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
}
