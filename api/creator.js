// A creator's private dashboard data (creator.html?k=<key>). The key decides the creator; anything else gets 401.
import { creatorForDashKey, creatorDash } from '../lib/creatordash.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const creator = req.method === 'GET' ? creatorForDashKey(req.query?.k) : null;
  if (!creator) return res.status(401).json({ error: 'This link is not valid' });
  try { return res.status(200).json(await creatorDash(creator, { fresh: req.query?.fresh === '1' })); }
  catch { return res.status(502).json({ error: 'Could not load right now, try again in a minute' }); }
}
