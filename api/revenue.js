// GET  /api/revenue            -> sponsor videos x revenue rows x creator cuts (?fresh=1 skips the 60s cache)
// POST /api/revenue {action}   -> 'set' (upsert a revenue row), 'cut' (creator cut %), 'delete' (trash a revenue row),
//                                 'dealPaid' (a Stripe-invoiced deal paid by bank transfer: deal + rows to Paid)
import { revenueData, setRevenue, setCut, deleteRevenue } from '../lib/revenue.js';
import { checkAuth } from '../lib/auth.js';

// A creator's own read-only view (earnings.html?k=<key>): CREATOR_REVENUE_KEYS in Vercel is "Chris:<key>,Lindsay:<key>".
// The key decides the creator, never the page, so a creator can only ever see their own rows, and only what is listed
// below: no cuts, no other creators, no Notion links, no rate suggestions.
function creatorForKey(k) {
  const key = String(k || '');
  if (key.length < 20) return null;
  for (const pair of String(process.env.CREATOR_REVENUE_KEYS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(i + 1).trim() === key) return pair.slice(0, i).trim();
  }
  return null;
}
const STAGE = (s) => { const n = parseInt(s, 10); if (/posted|^paid$/i.test(s) || n === 12) return 'Posted'; if (n >= 10 && n <= 11) return 'Ready'; if (n >= 6) return 'In production'; if (n >= 1) return 'Scripting'; if (/invoic/i.test(s)) return 'Invoiced'; if (/submitted|approved/i.test(s)) return 'In production'; return 'Agreed'; };

export async function creatorView(creator, data) {
  const ck = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const rows = data.videos.filter((v) => ck(v.creator) === ck(creator) && (!v.orphan || v.amount))
    .map((v) => {
      const stage = v.orphan ? 'Posted' : STAGE(v.status);
      // the team's notes on a card title ("- CHRIS WHATSAPP", "- FOLLOWED UP") and the creator's own name are dropped
      const clean = (t) => String(t || '').replace(/\s+[-–—|]\s+[A-Z0-9 ,.&'/]{3,}$/, '').replace(new RegExp(`\\s*[×x]\\s*${creator}\\b`, 'i'), '').replace(/\s{2,}/g, ' ').trim();
      const title = clean(v.title) || clean(v.brand);
      return { title, brand: clean(v.brand), stage, date: v.date || '', amount: Number(v.amount) || null, paid: !!v.paid, paidDate: v.paidDate || '', invoiced: v.invoiced || '',
        // a payment date only means something once the video is up
        expected: !v.paid && stage === 'Posted' ? (v.deal?.expected || '') : '' };
    });
  return { ok: true, creator, generated_at: data.generated_at, today: data.today, videos: rows };
}

export default async function handler(req, res) {
  const viewer = req.method === 'GET' ? creatorForKey(req.query?.k) : null;
  if (viewer) {
    res.setHeader('Cache-Control', 'no-store');
    try { return res.status(200).json(await creatorView(viewer, await revenueData({ fresh: req.query?.fresh === '1' }))); }
    catch (e) { return res.status(502).json({ error: 'Could not load right now, try again in a minute' }); }
  }
  if (req.query?.k) return res.status(401).json({ error: 'This link is not valid' });
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await revenueData({ fresh: req.query?.fresh === '1' }));
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (b.action === 'set') return res.status(200).json(await setRevenue(b));
    if (b.action === 'cut') return res.status(200).json(await setCut(b.creator, b.pct));
    if (b.action === 'delete') return res.status(200).json(await deleteRevenue(b.revPageId));
    if (b.action === 'dealPaid') {
      const id = (String(b.deal || '').replace(/-/g, '').match(/[0-9a-f]{32}/i) || [])[0];
      if (!id) return res.status(400).json({ error: 'deal link required' });
      const { markPaidByHand } = await import('../lib/invoicing.js');
      return res.status(200).json(await markPaidByHand(id));
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
