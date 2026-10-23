// POST /api/tick — n8n "PM · Heartbeat" calls this every 30 minutes.
// Add ?brief=now to force the morning brief (for testing).
import { runHeartbeat } from '../lib/heartbeat.js';
import { hookAllowed, cronAllowed, HOOK_ERROR } from '../lib/hook.js';
import { withRun, heartbeatSummary, pruneRuns } from '../lib/runs.js';

// A network call that never answers would hang the whole tick until Vercel kills it (and the run row stays
// "Running"). Give every call in this function 60s unless it sets its own limit.
if (!globalThis.fetch.__capped) {
  const raw = globalThis.fetch;
  const capped = (url, opts = {}) => raw(url, opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(60000) });
  capped.__capped = true;
  globalThis.fetch = capped;
}
const HARD_STOP_MS = 250 * 1000;

export default async function handler(req, res) {
  const fromCron = cronAllowed(req);
  if (!fromCron && !hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  // Once Vercel runs the heartbeat (HEARTBEAT_SOURCE=vercel), the old n8n timer is ignored so it never runs twice.
  // A manual call with ?brief=now still works.
  if (!fromCron && process.env.HEARTBEAT_SOURCE === 'vercel' && req.query?.brief !== 'now') return res.status(200).json({ skipped: 'heartbeat runs from Vercel now' });
  try {
    const report = await withRun('Heartbeat', `Heartbeat ${new Date(Date.now() + 5.5 * 36e5).toISOString().slice(11, 16)} IST`, () => {
      // If something still hangs, stop at 250s and finish the run with what got done and where it stuck
      const report = { drafts: [], handed_to_harsh: [], brief: null, errors: [], steps: [] };
      return Promise.race([
        runHeartbeat({ force: req.query?.brief === 'now', report }),
        new Promise((done) => setTimeout(() => { report.errors.push(`Stopped after ${HARD_STOP_MS / 1000}s, stuck on: ${report.now || 'reading brand deals'}`); done(report); }, HARD_STOP_MS)),
      ]);
    }, { summarize: heartbeatSummary, trigger: fromCron ? 'Vercel' : 'n8n' });
    await pruneRuns().catch(() => 0);
    return res.status(200).json(report);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
