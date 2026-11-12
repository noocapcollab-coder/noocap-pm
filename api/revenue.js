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
      return { key: v.key, title, brand: clean(v.brand), stage, date: v.date || '', amount: Number(v.amount) || null, paid: !!v.paid, paidDate: v.paidDate || '', invoiced: v.invoiced || '',
        // a payment date only means something once the video is up
        expected: !v.paid && stage === 'Posted' ? (v.deal?.expected || '') : '' };
    });
  return { ok: true, creator, generated_at: data.generated_at, today: data.today, videos: rows };
}

const isoDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : '');
export async function creatorSave(creator, b) {
  const ck = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const data = await revenueData({ fresh: true });
  const v = data.videos.find((x) => x.key === b.key && ck(x.creator) === ck(creator));
  if (!v) throw new Error('That video is not on your list');
  const body = { action: 'set' };
  if ('amount' in b) {
    const n = b.amount === '' || b.amount == null ? null : Number(String(b.amount).replace(/[$,\s]/g, ''));
    if (n != null && (!Number.isFinite(n) || n < 0 || n > 1e6)) throw new Error('Amount must be a number');
    body.amount = n;
  }
  if ('paid' in b) { body.paid = !!b.paid; if (b.paid) body.paidDate = isoDay(b.paidDate) || data.today; }
  else if ('paidDate' in b && isoDay(b.paidDate)) body.paidDate = isoDay(b.paidDate);
  if ('invoiced' in b) body.invoiced = isoDay(b.invoiced) || '';
  if (Object.keys(body).length === 1) throw new Error('Nothing to save');
  // what the dashboard filled in from the deal is written to the row the first time it's saved, like on the team page
  if (!('amount' in body) && v.amount && (v.amountFrom === 'deal' || !v.revPageId)) body.amount = v.amount;
  if (!('paid' in body) && v.paidFrom === 'deal') { body.paid = true; body.paidDate = v.paidDate || data.today; }
  if (v.revPageId) body.revPageId = v.revPageId;
  else Object.assign(body, { link: v.link, title: v.title, creator: v.creator, brand: v.brand, date: v.date });
  const r = await setRevenue(body);
  // every change a creator makes is in the Agent Log, so the team can see who changed what
  try {
    const { log } = await import('../lib/briefs.js');
    const said = [('amount' in b) && `amount ${b.amount === '' || b.amount == null ? 'cleared' : '$' + body.amount}`, ('paid' in b) && (b.paid ? `paid on ${body.paidDate}` : 'marked not paid'), ('invoiced' in b) && `invoice date ${body.invoiced || 'cleared'}`].filter(Boolean).join(', ');
    await log({ event: `${creator} edited earnings: ${v.title}`.slice(0, 120), outcome: 'Rule', email: { messageId: '' }, details: `${said} (from ${creator}'s earnings page)`, creator });
  } catch { /* the save itself went through */ }
  return { ok: true, revPageId: r.revPageId };
}

export default async function handler(req, res) {
  const viewer = req.method === 'GET' ? creatorForKey(req.query?.k) : null;
  if (viewer) {
    res.setHeader('Cache-Control', 'no-store');
    try { return res.status(200).json(await creatorView(viewer, await revenueData({ fresh: req.query?.fresh === '1' }))); }
    catch (e) { return res.status(502).json({ error: 'Could not load right now, try again in a minute' }); }
  }
  // A creator saving their own row: amount, paid, paid date, invoice date. Nothing else can be written from their link,
  // and only on a row the server itself finds under that creator's name
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (b.k) {
      const who = creatorForKey(b.k);
      if (!who) return res.status(401).json({ error: 'This link is not valid' });
      res.setHeader('Cache-Control', 'no-store');
      try { return res.status(200).json(await creatorSave(who, b)); }
      catch (e) { return res.status(400).json({ error: String(e.message || e).slice(0, 200) }); }
    }
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
