// GET /api/watch — the watchdog (Vercel Cron, every 15 minutes). See lib/watch.js.
import { cronAllowed } from '../lib/hook.js';
import { checkAuth } from '../lib/auth.js';
import { runWatch } from '../lib/watch.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!cronAllowed(req) && !checkAuth(req)) return res.status(401).json({ error: 'Not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  try { return res.status(200).json(await runWatch()); }
  catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
}
