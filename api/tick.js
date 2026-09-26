// POST /api/tick — n8n "PM · Heartbeat" calls this every 30 minutes.
// Add ?brief=now to force the morning brief (for testing).
import { runHeartbeat } from '../lib/heartbeat.js';
import { hookAllowed, HOOK_ERROR } from '../lib/hook.js';

export default async function handler(req, res) {
  if (!hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  try {
    const report = await runHeartbeat({ force: req.query?.brief === 'now' });
    return res.status(200).json(report);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
