// /api/brain — the second brain (lib/brain.js)
//   GET ?export=1  with header x-brain-key: <BRAIN_KEY>  -> every brain source file as markdown, money removed.
//   Used by the weekly rebuild (a Claude session that runs Graphify and commits the graph into brain/).
import crypto from 'node:crypto';
import { exportBrain } from '../lib/brain.js';

const keyOk = (req) => {
  const want = process.env.BRAIN_KEY || '';
  const got = String(req.headers['x-brain-key'] || '');
  return want.length >= 24 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) return res.status(401).json({ error: 'Bad or missing x-brain-key' });
  try {
    if (req.query?.export) return res.status(200).json(await exportBrain());
    return res.status(400).json({ error: 'Use ?export=1' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
