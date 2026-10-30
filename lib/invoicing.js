// Invoices raised in the creator's own Stripe account.
//
// How it runs (heartbeat, every 5 minutes):
//   1. A deal reaches a billing point: the upfront part once the deal is signed (when the payment terms have one),
//      the rest once the video is posted. No payment terms = the full fee when the video is posted.
//   2. No company details from the brand yet -> the PM drafts an email asking for them (Approvals, Harsh sends).
//      The inbox reads the brand's answer into the deal's Billing Details.
//   3. Billing details + the creator's connected Stripe -> the PM creates a DRAFT invoice in that Stripe account and
//      puts the email that sends it in Approvals. Nothing reaches the brand until Harsh approves.
//   4. On approval the invoice is finalized in Stripe, and the email goes out in the brand's thread with the pay
//      link and the PDF.
//   5. The heartbeat checks Stripe: when the brand pays, the deal is marked paid.
//
// Creators connect once on /api/pay?connect=<link>, pasting a restricted Stripe key (Customers + Invoices write).
// Keys are stored encrypted (AES-256-GCM, PAYMENT_KEYS_SECRET) in the Creator Payment Accounts database.
import crypto from 'node:crypto';
import { notion, plain, queryAll } from './notion.js';
import { DS, istStamp } from './tools.js';

// Brands pay within 3 days of the invoice
export const DUE_DAYS = 3;
export const ACCOUNTS_DS = 'e0a99b3e-0e22-4fe1-941c-6b4c2ddb5e6e';
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1990) } }];
const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + 5.5 * 36e5 + n * 864e5).toISOString().slice(0, 10);
const daysSince = (d) => (d ? Math.floor((Date.parse(todayIST()) - Date.parse(String(d).slice(0, 10))) / 864e5) : Infinity);
const STAGE_ORDER = ['Inbound', 'Negotiating', 'Price Agreed', 'Signed', 'Brief Received', 'Script Sent', 'Script Approved', 'In Production', 'Submitted', 'Approved', 'Posted', 'Invoiced', 'Paid', 'Lost'];
const atOrAfter = (stage, target) => STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(target);

// ---------- secrets ----------
function secretKey() {
  const s = process.env.PAYMENT_KEYS_SECRET || '';
  if (s.length < 16) throw new Error('PAYMENT_KEYS_SECRET is not set in Vercel (any random string, 32+ characters)');
  return crypto.createHash('sha256').update(s).digest();
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
function decrypt(blob) {
  const [v, iv, tag, enc] = String(blob || '').split(':');
  if (v !== 'v1') throw new Error('stored key is unreadable');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
// Signed connect link for one creator (expires after 7 days), so only someone Harsh sends it to can connect
export function connectToken(creator, days = 7) {
  const exp = Date.now() + days * 864e5;
  const body = Buffer.from(JSON.stringify({ c: creator, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function readConnectToken(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return j.exp > Date.now() ? j.c : null;
}

// ---------- Stripe ----------
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}
export async function stripe(key, method, path, params) {
  const body = params && method !== 'GET' ? form(params).join('&') : undefined;
  const q = params && method === 'GET' ? '?' + form(params).join('&') : '';
  const r = await fetch(`https://api.stripe.com/v1${path}${q}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${j.error?.message || 'request failed'}`);
  return j;
}
// Check a pasted key can do what we need: list customers and invoices
export async function checkStripeKey(key) {
  if (!/^(rk|sk)_(live|test)_/.test(key)) throw new Error('That is not a Stripe secret or restricted key (it starts with rk_live_ or sk_live_)');
  await stripe(key, 'GET', '/customers', { limit: 1 });
  await stripe(key, 'GET', '/invoices', { limit: 1 });
  let name = '';
  try { const a = await stripe(key, 'GET', '/account'); name = a.business_profile?.name || a.settings?.dashboard?.display_name || a.email || a.id; } catch { /* restricted keys may not read the account */ }
  return { live: key.includes('_live_'), name: name || `Stripe key ••••${key.slice(-4)}` };
}

// ---------- creator accounts ----------
async function accountRow(creator) {
  const rows = await queryAll(ACCOUNTS_DS, { property: 'Creator', title: { equals: creator } }, { useCache: false });
  return rows.find((p) => plain(p.properties?.Status) === 'Connected') || rows[0] || null;
}
export async function saveStripeKey(creator, key) {
  const info = await checkStripeKey(key);
  const props = {
    Creator: { title: rt(creator) }, Provider: { select: { name: 'Stripe' } }, Account: { rich_text: rt(`${info.name}${info.live ? '' : ' (TEST mode)'}`) },
    Key: { rich_text: rt(encrypt(key)) }, Status: { select: { name: 'Connected' } }, 'Connected At': { date: { start: new Date().toISOString() } },
  };
  const old = await accountRow(creator);
  if (old) await notion('PATCH', `/pages/${old.id}`, { properties: props });
  else await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: ACCOUNTS_DS }, properties: props });
  return info;
}
export async function creatorStripe(creator) {
  const row = await accountRow(creator);
  if (!row || plain(row.properties?.Status) !== 'Connected') return null;
  return { key: decrypt(plain(row.properties?.Key)), account: plain(row.properties?.Account) || 'Stripe' };
}

// ---------- the deal's billing ----------
export function readBilling(text) {
  try { const j = JSON.parse(text || ''); return j && j.company_name ? j : null; } catch { /* typed by hand, see below */ }
  // Typed by hand in Notion: "Company: X | Email: Y | Address: Z | Country: HK | Tax ID: ..." (pipes or new lines)
  const out = {};
  const KEYS = { company: 'company_name', 'company name': 'company_name', email: 'email', address: 'address', country: 'country_code', 'tax id': 'tax_id', vat: 'tax_id', contact: 'contact_name', attn: 'contact_name' };
  for (const part of String(text || '').split(/\s*[|\n]\s*/)) {
    const m = part.match(/^\s*([A-Za-z ]+?)\s*:\s*(.+)$/);
    const k = m && KEYS[m[1].toLowerCase().trim()];
    if (k) out[k] = m[2].trim();
  }
  return out.company_name ? out : null;
}
// "50% upfront, 50% on publish" -> [{ part: 'upfront', pct: 50 }, { part: 'final', pct: 50 }]
export function invoiceParts(terms) {
  const t = String(terms || '').toLowerCase();
  const m = t.match(/(\d{1,3})\s*%\s*(?:up ?front|on sign|upon sign|at sign|on contract|in advance|advance|before|deposit|on approval of the script|upon script approval|on script approval)/) || t.match(/(?:up ?front|advance|deposit|on sign\w*)[^\d%]{0,20}(\d{1,3})\s*%/);
  const up = m ? Math.min(100, Number(m[1])) : 0;
  if (!up || up >= 100) return up >= 100 ? [{ part: 'upfront', pct: 100 }] : [{ part: 'final', pct: 100 }];
  return [{ part: 'upfront', pct: up }, { part: 'final', pct: 100 - up }];
}
// Upfront is due once signed (or script approved when the terms say so); the rest once posted
export function partDue(deal, part, terms) {
  if (part === 'final') return deal.stage === 'Posted' || (deal.invoiceRequested && atOrAfter(deal.stage, 'Submitted') && deal.stage !== 'Paid') || (deal.stage === 'Invoiced' && /upfront \|/.test(deal.stripeInvoices || ''));
  const atScript = /script approv/i.test(terms || '');
  return atScript ? atOrAfter(deal.stage, 'Script Approved') : atOrAfter(deal.stage, 'Signed') && deal.stage !== 'Price Agreed';
}
// "upfront | in_123 | sent | 1000\nfinal | in_456 | draft | 1000"
export function readInvoices(text) {
  return String(text || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0] && a[1]).map(([part, id, status, amount]) => ({ part, id, status: status || 'draft', amount: Number(amount) || 0 }));
}
// NOOCAP's cut for a creator, from the Creator Cut table (no row = no cut, e.g. Chris)
export async function creatorCut(creator) {
  const rows = await queryAll(DS.cuts).catch(() => []);
  const r = rows.find((p) => String(plain(p.properties?.Creator) || '').trim().toLowerCase() === String(creator || '').trim().toLowerCase());
  return Number(plain(r?.properties?.['Cut Percent']) || 0);
}
export const paidNextAction = (cut) => (cut > 0 ? 'Collect NOOCAP cut' : 'Paid, nothing left to do (no NOOCAP cut)');
const writeInvoices = (list) => list.map((x) => `${x.part} | ${x.id} | ${x.status} | ${x.amount || ''}`).join('\n');

async function setDeal(dealId, props) { await notion('PATCH', `/pages/${dealId}`, { properties: props }); }

// Invoice numbers run separately for each creator: INV-001, INV-002 ... (Duncan's and Lindsay's both start at INV-001).
// Every number used is kept in the deal's "Invoice Number" field (several per deal are comma-separated), whether the
// invoice went through Stripe or as a PDF sent by hand, so the next one is always the highest used + 1.
export const formatInvoiceNumber = (n) => `INV-${String(n).padStart(3, '0')}`;
export function highestInvoiceNumber(values = []) {
  let max = 0;
  for (const v of values) for (const m of String(v || '').matchAll(/INV[-\s]?(\d+)/gi)) max = Math.max(max, Number(m[1]));
  return max;
}
export async function nextInvoiceNumber(creator) {
  const rows = await queryAll(DS.deals, { property: 'Creator', select: { equals: creator } }, { useCache: false });
  return formatInvoiceNumber(highestInvoiceNumber(rows.map((p) => plain(p.properties?.['Invoice Number']))) + 1);
}
async function recordInvoiceNumber(dealId, number) {
  const page = await notion('GET', `/pages/${dealId}`);
  const had = plain(page.properties?.['Invoice Number']) || '';
  await setDeal(dealId, { 'Invoice Number': { rich_text: rt([had, number].filter(Boolean).join(', ')) } });
}

// Draft a Stripe invoice in the creator's account for one part of the deal
export async function createStripeInvoice(deal, part, pct, { amountUsd, billing } = {}) {
  const acct = await creatorStripe(deal.creator);
  if (!acct) throw new Error(`${deal.creator}'s Stripe is not connected`);
  const bill = billing || readBilling(deal.billing);
  if (!bill) throw new Error('no billing details from the brand yet');
  const amount = amountUsd ? Math.round(Number(amountUsd) * 100) : Math.round(Number(deal.finalRate) * pct); // cents
  if (!amount) throw new Error('the deal has no Final Rate USD');
  const customer = await stripe(acct.key, 'POST', '/customers', {
    name: bill.company_name, email: bill.email || deal.brandEmail,
    address: bill.address ? { line1: String(bill.address).slice(0, 200), country: bill.country_code || undefined } : undefined,
    metadata: { noocap_deal: deal.id, brand: deal.brand },
  });
  const label = `${deal.deliverables || 'Sponsored video'} (${deal.creator} × ${deal.brand})`.slice(0, 480);
  const number = await nextInvoiceNumber(deal.creator);
  const inv = await stripe(acct.key, 'POST', '/invoices', {
    number,
    customer: customer.id, collection_method: 'send_invoice', days_until_due: DUE_DAYS, currency: 'usd', auto_advance: 'false', pending_invoice_items_behavior: 'exclude',
    description: pct < 100 ? `${part === 'upfront' ? 'Upfront' : 'Final'} payment, ${pct}% of the agreed fee` : undefined,
    custom_fields: [bill.tax_id ? { name: 'Tax ID', value: String(bill.tax_id).slice(0, 140) } : null, bill.contact_name ? { name: 'Attn', value: String(bill.contact_name).slice(0, 140) } : null].filter(Boolean),
    metadata: { noocap_deal: deal.id, part },
  });
  await stripe(acct.key, 'POST', '/invoiceitems', { customer: customer.id, invoice: inv.id, amount, currency: 'usd', description: label });
  await recordInvoiceNumber(deal.id, number).catch(() => {});
  return { id: inv.id, amount: amount / 100, account: acct.account, number };
}

// Called when Harsh approves the invoice email: finalize it in Stripe and hand back the pay link and PDF
export async function finalizeForSend(creator, invoiceId) {
  const acct = await creatorStripe(creator);
  if (!acct) throw new Error(`${creator}'s Stripe is not connected any more`);
  let inv = await stripe(acct.key, 'GET', `/invoices/${invoiceId}`);
  if (inv.status === 'draft') inv = await stripe(acct.key, 'POST', `/invoices/${invoiceId}/finalize`, { auto_advance: 'false' });
  if (inv.status === 'void' || inv.status === 'uncollectible') throw new Error(`That Stripe invoice is ${inv.status}`);
  let pdf = null;
  try {
    if (inv.invoice_pdf) {
      const r = await fetch(inv.invoice_pdf);
      if (r.ok) pdf = { filename: `Invoice ${inv.number || inv.id}.pdf`, mimeType: 'application/pdf', data: Buffer.from(await r.arrayBuffer()).toString('base64') };
    }
  } catch { /* the pay link is enough */ }
  return { link: inv.hosted_invoice_url, number: inv.number, amount: inv.amount_due / 100, pdf };
}
// After the email went out: mark that part sent on the deal
export async function markPartSent(dealId, invoiceId) {
  const page = await notion('GET', `/pages/${dealId}`);
  const list = readInvoices(plain(page.properties?.['Stripe Invoices']));
  for (const x of list) if (x.id === invoiceId) x.status = 'sent';
  await setDeal(dealId, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) } });
  return list.find((x) => x.id === invoiceId)?.part || 'final';
}

// ---------- pay links for invoices sent by hand ----------
// Harsh ticks "Pay Link Requested" on a deal when he sends the invoice PDF himself. The PM then creates the invoice in
// the creator's Stripe and FINALIZES it without emailing anyone, so it has a pay link (and a QR code can point at it).
// The link goes in "Pay Link" and on Discord, and the invoice is tracked like any other: when the brand pays, the deal
// is marked Paid on its own.
export async function makePayLinks({ say } = {}) {
  const made = [];
  if (!process.env.PAYMENT_KEYS_SECRET) return made;
  const rows = await queryAll(DS.deals, { property: 'Pay Link Requested', checkbox: { equals: true } }, { useCache: false }).catch(() => []);
  for (const p of rows) {
    const g = (n) => plain(p.properties?.[n]);
    const deal = { id: p.id, brand: g('Brand Name'), creator: g('Creator'), brandEmail: g('Brand Email'), billing: g('Billing Details'), finalRate: g('Final Rate USD'), deliverables: g('Deliverables') };
    const done = (props) => setDeal(p.id, { 'Pay Link Requested': { checkbox: false }, ...props });
    if (g('Pay Link')) { await done({}); continue; }
    try {
      const amount = Number(g('Invoice Amount') || deal.finalRate);
      if (!(amount > 0)) throw new Error('no amount on the deal (Final Rate USD or Invoice Amount)');
      const inv = await createStripeInvoice(deal, 'extra', 100, { amountUsd: amount, billing: readBilling(deal.billing) || undefined });
      const fin = await finalizeForSend(deal.creator, inv.id);
      const list = readInvoices(g('Stripe Invoices'));
      list.push({ part: 'extra', id: inv.id, status: 'sent', amount: inv.amount });
      await done({ 'Pay Link': { url: fin.link }, 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) }, 'Invoice Amount': { number: inv.amount } });
      made.push(`${deal.brand} × ${deal.creator} $${inv.amount}`);
      if (say) await say(`🔗 **Pay link ready: ${deal.brand} × ${deal.creator}** · $${inv.amount} in ${deal.creator}'s Stripe (invoice ${fin.number || inv.id}, not emailed)\n${fin.link}`).catch(() => {});
    } catch (e) {
      await done({ 'Next Action': { rich_text: rt(`Pay link failed: ${String(e.message || e).slice(0, 160)}`) } }).catch(() => {});
      if (say) await say(`⚠️ **Couldn't make the pay link for ${deal.brand} × ${deal.creator}**: ${String(e.message || e).slice(0, 200)}`).catch(() => {});
    }
  }
  return made;
}

// ---------- the heartbeat step ----------
// draft(kind, deal, { why, facts, extra }) is the heartbeat's draft helper; say(text) posts to Discord
export async function runInvoicing(deals, { draft, say }) {
  const out = { asked: [], drafted: [], paid: [], waiting: [] };
  if (!process.env.PAYMENT_KEYS_SECRET) return out;
  for (const deal of deals) {
    if (deal.paused || deal.channel === 'WhatsApp' || !Number(deal.finalRate) || ['Lost', 'Paid'].includes(deal.stage)) continue;
    const list = readInvoices(deal.stripeInvoices);
    // 1. Payments: check sent invoices in Stripe
    for (const x of list.filter((i) => i.status === 'sent')) {
      try {
        const acct = await creatorStripe(deal.creator);
        if (!acct) continue;
        const inv = await stripe(acct.key, 'GET', `/invoices/${x.id}`);
        if (inv.status !== 'paid') continue;
        x.status = 'paid';
        const allPaid = list.every((i) => i.status === 'paid') && list.some((i) => i.part === 'final' || i.part === 'extra');
        const props = { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) } };
        const cut = allPaid ? await creatorCut(deal.creator) : 0;
        if (allPaid) Object.assign(props, { 'Deal Stage': { select: { name: 'Paid' } }, 'Paid Date': { date: { start: todayIST() } }, 'Next Action': { rich_text: rt(`Paid in full through Stripe. ${paidNextAction(cut)}`) } });
        else props['Next Action'] = { rich_text: rt(`${x.part === 'upfront' ? 'Upfront' : 'Final'} payment received through Stripe`) };
        await setDeal(deal.id, props);
        out.paid.push(`${deal.brand} × ${deal.creator} (${x.part}, $${inv.amount_paid / 100})`);
        await say(`💸 **Paid: ${deal.brand} × ${deal.creator}** · $${inv.amount_paid / 100} (${x.part}) through ${deal.creator}'s Stripe${allPaid ? (cut > 0 ? `. Deal marked Paid, collect the NOOCAP cut (${cut}%).` : '. Deal marked Paid. No NOOCAP cut for this creator.') : ''}`).catch(() => {});
      } catch { /* try again next tick */ }
    }
    // 2. Parts that are due and not raised yet
    const due = invoiceParts(deal.paymentTerms).filter((p) => partDue(deal, p.part, deal.paymentTerms) && !list.some((i) => i.part === p.part));
    const waitingDraft = list.some((i) => i.status === 'draft');
    if (!due.length && !waitingDraft) continue;
    // A deal already invoiced by hand (creator's own invoice) is left alone
    if (due.length && deal.invoiceSent && !list.length && !(due[0].part === 'final' && invoiceParts(deal.paymentTerms).length > 1)) continue;
    if (!deal.brandEmail) continue;
    const bill = readBilling(deal.billing);
    // Nothing is asked of the brand until the creator's Stripe is connected: there would be no account to invoice from
    if (due.length && !list.length && !(await creatorStripe(deal.creator).catch(() => null))) { out.waiting.push(`${deal.brand} × ${deal.creator}: Stripe not connected`); continue; }
    if (!bill && due.length) {
      // Ask for the company details once, then remind after 3 days (twice at most)
      const asked = deal.billingRequested && daysSince(deal.billingRequested) < 3;
      if (asked || deal.billingReminders >= 3) continue;
      const ok = await draft('Billing details', deal, { why: `${due[0].part === 'upfront' ? 'The upfront payment is due' : 'The video is posted'}: the invoice needs ${deal.brand}'s company details first.`, facts: { request: 'their company billing details for the invoice: registered company name, billing email, full address, and VAT or tax ID if they have one', amount_usd: Math.round(Number(deal.finalRate) * due[0].pct / 100), reminder: deal.billingRequested ? 'yes, we asked before' : 'no' } });
      if (ok) { await setDeal(deal.id, { 'Billing Request Sent': { date: { start: todayIST() } }, 'Billing Reminders Sent': { number: (deal.billingReminders || 0) + 1 } }); out.asked.push(`${deal.brand} × ${deal.creator}`); }
      continue;
    }
    if (!bill) continue;
    const acct = await creatorStripe(deal.creator).catch(() => null);
    if (!acct) {
      if (!/Connect .* Stripe/.test(deal.nextAction || '')) {
        await setDeal(deal.id, { 'Next Action': { rich_text: rt(`Connect ${deal.creator}'s Stripe so the PM can raise the invoice`) } });
        await say(`🧾 **${deal.brand} × ${deal.creator}**: the brand's billing details are in, but ${deal.creator}'s Stripe isn't connected, so I can't raise the invoice. Send ${deal.creator} their connect link.`).catch(() => {});
      }
      out.waiting.push(`${deal.brand} × ${deal.creator}: Stripe not connected`);
      continue;
    }
    for (const p of due.filter(() => !waitingDraft).slice(0, 1)) {
      try {
        const inv = await createStripeInvoice(deal, p.part, p.pct);
        list.push({ part: p.part, id: inv.id, status: 'draft', amount: inv.amount });
        await setDeal(deal.id, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) }, 'Invoice Amount': { number: inv.amount } });
      } catch (e) { out.waiting.push(`${deal.brand} × ${deal.creator}: ${String(e.message).slice(0, 120)}`); }
    }
    // 3. Every Stripe draft has its email in Approvals (made again if the first try didn't get one)
    for (const x of list.filter((i) => i.status === 'draft')) {
      const pct = invoiceParts(deal.paymentTerms).find((p) => p.part === x.part)?.pct || 100;
      const ok = await draft('Invoice', deal, {
        why: `Invoice for $${x.amount} (${pct < 100 ? `${x.part}, ${pct}% of $${deal.finalRate}` : 'full fee'}) is drafted in ${deal.creator}'s Stripe (${acct.account}) for ${bill.company_name}. Approving finalizes it in Stripe and sends the pay link and PDF.`,
        facts: { amount: `$${x.amount}`, part: pct < 100 ? `${x.part} payment (${pct}%)` : 'full fee', billed_to: bill.company_name, pay_link: '{{invoice_link}}', deliverables: deal.deliverables, posted_links: deal.postedLinks },
        stripeInvoice: `${x.part}|${x.id}`,
      });
      if (ok) out.drafted.push(`${deal.brand} × ${deal.creator} $${x.amount}`);
    }
  }
  return out;
}
export { DS, istStamp, addDays };

// ---------- for the HQ Invoices tab ----------
const STEP_TXT = { draft: 'Drafted in Stripe, waiting for your approval', sent: 'Sent to the brand, waiting for payment', paid: 'Paid' };
export async function invoicingBoard(deals) {
  const rows = await queryAll(ACCOUNTS_DS, undefined, { useCache: false }).catch(() => []);
  const accounts = rows.map((p) => ({ creator: plain(p.properties?.Creator), status: plain(p.properties?.Status) || '', account: plain(p.properties?.Account) || '', at: plain(p.properties?.['Connected At']) || null }));
  const names = [...new Set([...deals.map((d) => d.creator).filter(Boolean), ...accounts.map((a) => a.creator)])].sort();
  const creators = names.map((n) => { const a = accounts.find((x) => x.creator === n && x.status === 'Connected'); return { name: n, connected: !!a, account: a?.account || '', at: a?.at || null }; });
  const list = [];
  for (const d of deals) {
    if (d.channel === 'WhatsApp' || !Number(d.finalRate) || ['Lost', 'Inbound', 'Negotiating', 'Price Agreed'].includes(d.stage)) continue;
    const terms = invoiceParts(d.paymentTerms);
    const raised = readInvoices(d.stripeInvoices);
    const bill = readBilling(d.billing);
    const parts = terms.map((t) => {
      const r = raised.find((x) => x.part === t.part);
      const amount = r?.amount || Math.round(Number(d.finalRate) * t.pct) / 100;
      const due = partDue(d, t.part, d.paymentTerms);
      let status = r ? r.status : due ? 'due' : 'later';
      let say = r ? STEP_TXT[r.status] || r.status : !due ? (t.part === 'upfront' ? 'Due once the deal is signed' : 'Due once the video is posted') : '';
      if (!r && due) {
        if (d.invoiceSent && !raised.length && t.part === terms[0].part) { status = 'manual'; say = 'Invoiced by hand, outside Stripe'; }
        else if (!creators.find((c) => c.name === d.creator)?.connected) say = `Ready to invoice. Waiting for ${d.creator} to connect Stripe`;
        else if (!bill) say = d.billingRequested ? `Asked the brand for billing details on ${String(d.billingRequested).slice(0, 10)}` : 'Asking the brand for billing details (email in Approvals soon)';
        else if (!creators.find((c) => c.name === d.creator)?.connected) say = `Billing details in. Waiting for ${d.creator} to connect Stripe`;
        else say = 'Creating the invoice in Stripe';
      }
      return { part: t.part, pct: t.pct, amount, status, say };
    });
    if (d.stage === 'Paid' && parts.every((p) => p.status !== 'paid')) continue;
    // When the PM will create each one that hasn't started yet
    for (const p of parts) if (p.status === 'later') p.when = p.part === 'upfront' ? 'once the deal is signed' : d.deadline ? `once the video is posted (due ${String(d.deadline).slice(0, 10)})` : 'once the video is posted';
    list.push({ brand: d.brand, creator: d.creator, url: d.url, stage: d.stage, rate: Number(d.finalRate), terms: d.paymentTerms || '', billed_to: bill?.company_name || '', connected: !!creators.find((c) => c.name === d.creator)?.connected, deadline: d.deadline || null, parts });
  }
  return { enabled: !!process.env.PAYMENT_KEYS_SECRET, links_enabled: !!process.env.PM_PASSWORD, creators, deals: list };
}

// Raise an invoice by hand for a deal (Harsh asked for a specific amount): draft it in the creator's Stripe and put
// the email in Approvals, in the deal's thread. Billing goes to the brand's saved details, else the brand name and email.
export async function raiseInvoiceNow(dealId, amountUsd) {
  const { openDeals } = await import('./briefs.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(dealId).replace(/-/g, ''));
  if (!deal) throw new Error('deal not found');
  const amount = Number(amountUsd);
  if (!(amount > 0)) throw new Error('amount must be a number above 0');
  const bill = readBilling(deal.billing) || { company_name: deal.brand, email: deal.brandEmail };
  const inv = await createStripeInvoice(deal, 'extra', 100, { amountUsd: amount, billing: bill });
  const list = readInvoices(deal.stripeInvoices);
  list.push({ part: 'extra', id: inv.id, status: 'draft', amount: inv.amount });
  await setDeal(deal.id, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) }, 'Invoice Amount': { number: inv.amount } });
  const { writeEmail, createDraft } = await import('./outbox.js');
  const mail = await writeEmail({ kind: 'Invoice', deal, facts: { amount: `$${inv.amount}`, part: 'the agreed fee', billed_to: bill.company_name, pay_link: '{{invoice_link}}', deliverables: deal.deliverables } });
  let body = String(mail.body);
  if (!body.includes('{{invoice_link}}')) body = body.replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\nYou can pay here: {{invoice_link}}\n${sig}`);
  if (!body.includes('{{invoice_link}}')) body += `\n\nYou can pay here: {{invoice_link}}`;
  const r = await createDraft({ kind: 'Invoice', deal, subject: mail.subject, body, why: `Invoice for $${inv.amount} drafted in ${deal.creator}'s Stripe (${inv.account}), billed to ${bill.company_name}${bill.email ? ' <' + bill.email + '>' : ''}. Sending finalizes it in Stripe and replies in the ${deal.brand} thread with the pay link and PDF.`, stripeInvoice: `extra|${inv.id}` });
  return { invoice: inv.id, amount: inv.amount, account: inv.account, billed_to: bill.company_name, draft: r.id || null, skipped: r.skipped || false };
}

// A look at the draft invoice before it is sent: what the brand will see, built from the draft in Stripe
export async function previewInvoiceHtml(creator, invoiceId) {
  const acct = await creatorStripe(creator);
  if (!acct) throw new Error(`${creator}'s Stripe is not connected`);
  const inv = await stripe(acct.key, 'GET', `/invoices/${invoiceId}`, { 'expand[]': 'customer' });
  const lines = (inv.lines?.data || []);
  const c = typeof inv.customer === 'object' ? inv.customer : {};
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const usd = (cents) => '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const due = new Date(Date.now() + (inv.days_until_due || DUE_DAYS) * 864e5).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  const addr = c.address ? [c.address.line1, c.address.line2, c.address.city, c.address.state, c.address.postal_code, c.address.country].filter(Boolean).join(', ') : '';
  const fields = (inv.custom_fields || []).map((f) => `<div>${esc(f.name)}: ${esc(f.value)}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice preview</title>
<style>body{margin:0;background:#f4f5f7;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#1a1d24}.w{max-width:720px;margin:24px auto;padding:0 16px}
.bn{background:#fff7e0;border:1px solid #f0d58a;color:#7a5a00;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:14px}
.c{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:32px}h1{margin:0 0 4px;font-size:26px}.m{color:#6b7280;font-size:13px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:26px 0}.k{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin-top:8px}th{text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;border-bottom:1px solid #e5e7eb;padding:8px 0}
td{padding:12px 0;border-bottom:1px solid #f0f1f3}.r{text-align:right}.t{font-size:18px;font-weight:700}</style></head><body><div class="w">
<div class="bn">Preview of the draft in ${esc(creator)}'s Stripe (${esc(acct.account)}). Nothing has been sent. Stripe gives it a number, a pay link and a PDF when you press Send in Approvals.</div>
<div class="c"><h1>Invoice</h1><div class="m">Draft · ${esc(inv.currency?.toUpperCase())} · due ${esc(due)} (${inv.days_until_due || DUE_DAYS} days after sending)</div>
<div class="g"><div><div class="k">From</div><div><b>${esc(creator)}</b></div><div class="m">Stripe account: ${esc(acct.account)}</div></div>
<div><div class="k">Bill to</div><div><b>${esc(c.name || inv.customer_name || '')}</b></div><div>${esc(c.email || inv.customer_email || '')}</div>${addr ? `<div class="m">${esc(addr)}</div>` : ''}${fields}</div></div>
${inv.description ? `<p>${esc(inv.description)}</p>` : ''}
<table><tr><th>Description</th><th class="r">Amount</th></tr>${lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${usd(l.amount)}</td></tr>`).join('')}
<tr><td class="t">Total due</td><td class="r t">${usd(inv.amount_due || inv.total)}</td></tr></table></div></div></body></html>`;
}

// Correct who a draft invoice is billed to (details the brand gave earlier, read by hand): saves them on the deal and
// updates the draft's customer in the creator's Stripe. Only for drafts, never a sent invoice.
export async function setBillingOnDraft(dealId, billing) {
  const { openDeals } = await import('./briefs.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(dealId).replace(/-/g, ''));
  if (!deal) throw new Error('deal not found');
  if (!billing?.company_name) throw new Error('company_name is required');
  await setDeal(deal.id, { 'Billing Details': { rich_text: rt(JSON.stringify({ ...billing, at: todayIST() })) } });
  const acct = await creatorStripe(deal.creator);
  const out = [];
  for (const x of readInvoices(deal.stripeInvoices).filter((i) => i.status === 'draft')) {
    const inv = await stripe(acct.key, 'GET', `/invoices/${x.id}`);
    if (inv.status !== 'draft') continue;
    const [line1, ...rest] = String(billing.address || '').split(/\s*\|\s*/);
    await stripe(acct.key, 'POST', `/customers/${inv.customer}`, {
      name: billing.company_name, email: billing.email || undefined,
      address: billing.address ? { line1: line1.slice(0, 200), line2: rest.join(', ').slice(0, 200) || undefined, city: billing.city, state: billing.state, postal_code: billing.postal_code, country: billing.country_code } : undefined,
    });
    if (billing.tax_id || billing.contact_name) await stripe(acct.key, 'POST', `/invoices/${x.id}`, { custom_fields: [billing.tax_id ? { name: 'Tax ID', value: billing.tax_id } : null, billing.contact_name ? { name: 'Attn', value: billing.contact_name } : null].filter(Boolean) });
    out.push(x.id);
  }
  return { updated: out };
}

// Put every draft invoice on a deal onto the current due period
export async function setDraftDue(dealId, days = DUE_DAYS) {
  const { openDeals } = await import('./briefs.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(dealId).replace(/-/g, ''));
  if (!deal) throw new Error('deal not found');
  const acct = await creatorStripe(deal.creator);
  const out = [];
  for (const x of readInvoices(deal.stripeInvoices).filter((i) => i.status === 'draft')) {
    const inv = await stripe(acct.key, 'POST', `/invoices/${x.id}`, { days_until_due: days });
    out.push({ id: x.id, days: inv.days_until_due });
  }
  return { updated: out };
}
