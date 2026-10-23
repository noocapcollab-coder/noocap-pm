// Creators connect their Stripe here, once, so the PM can raise invoices in their name.
//   GET  /api/pay?link=Chris&k=<PM_PASSWORD or CRON_SECRET>  -> { url } a 7-day connect link to send the creator
//   GET  /api/pay?c=<link token>                              -> the connect page the creator opens
//   POST /api/pay { c, key }                                  -> checks the key with Stripe and saves it encrypted
import { connectToken, readConnectToken, saveStripeKey } from '../lib/invoicing.js';
import { discord } from '../lib/briefs.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const admin = (k) => !!k && [process.env.PM_PASSWORD, process.env.CRON_SECRET].some((w) => w && w.length >= 8 && w === k);

function page(creator, token) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Stripe</title>
<style>:root{--bg:#0d0f14;--card:#151821;--line:#262a36;--tx:#e8eaf0;--mut:#9aa1b2;--acc:#8b7cf6;--ok:#3ddc97;--bad:#f16b6b}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
.w{max-width:560px;margin:0 auto;padding:40px 18px}.c{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:22px;margin:0 0 6px}p{color:var(--mut);margin:8px 0}ol{color:var(--mut);padding-left:20px}li{margin:6px 0}b{color:var(--tx)}
input{width:100%;box-sizing:border-box;background:#0b0d12;border:1px solid var(--line);border-radius:8px;color:var(--tx);padding:11px 12px;font:14px ui-monospace,Menlo,monospace;margin-top:14px}
button{margin-top:12px;width:100%;background:var(--acc);border:0;border-radius:8px;color:#fff;padding:12px;font-weight:600;font-size:15px;cursor:pointer}
button:disabled{opacity:.5}#m{margin-top:12px;font-size:14px}.ok{color:var(--ok)}.bad{color:var(--bad)}a{color:var(--acc)}</style></head>
<body><div class="w"><div class="c"><h1>Connect your Stripe, ${esc(creator)}</h1>
<p>NOOCAP will create invoices for your brand deals in your own Stripe account, so brands pay you directly. Nothing is sent to a brand until the NOOCAP team approves it, and the key below can only create customers and invoices: it can't move money or see your payouts.</p>
<ol><li>Open <a href="https://dashboard.stripe.com/apikeys/create" target="_blank" rel="noopener">Stripe → Developers → API keys → Create restricted key</a>.</li>
<li>Name it <b>NOOCAP invoices</b>. Set <b>Customers</b> to <b>Write</b> and <b>Invoices</b> to <b>Write</b>. Leave everything else as None.</li>
<li>Click <b>Create key</b>, copy the key (it starts with <b>rk_live_</b>) and paste it here.</li></ol>
<input id="k" placeholder="rk_live_…" autocomplete="off" spellcheck="false"><button id="b">Connect</button><div id="m"></div>
<p style="margin-top:16px;font-size:13px">You can switch this off any time by deleting the key in Stripe.</p></div></div>
<script>const b=document.getElementById('b'),m=document.getElementById('m');b.onclick=async()=>{const key=document.getElementById('k').value.trim();if(!key){m.className='bad';m.textContent='Paste the key first.';return}
b.disabled=true;b.textContent='Checking with Stripe…';m.textContent='';try{const r=await fetch('/api/pay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({c:${JSON.stringify(token)},key})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Failed');
m.className='ok';m.textContent='Connected: '+j.account+'. You can close this page.';b.textContent='Connected';document.getElementById('k').value=''}catch(e){m.className='bad';m.textContent=e.message;b.disabled=false;b.textContent='Connect'}}</script></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const creator = readConnectToken(body.c);
      if (!creator) return res.status(403).json({ error: 'This connect link has expired. Ask NOOCAP for a new one.' });
      const key = String(body.key || '').trim();
      const info = await saveStripeKey(creator, key);
      await discord(`🔗 **${creator} connected Stripe** (${info.name}${info.live ? '' : ', TEST mode'}). The PM can now raise their invoices.`, 'pm').catch(() => {});
      return res.status(200).json({ ok: true, account: info.name + (info.live ? '' : ' (test mode)') });
    }
    if (req.query?.link) {
      if (!admin(String(req.query.k || ''))) return res.status(401).json({ error: 'Add ?k= with the PM password (or CRON_SECRET)' });
      const creator = String(req.query.link).trim().slice(0, 40);
      const host = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
      return res.status(200).json({ creator, url: `${host}/api/pay?c=${encodeURIComponent(connectToken(creator))}`, expires_in_days: 7 });
    }
    const creator = readConnectToken(req.query?.c);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!creator) return res.status(403).send('<p style="font-family:sans-serif;padding:40px">This connect link has expired or is wrong. Ask NOOCAP for a new one.</p>');
    return res.status(200).send(page(creator, req.query.c));
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e).slice(0, 200) });
  }
}
