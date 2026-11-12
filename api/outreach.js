// /api/outreach — the Outreach tab and its sender (lib/outreach.js)
//   Vercel cron (every 5 min) or n8n with the hook secret  -> send the next email if one is due, read replies
//   GET  (PM password)                 -> campaigns, stats, sent log, replies
//   GET  ?preview=<Creator>            -> who would be emailed and a sample email
//   POST {action, creator, ...}        -> save | start | pause | stop | test | status | run
import { checkAuth } from '../lib/auth.js';
import { cronAllowed, hookAllowed } from '../lib/hook.js';
import * as O from '../lib/outreach.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (cronAllowed(req) || (hookAllowed(req) && !req.headers['x-pm-key'])) return res.status(200).json(await O.tick({ force: req.query?.force === '1' && hookAllowed(req) }));
    if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
    if (req.method === 'GET') {
      if (req.query?.preview) return res.status(200).json(await O.preview(String(req.query.preview)));
      return res.status(200).json(await O.overview());
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const c = String(b.creator || '');
    switch (b.action) {
      case 'save': { const f = {}; for (const k of ['subject', 'body', 'followUp1', 'followUp2', 'followers', 'pronoun']) if (k in b) f[k] = String(b[k] ?? ''); return res.status(200).json(await O.saveCampaign(c, f)); }
      case 'start': return res.status(200).json(await O.start(c));
      case 'pause': return res.status(200).json(await O.pause(c));
      case 'stop': return res.status(200).json(await O.stop(c));
      case 'test': return res.status(200).json(await O.testSend(c, b.to));
      case 'status': return res.status(200).json(await O.setRowStatus(String(b.id || ''), String(b.status || '')));
      case 'run': return res.status(200).json(await O.tick({ force: !!b.force }));
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e).slice(0, 300) });
  }
}
