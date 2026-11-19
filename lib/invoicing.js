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
// Company details written out in the brand's own email ("Sure, here are our billing details: Datawizz Inc. (operating
// Gamut) / 360 Pine Street... / EIN: ..."), read without the AI. The AI reader missed them on Gamut x Lindsay (Nov 18),
// so the deal had no Billing Details and no invoice was raised although the brand had sent everything. Conservative:
// it needs a billing/invoice phrase and a line that ends in a company suffix, else null.
const CO_SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|ag|bv|b\.v|s\.a|sas|sarl|pte|pty|plc|oy|ab|srl|s\.r\.l|kk|lp|llp)\.?(\s*\([^)]{0,60}\))?\s*$/i;
export function billingFromText(text, fromEmail = '') {
  const t = String(text || '');
  if (!/\b(billing|invoice|bill to|company details)\b/i.test(t)) return null;
  const lines = t.split(/\r?\n/).map((l) => l.replace(/^[\s>*-]+/, '').replace(/\s+/g, ' ').trim());
  const i = lines.findIndex((l) => l.length >= 3 && l.length <= 90 && CO_SUFFIX.test(l) && !/[?]/.test(l));
  if (i < 0) return null;
  const out = { company_name: lines[i] };
  const addr = [];
  for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
    const l = lines[j];
    if (!l) { if (addr.length) break; continue; }
    const tax = l.match(/^(EIN|VAT(?: ?(?:ID|number|no\.?))?|Tax ?ID|TIN|GST(?:IN)?|ABN|UEN|CIF|NIF)\s*[:#]?\s*(.+)$/i);
    if (tax) { out.tax_id = `${tax[1].toUpperCase()} ${tax[2].trim()}`; continue; }
    if (/@|^(thanks|best|regards|please|cheers)/i.test(l)) break;
    if (/\d|,/.test(l) || addr.length) addr.push(l); else break;
  }
  if (addr.length) out.address = addr.join(', ');
  const m = (/(?:send|email|address)[^.\n]{0,40}?invoice[^.\n]{0,80}?\bto\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i.exec(t) || /invoice[^.\n]{0,80}?\bto\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i.exec(t) || [])[1];
  out.email = m || (String(fromEmail).match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || null;
  return out;
}
// "Invoices must be sent to finance@x.com", "invoices are paid 30 days after they are sent to finance@x.com", "please
// send the invoice to ap@x.com": the address the brand wants invoices and payment follow-ups at (GetRamped, Nov 4)
export function billingEmailIn(text) {
  const t = String(text || '');
  const m = t.match(/\binvoices?\b[^.?!\n]{0,90}?\b(?:sent|send|submitted|submit|emailed|addressed|go(?:es)?|forwarded)\s+(?:directly\s+)?(?:to|at)\s+([\w.+-]+@[\w.-]+\.\w+)/i)
    || t.match(/\b(?:send|email|forward|address)\b[^.?!\n]{0,40}\binvoices?\b[^.?!\n]{0,20}\b(?:to|at)\s+([\w.+-]+@[\w.-]+\.\w+)/i);
  return m ? m[1].toLowerCase() : null;
}
// The invoice email on Billing Details, whether or not the company details are in yet
export function billingEmailOf(billing) {
  try { const j = JSON.parse(billing || ''); if (j?.email) return String(j.email).toLowerCase(); } catch { /* text */ }
  const m = String(billing || '').match(/(?:^|[|\n])\s*email\s*:\s*([\w.+-]+@[\w.-]+\.\w+)/i);
  return m ? m[1].toLowerCase() : null;
}
// Billing Details with this email set, whatever format it was in (JSON from the PM, or text typed by hand)
export function withBillingEmail(billing, email) {
  try { const j = JSON.parse(billing || ''); if (j && typeof j === 'object') return JSON.stringify({ ...j, email }); } catch { /* text */ }
  const txt = String(billing || '').trim();
  if (/(^|[|\n])\s*email\s*:/i.test(txt)) return txt.replace(/((?:^|[|\n])\s*email\s*:\s*)[^|\n]+/i, `$1${email}`);
  return txt ? `${txt} | Email: ${email}` : `Email: ${email}`;
}
// "50% upfront, 50% on publish" -> [{ part: 'upfront', pct: 50 }, { part: 'final', pct: 50 }]
export function invoiceParts(terms) {
  const t = String(terms || '').toLowerCase();
  const m = t.match(/(\d{1,3})\s*%\s*(?:up ?front|on sign|upon sign|at sign|on contract|in advance|advance|before|deposit|on approval of the script|upon script approval|on script approval)/) || t.match(/(?:up ?front|advance|deposit|on sign\w*)[^\d%]{0,20}(\d{1,3})\s*%/);
  const up = m ? Math.min(100, Number(m[1])) : 0;
  if (!up || up >= 100) return up >= 100 ? [{ part: 'upfront', pct: 100 }] : [{ part: 'final', pct: 100 }];
  return [{ part: 'upfront', pct: up }, { part: 'final', pct: 100 - up }];
}
// Days to pay, from the contract terms ("Net 30", "within fourteen (14) days", "payment within 14 days"), else null
const WORDS = { seven: 7, ten: 10, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, sixty: 60 };
export function termsDueDays(terms) {
  const t = String(terms || '').toLowerCase();
  const net = t.match(/\bnet[\s-]*(\d{1,3})\b/);
  if (net) return Number(net[1]);
  const within = t.match(/within\s+(?:([a-z-]+)\s*)?\(?(\d{1,3})?\)?\s*(?:calendar |business |working )?days/);
  if (within) return Number(within[2]) || WORDS[within[1]] || null;
  const n = t.match(/\b(\d{1,3})\s*days\b/);
  return n ? Number(n[1]) : null;
}
// The due days for an invoice raised now: the contract's days, except when the invoice is already late (the video went
// live longer ago than the contract gives to pay): then the short default, because the brand has had the time already
// (Topview: posted Sep 18, invoice only raised Nov 4, stays at 3 days, Harsh Nov 4)
export function dueDaysFor(deal, today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)) {
  const want = termsDueDays(deal.paymentTerms);
  if (!want) return DUE_DAYS;
  const live = String(deal.linksSent || deal.delivered || '').slice(0, 10);
  if (live && (Date.parse(today) - Date.parse(live)) / 864e5 > want) return DUE_DAYS;
  return want;
}
// Upfront is due once signed (or script approved when the terms say so); the rest once posted
// Video approved by the brand (stage Approved), not live yet, no company details on file and no final invoice yet
export function earlyBillingAsk(deal, list = []) {
  if (!deal || deal.stage !== 'Approved' || deal.paused || deal.channel === 'WhatsApp' || !deal.brandEmail) return false;
  if (!Number(deal.finalRate) || readBilling(deal.billing)) return false;
  return !list.some((i) => i.part === 'final' || i.part === 'extra');
}
export function partDue(deal, part, terms) {
  if (part === 'final') {
    // Split terms ("50% upon script approval, 50% after publication"): the final share needs the video live. The brand's
    // invoice request and the Invoiced stage both come from the UPFRONT share, so neither makes the final one due
    // (Manyfast x Chris, Nov 18: the upfront $750 went to Jun on Nov 17 and an hour later a second "initial $750"
    // invoice email for the final share was drafted, 11 days before the Nov 28 publication; system check)
    const split = invoiceParts(terms).some((p) => p.part === 'upfront' && p.pct < 100);
    const live = deal.stage === 'Posted' || !!deal.linksSent || /https?:\/\//.test(deal.postedLinks || '');
    if (split) return live && deal.stage !== 'Paid';
    return deal.stage === 'Posted' || (deal.invoiceRequested && atOrAfter(deal.stage, 'Submitted') && deal.stage !== 'Paid') || (deal.stage === 'Invoiced' && /upfront \|/.test(deal.stripeInvoices || ''));
  }
  const atScript = /script approv/i.test(terms || '');
  return atScript ? atOrAfter(deal.stage, 'Script Approved') : atOrAfter(deal.stage, 'Signed') && deal.stage !== 'Price Agreed';
}
// "upfront | in_123 | sent | 1000\nfinal | in_456 | draft | 1000"
// What Stripe itself says about a deal's invoices: the only source that may call a deal paid without proof.
// Returns { known: false } when there is no Stripe invoice to look at, else { known, paid, open, dueDates }.
export async function stripeState(deal) {
  // Only real Stripe invoices (in_...): a payment recorded by hand ("upfront | by-hand | paid | 2000") isn't in Stripe
  const list = readInvoices(deal?.stripeInvoices || '').filter((i) => /^in_/.test(i.id || ''));
  if (!list.length) return { known: false };
  const acct = await creatorStripe(deal.creator).catch(() => null);
  if (!acct) return { known: false };
  const out = { known: true, paid: [], open: [] };
  for (const i of list) {
    try { const inv = await stripe(acct.key, 'GET', `/invoices/${i.id}`); (inv.status === 'paid' ? out.paid : out.open).push(i.id); } catch { out.open.push(i.id); }
  }
  out.allPaid = out.open.length === 0 && out.paid.length > 0;
  return out;
}

// The brand sent a payment receipt (bank transfer outside the Stripe link): close the deal's open Stripe invoices as
// "paid outside Stripe" so Stripe stops its own reminders and the books match. Never touches drafts or voided ones.
export async function closeStripePaidOutside(deal) {
  const list = readInvoices(deal?.stripeInvoices || '');
  const open = list.filter((i) => i.id && i.status === 'sent');
  if (!open.length) return [];
  const acct = await creatorStripe(deal.creator).catch(() => null);
  if (!acct) return [];
  const done = [];
  for (const i of open) {
    try {
      const inv = await stripe(acct.key, 'GET', `/invoices/${i.id}`);
      if (inv.status === 'open') await stripe(acct.key, 'POST', `/invoices/${i.id}/pay`, { paid_out_of_band: true });
      if (['open', 'paid'].includes(inv.status)) { i.status = 'paid'; done.push(i.id); }
    } catch (e) { console.error('close stripe invoice', i.id, e.message); }
  }
  if (done.length) await setDeal(deal.id, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) } }).catch(() => {});
  return done;
}

// Which creators' Stripe accounts can take bank transfers on invoices (so wire payments land in Stripe and get matched)
export async function bankTransferReport() {
  const rows = await queryAll(ACCOUNTS_DS, undefined, { useCache: false }).catch(() => []);
  const out = [];
  for (const r of rows) {
    const creator = plain(r.properties?.Creator);
    if (!creator || plain(r.properties?.Status) !== 'Connected') continue;
    const acct = await creatorStripe(creator).catch(() => null);
    if (!acct) continue;
    const line = { creator, account: acct.account };
    try {
      const a = await stripe(acct.key, 'GET', '/account');
      line.country = a.country; line.currency = a.default_currency;
      line.bankTransfer = a.capabilities?.bank_transfer_payments || 'not requested';
    } catch (e) { line.error = String(e.message).slice(0, 120); }
    try {
      const c = await stripe(acct.key, 'GET', '/payment_method_configurations', { limit: 5 });
      const def = (c.data || []).find((x) => x.is_default) || (c.data || [])[0];
      if (def?.customer_balance) line.onInvoices = def.customer_balance.display_preference?.value || (def.customer_balance.available ? 'available' : 'unavailable');
    } catch (e) { line.configError = String(e.message).slice(0, 100); }
    out.push(line);
  }
  return out;
}

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
// Creators who number their invoices their own way. Valeri (Nov 9): plain numbers, the next one is 10000000016, then
// 10000000017 and so on. The next is the highest of these already used on her deals + 1, never below the start.
export const NUMBERING = { valeri: { first: 10000000016 } };
export function nextNumberFor(creator, values = []) {
  const own = NUMBERING[String(creator || '').trim().toLowerCase()];
  if (!own) return formatInvoiceNumber(highestInvoiceNumber(values) + 1);
  let max = 0;
  for (const v of values) for (const m of String(v || '').matchAll(/\b(\d{8,})\b/g)) max = Math.max(max, Number(m[1]));
  return String(Math.max(own.first, max + 1));
}
export async function nextInvoiceNumber(creator) {
  const rows = await queryAll(DS.deals, { property: 'Creator', select: { equals: creator } }, { useCache: false });
  return nextNumberFor(creator, rows.map((p) => plain(p.properties?.['Invoice Number'])));
}
// The creator's own VAT number, read from "VAT number: BG208339346" in their Company Details (Creator Cut), printed on
// every invoice as its own field. "VAT ID: none" means none.
export function sellerVat(companyDetails) {
  const m = String(companyDetails || '').match(/\bVAT(?:\s*(?:number|no\.?|id|#))?\s*[:\-]\s*([A-Z]{2}[A-Z0-9]{6,14})\b/i);
  return m ? m[1].toUpperCase() : '';
}
async function invoiceFields(creator, bill = {}) {
  const vat = sellerVat((await creatorBilling(creator).catch(() => ({}))).company);
  return [vat ? { name: 'VAT number', value: vat } : null, bill.tax_id ? { name: 'Client Tax ID', value: String(bill.tax_id).slice(0, 140) } : null, bill.contact_name ? { name: 'Attn', value: String(bill.contact_name).slice(0, 140) } : null].filter(Boolean);
}
async function recordInvoiceNumber(dealId, number) {
  const page = await notion('GET', `/pages/${dealId}`);
  const had = plain(page.properties?.['Invoice Number']) || '';
  await setDeal(dealId, { 'Invoice Number': { rich_text: rt([had, number].filter(Boolean).join(', ')) } });
}

// Draft a Stripe invoice in the creator's account for one part of the deal
// The creator's bank details written out, from the deal's "Payment Details" field or the creator's setting in Vercel
// (PAYMENT_DETAILS_DUNCAN etc.), for brands that pay by bank transfer
// The creator's own company and payment details, kept on their row in Creator Cut (Duncan: The Build Room Inc., PayPal)
export async function creatorBilling(creator) {
  const rows = await queryAll(DS.cuts).catch(() => []);
  const r = rows.find((p) => String(plain(p.properties?.Creator) || '').trim().toLowerCase() === String(creator || '').trim().toLowerCase());
  return { company: String(plain(r?.properties?.['Company Details']) || '').trim(), payment: String(plain(r?.properties?.['Payment Details']) || '').trim() };
}
// A creator's bank or PayPal details, saved once for every future invoice (Creator Cut row; one is added for a creator
// who has none yet, with no cut). Before Nov 5 the WhatsApp flow saved them only on the one deal, so it asked again.
export async function saveCreatorPayment(creator, text, source = 'in chat') {
  // Kept for Harsh to check in Creator Payment Details; never used on an invoice until he ticks Verified (Nov 16)
  const { savePendingPayment } = await import('./invoiceguard.js');
  return savePendingPayment(creator, text, source);
}
export async function oldSaveCreatorPayment(creator, text) {
  const t = String(text || '').trim();
  if (!creator || !t) return false;
  const rows = await queryAll(DS.cuts, undefined, { useCache: false }).catch(() => []);
  const row = rows.find((p) => String(plain(p.properties?.Creator) || '').trim().toLowerCase() === String(creator).trim().toLowerCase());
  const pay = { 'Payment Details': { rich_text: rt(t) } };
  if (row) { await notion('PATCH', `/pages/${row.id}`, { properties: pay }); return true; }
  for (const creatorProp of [{ title: rt(creator) }, { select: { name: creator } }, { rich_text: rt(creator) }]) {
    try { await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.cuts }, properties: { Creator: creatorProp, ...pay } }); return true; } catch { /* try the next property type */ }
  }
  return false;
}
// What the invoice PDF and email carry as text: who is billing and how to pay. Brands' finance teams need this in
// writing (Mediacube: "should be in text, QR codes or links don't work")
export async function invoiceText(deal, { withPayment = false } = {}) {
  const cb = await creatorBilling(deal?.creator).catch(() => ({ company: '', payment: '' }));
  // Payment details only from the Creator Payment Details table, and only a row Harsh marked Verified (INV-001, Nov 10:
  // details that weren't Chris's went on his invoice and the money went to someone else)
  const { creatorPayment } = await import('./invoiceguard.js');
  // Stripe invoices are paid through the pay link: bank or PayPal details go only on a PDF for an upload platform, or in
  // a reply when the brand asks for them (Harsh, Nov 16: "first the Stripe link... if they want bank details, share them")
  const pay = withPayment ? (await creatorPayment(deal?.creator).catch(() => ({ text: '' }))).text : '';
  return [cb.company ? `From:\n${cb.company}` : '', pay ? `Payment details:\n${pay}` : ''].filter(Boolean).join('\n\n');
}
// Only verified rows of the Creator Payment Details table: details on the deal, in Creator Cut or in Vercel are never
// printed (Nov 16). Async now, so every caller waits for the table.
export async function paymentDetails(deal) {
  const { creatorPayment } = await import('./invoiceguard.js');
  return (await creatorPayment(deal?.creator).catch(() => ({ text: '' }))).text;
}

export async function createStripeInvoice(deal, part, pct, { amountUsd, billing, number: givenNumber, dueDays, withPayment = false } = {}) {
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
  const label = `${deal.deliverables || 'Sponsored video'} (${deal.creator} x ${deal.brand})`.slice(0, 480);
  const number = givenNumber || await nextInvoiceNumber(deal.creator);
  const text = await invoiceText(deal, { withPayment }).catch(() => '');
  const inv = await stripe(acct.key, 'POST', '/invoices', {
    number,
    customer: customer.id, collection_method: 'send_invoice', days_until_due: dueDays > 0 ? dueDays : DUE_DAYS, currency: 'usd', auto_advance: 'false', pending_invoice_items_behavior: 'exclude',
    description: pct < 100 ? `${part === 'upfront' ? 'Upfront' : 'Final'} payment, ${pct}% of the agreed fee` : undefined,
    custom_fields: await invoiceFields(deal.creator, bill),
    // Payment details as plain text on the PDF: some finance teams can't use pay links or QR codes (Mediacube)
    ...(text ? { footer: text.slice(0, 4900) } : {}),
    metadata: { noocap_deal: deal.id, part, ...(withPayment ? { pdf_platform: '1' } : {}) },
  });
  await stripe(acct.key, 'POST', '/invoiceitems', { customer: customer.id, invoice: inv.id, amount, currency: 'usd', description: label });
  if (!givenNumber) await recordInvoiceNumber(deal.id, number).catch(() => {});
  return { id: inv.id, amount: amount / 100, account: acct.account, number };
}

// Called when Harsh approves the invoice email: finalize it in Stripe and hand back the pay link and PDF
export async function finalizeForSend(creator, invoiceId) {
  const acct = await creatorStripe(creator);
  if (!acct) throw new Error(`${creator}'s Stripe is not connected any more`);
  let inv = await stripe(acct.key, 'GET', `/invoices/${invoiceId}`);
  // Drafts raised before the creator's details were on file get them now, so the PDF always carries them as text
  if (inv.status === 'draft') {
    try {
      const dealId = inv.metadata?.noocap_deal;
      const page = dealId ? await notion('GET', `/pages/${dealId}`) : null;
      const text = await invoiceText({ creator }, { withPayment: inv.metadata?.pdf_platform === '1' });
      // also clears details an older draft printed that aren't verified any more
      if ((inv.footer || '') !== text) inv = await stripe(acct.key, 'POST', `/invoices/${invoiceId}`, { footer: text.slice(0, 4900) });
    } catch (e) { console.error('invoice footer', e.message); }
    inv = await stripe(acct.key, 'POST', `/invoices/${invoiceId}/finalize`, { auto_advance: 'false' });
  }
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
      // An invoice already sent by hand keeps its number and due date, so the PDF and the Stripe pay page match
      const existing = String(g('Invoice Number') || '').split(',').map((x) => x.trim()).filter(Boolean).pop();
      const due = g('Invoice Due Date');
      const dueDays = due ? Math.max(1, Math.round((Date.parse(String(due).slice(0, 10)) - Date.now()) / 864e5)) : 0;
      const inv = await createStripeInvoice(deal, 'extra', 100, { amountUsd: amount, billing: readBilling(deal.billing) || undefined, number: existing || undefined, dueDays });
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
// Invoices raised by hand or as a pay link (part "extra") that add up to the agreed fee cover the whole deal
export function coveredByExtra(list, finalRate) {
  const rate = Number(finalRate) || 0;
  const extra = list.filter((i) => i.part === 'extra' && i.status !== 'void').reduce((a, i) => a + (Number(i.amount) || 0), 0);
  return rate > 0 && extra >= rate - 1;
}

// Rejecting an invoice email in Approvals throws the Stripe draft away too, so the PM doesn't draft its email again:
// the draft invoice is deleted in the creator's Stripe (only drafts can be), taken off the deal and its number freed
export async function discardDraftInvoice(dealId, ref) {
  const [, invId] = String(ref || '').split('|').map((x) => x.trim());
  if (!dealId || !invId) return false;
  const page = await notion('GET', `/pages/${dealId}`);
  const list = readInvoices(plain(page.properties?.['Stripe Invoices']));
  const row = list.find((i) => i.id === invId);
  if (!row || row.status !== 'draft') return false;
  const creator = plain(page.properties?.Creator);
  let number = '';
  try {
    const acct = await creatorStripe(creator);
    if (acct) {
      const inv = await stripe(acct.key, 'GET', `/invoices/${invId}`);
      number = inv.number || '';
      if (inv.status === 'draft') await stripe(acct.key, 'DELETE', `/invoices/${invId}`);
    }
  } catch { /* still take it off the deal */ }
  const nums = String(plain(page.properties?.['Invoice Number']) || '').split(',').map((x) => x.trim()).filter((x) => x && x !== number);
  await setDeal(dealId, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list.filter((i) => i.id !== invId))) }, ...(number ? { 'Invoice Number': { rich_text: rt(nums.join(', ')) } } : {}) });
  return true;
}

export const NO_STRIPE = String(process.env.NO_STRIPE_CREATORS || 'Brad').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);

// Which deals the invoicing step looks at first: a brand that asked for the invoice, then deals with an invoice out
// (payments to notice), then the rest. Pure.
// Deals that need something sent (invoice asked for, or approved/posted with no company details or invoice yet) go first;
// payment checks on sent invoices are slow Stripe calls, so they come after. The step runs out of time at the end of the
// list, and Dreamina x Chris sat last: approved, then posted, and no billing request went out (Harsh, Nov 18)
const openDeal = (d) => !['Paid', 'Lost'].includes(d.stage);
export const needsBillingAsk = (d) => openDeal(d) && !d.paused && ['Approved', 'Posted'].includes(d.stage) && !readBilling(d.billing) && !d.billingRequested && !/(^|\n)(final|extra) \|/.test(d.stripeInvoices || '');
export function invoiceOrder(deals) {
  const rank = (d) => (d.invoiceRequested && openDeal(d) ? 0 : needsBillingAsk(d) ? 1 : d.stripeInvoices ? 2 : 3);
  return [...deals].sort((a, b) => rank(a) - rank(b));
}

// The Stripe drafts that should have an invoice email now. Pure. A draft for a share that is not due yet (the final
// 50% before the video is live) gets none: Manyfast x Chris, Nov 19, the final draft made on Nov 17 outlived its
// rejected email and step 3 wrote a new final-invoice email at 00:17 UTC while the video was still in changes (bug hunter).
// A hand pay link ("extra") is always Harsh's own and keeps its email.
export function draftsToEmail(deal, list = []) {
  return list.filter((i) => i.status === 'draft' && (i.part === 'extra' || partDue(deal, i.part, deal.paymentTerms)));
}

export async function runInvoicing(deals, { draft, say, late = () => false }) {
  const out = { asked: [], drafted: [], paid: [], waiting: [] };
  if (!process.env.PAYMENT_KEYS_SECRET) return out;
  let overtime = 0;
  for (const deal of deals) {
    // A billing-details ask is one short email: up to 2 still go out after the time is up, so a deal that just got
    // approved or posted isn't pushed to the next run again and again (Dreamina x Chris, Nov 18: three runs in a row
    // ran out of time before reaching it)
    if (late() && !(needsBillingAsk(deal) && overtime++ < 2)) { if (!out.waiting.includes('out of time: the rest wait for the next run')) out.waiting.push('out of time: the rest wait for the next run'); continue; }
    // The brand asked for the invoice but it can't be raised on its own: say exactly what's missing, once
    if (deal.invoiceRequested && !deal.paused && deal.channel !== 'WhatsApp' && !['Lost', 'Paid', 'Invoiced'].includes(deal.stage)) {
      // Creators who invoice outside Stripe (Brad) are never flagged for a missing Stripe account: Harsh handles theirs by hand
      if (NO_STRIPE.includes(String(deal.creator || '').toLowerCase())) continue;
      const missing = [!Number(deal.finalRate) && 'the fee (Final Rate USD)', !deal.brandEmail && 'the brand email', !(await creatorStripe(deal.creator).catch(() => null)) && `${deal.creator}'s Stripe account`].filter(Boolean);
      const na = missing.length ? `Brand asked for the invoice: add ${missing.join(' and ')} on this deal and the PM raises it` : '';
      if (na && deal.nextAction !== na) {
        await setDeal(deal.id, { 'Next Action': { rich_text: rt(na) } }).catch(() => {});
        await say(`🧾 **${deal.brand} × ${deal.creator} asked for the invoice**, but I can't raise it yet: add ${missing.join(' and ')} on the deal and it goes out. ${deal.url || ''}`).catch(() => {});
        out.waiting.push(`${deal.brand} × ${deal.creator}: invoice requested, missing ${missing.join(', ')}`);
      }
    }
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
        // The Revenue sheet is ticked too, so the money shows as Paid on the dashboard (Manyfast x Duncan, Nov 19: paid in
        // Stripe on Nov 18, deal marked Paid, but the Revenue row still sat under Awaiting payment)
        if (allPaid) { try { const { markRevenuePaid } = await import('./inbox.js'); await markRevenuePaid(deal, { amount: list.filter((i) => i.status === 'paid').reduce((a, i) => a + (Number(i.amount) || 0), 0) || inv.amount_paid / 100, currency: 'usd', paid_date: todayIST() }); } catch (e) { console.error('revenue mark after Stripe paid', e.message); } }
        await say(`💸 **Paid: ${deal.brand} × ${deal.creator}** · $${inv.amount_paid / 100} (${x.part}) through ${deal.creator}'s Stripe${allPaid ? (cut > 0 ? `. Deal marked Paid, collect the NOOCAP cut (${cut}%).` : '. Deal marked Paid. No NOOCAP cut for this creator.') : ''}`).catch(() => {});
      } catch { /* try again next tick */ }
    }
    // 2. Parts that are due and not raised yet
    // A hand-sent invoice with a pay link ("extra") that covers the whole fee means nothing else is due
    const due = coveredByExtra(list, deal.finalRate) ? [] : invoiceParts(deal.paymentTerms).filter((p) => partDue(deal, p.part, deal.paymentTerms) && !list.some((i) => i.part === p.part));
    const waitingDraft = list.some((i) => i.status === 'draft');
    // The brand approved the video and it isn't live yet: ask for the company details now, so the invoice can go out
    // together with the live link instead of a second round-trip after posting (Harsh, Nov 18: Dreamina x Chris, Jenny
    // said "please publish" and nobody asked for billing details)
    if (!due.length && !waitingDraft && earlyBillingAsk(deal, list)) {
      const asked = deal.billingRequested && daysSince(deal.billingRequested) < 3;
      if (!asked && !(deal.billingReminders >= 3) && !NO_STRIPE.includes(String(deal.creator || '').toLowerCase()) && (await creatorStripe(deal.creator).catch(() => null))) {
        // Harsh, Nov 18: this one goes out on its own, as the fixed "billing_on_approval" reply, no approval needed
        let ok = false;
        try {
          const R = await import('./replytemplates.js');
          const r = await R.sendTemplateToDeal(deal.id, 'billing_on_approval');
          ok = r.sent || /already went/.test(r.why || '');
          if (!ok) out.waiting.push(`${deal.brand} × ${deal.creator}: billing ask on approval not sent (${r.why})`);
        } catch (e) { out.waiting.push(`${deal.brand} × ${deal.creator}: billing ask on approval failed (${String(e.message).slice(0, 100)})`); }
        if (ok) { await setDeal(deal.id, { 'Billing Request Sent': { date: { start: todayIST() } }, 'Billing Reminders Sent': { number: (deal.billingReminders || 0) + 1 } }); out.asked.push(`${deal.brand} × ${deal.creator} (video approved, sent)`); }
      }
      continue;
    }
    if (!due.length && !waitingDraft) continue;
    // A deal already invoiced by hand (creator's own invoice) is left alone
    if (due.length && deal.invoiceSent && !list.length && !(due[0].part === 'final' && invoiceParts(deal.paymentTerms).length > 1)) {
      // ...but a posted video whose brand has sent its company details is waiting on the rest of the fee: say so once
      // instead of skipping in silence (Gamut x Lindsay, Nov 18: upfront invoiced by hand, no Payment Terms, so the
      // second invoice Iddo asked for was never raised and nobody was told)
      const na = `Upfront was invoiced by hand: raise the rest of the fee for ${deal.brand} (posted, billing details in) from the Invoices page`;
      if (deal.stage === 'Posted' && readBilling(deal.billing) && deal.nextAction !== na) {
        await setDeal(deal.id, { 'Next Action': { rich_text: rt(na) } }).catch(() => {});
        await say(`🧾 **${deal.brand} × ${deal.creator}**: the video is posted and the brand sent its company details, but the first invoice was sent by hand and the deal has no Payment Terms, so I won't guess the second one. Raise it from the Invoices page (or tell me the amount). ${deal.url || ''}`).catch(() => {});
        out.waiting.push(`${deal.brand} × ${deal.creator}: hand-invoiced upfront, rest of the fee needs Harsh`);
      }
      continue;
    }
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
    // The final invoice goes with the live link (Gamut x Lindsay, Nov 18: "send the invoice together with the live
    // link"): take it from the video card (YT/IG/TikTok Link), else wait and tell Harsh once where to add it
    if (!waitingDraft && due[0]?.part === 'final' && !/https?:\/\//.test(deal.postedLinks || '')) {
      const links = deal.linkedVideo ? await cardLinks(deal.linkedVideo).catch(() => '') : '';
      if (links) { await setDeal(deal.id, { 'Posted Links': { rich_text: rt(links.slice(0, 1900)) } }).catch(() => {}); deal.postedLinks = links; }
      else {
        const na = `Add the live link (YT Link / IG Link) on the ${deal.brand} video card: the final invoice goes out with it`;
        if (deal.nextAction !== na) { await setDeal(deal.id, { 'Next Action': { rich_text: rt(na) } }).catch(() => {}); await say(`🔗 **${deal.brand} × ${deal.creator}**: the final invoice is ready to raise, but there's no live link on the video card. Paste it in YT Link (or IG Link) on the card and the invoice goes to Approvals with it. ${deal.linkedVideo || deal.url || ''}`).catch(() => {}); }
        out.waiting.push(`${deal.brand} × ${deal.creator}: final invoice waiting for the live link`);
        continue;
      }
    }
    for (const p of due.filter(() => !waitingDraft).slice(0, 1)) {
      try {
        const inv = await createStripeInvoice(deal, p.part, p.pct, { dueDays: dueDaysFor(deal) });
        list.push({ part: p.part, id: inv.id, status: 'draft', amount: inv.amount });
        await setDeal(deal.id, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) }, 'Invoice Amount': { number: inv.amount } });
      } catch (e) { out.waiting.push(`${deal.brand} × ${deal.creator}: ${String(e.message).slice(0, 120)}`); }
    }
    // 2b. A draft made before the terms were known keeps Stripe's 3-day default: bring it in line with the contract
    const want = dueDaysFor(deal);
    if (want) for (const x of list.filter((i) => i.status === 'draft')) {
      try { const cur = await stripe(acct.key, 'GET', `/invoices/${x.id}`); if (cur.status === 'draft' && cur.days_until_due !== want) await stripe(acct.key, 'POST', `/invoices/${x.id}`, { days_until_due: want }); } catch { /* next tick */ }
    }
    // 3. Every Stripe draft whose part is due has its email in Approvals (made again if the first try didn't get one)
    for (const x of draftsToEmail(deal, list)) {
      const pct = invoiceParts(deal.paymentTerms).find((p) => p.part === x.part)?.pct || 100;
      const ok = await draft('Invoice', deal, {
        why: `Invoice for $${x.amount} (${pct < 100 ? `${x.part}, ${pct}% of $${deal.finalRate}` : 'full fee'}) is drafted in ${deal.creator}'s Stripe (${acct.account}) for ${bill.company_name}. Approving finalizes it in Stripe and sends the pay link and PDF.`,
        facts: { amount: `$${x.amount}`, part: pct < 100 ? `${x.part} payment (${pct}%)` : 'full fee', billed_to: bill.company_name, pay_link: '{{invoice_link}}', deliverables: deal.deliverables, posted_links: deal.postedLinks }, // Stripe invoices are paid through the pay link only, so no payment details block (Harsh, Nov 15)
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
  // Invoice emails waiting in Approvals, by deal: the Invoices page shows them and can raise + send in one click
  const drafts = new Map();
  try {
    const { OUTBOX_DS } = await import('./outbox.js');
    const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { and: [{ property: 'Kind', select: { equals: 'Invoice' } }, { property: 'Status', select: { equals: 'Draft' } }] } });
    for (const p of r.results || []) {
      const dealId = (p.properties?.Deal?.relation || [])[0]?.id;
      if (dealId) drafts.set(dealId.replace(/-/g, ''), { id: p.id, to: plain(p.properties?.To) || '', cc: plain(p.properties?.Cc) || '', subject: plain(p.properties?.Subject) || '', body: plain(p.properties?.Body) || '' });
    }
  } catch { /* the page still loads without them */ }
  const bankReady = {};
  for (const d of deals) {
    if (d.channel === 'WhatsApp' || !Number(d.finalRate) || ['Lost', 'Inbound', 'Negotiating', 'Price Agreed'].includes(d.stage)) continue;
    const terms = invoiceParts(d.paymentTerms);
    const raised = readInvoices(d.stripeInvoices);
    const bill = readBilling(d.billing);
    // Invoiced by hand with a pay link that covers the fee: show that invoice, not a part still "being created"
    const handLink = coveredByExtra(raised, d.finalRate);
    const parts = handLink ? raised.filter((x) => x.part === 'extra').map((x) => ({ part: 'extra', pct: 100, amount: x.amount, status: x.status, say: `${STEP_TXT[x.status] || x.status} (sent by hand with a Stripe pay link)` })) : terms.map((t) => {
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
    const connected = !!creators.find((c) => c.name === d.creator)?.connected;
    if (!String(d.postedLinks || '').trim() && d.linkedVideo && parts.some((p) => p.status === 'due' || p.status === 'draft' || p.status === 'later')) d.postedLinks = await cardLinks(d.linkedVideo).catch(() => '');
    const draft = drafts.get(String(d.id).replace(/-/g, '')) || null;
    // The invoice guard: what the brand and creator actually wrote, checked before anything is raised (Nov 16)
    let guard = [];
    const live = parts.find((p) => p.status === 'draft') || parts.find((p) => p.status === 'due');
    if (live) { try { const { checkInvoice } = await import('./invoiceguard.js'); guard = (await checkInvoice(d, { amount: live.amount, pct: live.pct, body: draft?.body })).problems; } catch (e) { guard = [{ k: 'guard', ok: false, block: false, t: `Couldn't run the invoice checks (${String(e.message).slice(0, 80)})` }]; } }
    if (!(d.creator in bankReady)) { try { const { creatorPayment } = await import('./invoiceguard.js'); bankReady[d.creator] = (await creatorPayment(d.creator)).verified; } catch { bankReady[d.creator] = false; } }
    list.push({ bank_ready: bankReady[d.creator], id: d.id, brand: d.brand, creator: d.creator, url: d.url, stage: d.stage, rate: Number(d.finalRate), terms: d.paymentTerms || '', billed_to: bill?.company_name || '', connected, deadline: d.deadline || null, invoice_sent: d.invoice_sent || d.invoiceSent || null, invoice_due: d.invoiceDue || null, parts,
      billing: bill ? { company: bill.company_name || '', email: bill.email || '', address: bill.address || '', country: bill.country_code || '', tax_id: bill.tax_id || '', contact: bill.contact_name || '' } : null,
      posted_links: String(d.postedLinks || '').trim(), deliverables: d.deliverables || '', brand_email: d.brandEmail || '', draft,
      checks: [...raiseChecks(d, { bill, connected }), ...guard] });
  }
  return { enabled: !!process.env.PAYMENT_KEYS_SECRET, links_enabled: !!process.env.PM_PASSWORD, creators, deals: list };
}

// Harsh types or corrects the brand's billing details on the Invoices page (Nov 16). Marked as his, so the invoice
// guard knows they came from him and not from an AI guess.
export async function setDealBilling(dealId, b = {}) {
  const id = String(dealId || '').replace(/[^0-9a-f-]/gi, '');
  if (!id) throw new Error('deal missing');
  const clean = (v, n = 300) => String(v || '').trim().slice(0, n);
  const out = { company_name: clean(b.company, 200), email: clean(b.email, 200), address: clean(b.address, 400), country_code: clean(b.country, 2).toUpperCase(), tax_id: clean(b.tax_id, 100), contact_name: clean(b.contact, 120), by: 'Harsh (Invoices page)', at: new Date().toISOString().slice(0, 10) };
  if (!out.company_name) throw new Error('Add the company name');
  if (out.email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out.email)) throw new Error('That billing email looks wrong');
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  await notion('PATCH', `/pages/${id}`, { properties: { 'Billing Details': { rich_text: [{ type: 'text', text: { content: JSON.stringify(out).slice(0, 1900) } }] } } });
  // a Stripe draft already made for this deal gets the new billed-to details too
  try { await setBillingOnDraft(id, out); } catch { /* the next raise uses them */ }
  return { ok: true, billing: out };
}

// Harsh corrects or adds the posted links from the Invoices page: saved on the deal, used in the invoice email
export async function setPostedLinks(dealId, links) {
  const val = String(links || '').split(/\s+/).filter((u) => /^https?:\/\//.test(u)).join('\n');
  const id = String(dealId || '').replace(/[^0-9a-f-]/gi, '');
  if (!id) throw new Error('deal missing');
  await notion('PATCH', `/pages/${id}`, { properties: { 'Posted Links': { rich_text: val ? [{ type: 'text', text: { content: val.slice(0, 1900) } }] : [] } } });
  return { ok: true, links: val };
}

// The posted links written on the video card itself (IG Link, YT Link, TikTok Link, Posted URL)
async function cardLinks(url) {
  const id = (String(url).match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1];
  if (!id) return '';
  const page = await notion('GET', `/pages/${id}`);
  return Object.entries(page.properties || {}).filter(([n, p]) => p.type === 'url' && p.url && (/posted/i.test(n) || /^(ig|instagram|yt|youtube|tiktok|tt)\b/i.test(n))).map(([, p]) => p.url).join('\n');
}

// What must be true before an invoice can be raised and sent from the Invoices page (Harsh, Nov 15: "once I confirm
// the details, that it has all the details like the posted links")
// The part of the fee to invoice now. Pure. An upfront share (terms like "50% upon script approval") that is due and
// not raised yet comes first and needs no posted video (Harsh, Nov 17, Manyfast x Chris: "he's asking for 50% payment
// so we can send the Stripe link, we can't block this"); otherwise whatever is still owed on the fee.
export function dueNow(d) {
  const fee = Number(d.finalRate) || 0;
  const list = readInvoices(d.stripeInvoices);
  const up = invoiceParts(d.paymentTerms).find((p) => p.part === 'upfront' && p.pct < 100);
  if (up && fee && !list.some((i) => i.part === 'upfront') && partDue(d, 'upfront', d.paymentTerms)) return { part: 'upfront', pct: up.pct, amount: Math.round(fee * up.pct) / 100 };
  const owed = Math.round((fee - list.reduce((n, x) => n + (Number(x.amount) || 0), 0)) * 100) / 100;
  return { part: list.some((i) => i.part === 'upfront') ? 'final' : 'extra', pct: fee ? Math.round((owed / fee) * 10000) / 100 : 100, amount: owed };
}

export function raiseChecks(d, { bill, connected }) {
  const now = dueNow(d);
  // The upfront share is paid before the video exists: posting and posted links don't apply to it
  if (now.part === 'upfront') {
    return [
      { k: 'posted', ok: true, t: `Upfront ${now.pct}% ($${now.amount}) is due now (${d.paymentTerms}): no posted video needed` },
      { k: 'billing', ok: !!bill?.company_name, t: bill?.company_name ? `Billing details from the brand (${bill.company_name})` : 'No billing details from the brand yet' },
      { k: 'stripe', ok: connected, t: connected ? `${d.creator}'s Stripe connected` : `${d.creator} hasn't connected Stripe` },
      { k: 'amount', ok: Number(d.finalRate) > 0, t: Number(d.finalRate) > 0 ? `Fee $${Number(d.finalRate)}` : 'No fee on the deal' },
      { k: 'thread', ok: !!(d.threadId && d.messageRfc && d.brandEmail), t: d.threadId && d.messageRfc ? 'Replies in the brand\'s email thread' : 'No email thread on the deal' },
    ];
  }
  const posted = d.stage === 'Posted' || /^(Invoiced|Paid)$/.test(d.stage || '') || !!String(d.postedLinks || '').trim();
  return [
    { k: 'posted', ok: posted, t: posted ? 'Video posted' : 'Video not posted yet' },
    { k: 'links', ok: !!String(d.postedLinks || '').trim(), t: String(d.postedLinks || '').trim() ? 'Posted links saved' : 'No posted links on the deal yet' },
    { k: 'billing', ok: !!bill?.company_name, t: bill?.company_name ? `Billing details from the brand (${bill.company_name})` : 'No billing details from the brand yet' },
    { k: 'stripe', ok: connected, t: connected ? `${d.creator}'s Stripe connected` : `${d.creator} hasn't connected Stripe` },
    { k: 'amount', ok: Number(d.finalRate) > 0, t: Number(d.finalRate) > 0 ? `Fee $${Number(d.finalRate)}` : 'No fee on the deal' },
    { k: 'thread', ok: !!(d.threadId && d.messageRfc && d.brandEmail), t: d.threadId && d.messageRfc ? 'Replies in the brand\'s email thread' : 'No email thread on the deal' },
    ...platformChecks(d),
  ];
}

// Every platform the deliverables name needs its link before the invoice goes (Readdy x Lindsay, Nov 15: Instagram +
// YouTube Shorts were agreed, only the reel link was on the deal). "no TikTok" / "not TikTok" doesn't count as a platform.
export function platformChecks(d) {
  const del = String(d.deliverables || '').replace(/\b(no|not|without|except)\s+(on\s+)?(tiktok|youtube( shorts)?|instagram)\b/gi, '');
  const links = String(d.postedLinks || '');
  const want = [['youtube', /youtube|shorts/i, /youtu/i, 'YouTube'], ['tiktok', /tiktok/i, /tiktok\.com/i, 'TikTok'], ['instagram', /instagram|\bIG\b|reel/i, /instagram\.com/i, 'Instagram']];
  return want.filter(([, need]) => need.test(del)).map(([k, , has, name]) => ({ k: `link-${k}`, ok: has.test(links), t: has.test(links) ? `${name} link in` : `No ${name} link yet (the deal includes ${name})` }));
}

// Raise + send from the Invoices page: uses the invoice already drafted in Approvals, else drafts it in the creator's
// Stripe for what is still owed, then finalizes it in Stripe and emails the brand with the pay link and PDF.
export async function raiseAndSend(dealId, { mode = 'link' } = {}) {
  const { openDeals } = await import('./briefs.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(dealId).replace(/-/g, ''));
  if (!deal) throw new Error('deal not found');
  const bill = readBilling(deal.billing);
  const connected = !!(await creatorStripe(deal.creator).catch(() => null));
  const missing = raiseChecks(deal, { bill, connected }).filter((c) => !c.ok && c.k !== 'links');
  if (missing.length) throw new Error(`Can't raise it yet: ${missing.map((c) => c.t).join(', ')}`);
  {
    const raised = readInvoices(deal.stripeInvoices).filter((x) => x.status === 'draft');
    const now = dueNow(deal);
    const amount = raised[0]?.amount ?? now.amount;
    const pct = raised[0] ? (invoiceParts(deal.paymentTerms).find((p) => p.part === raised[0].part)?.pct || 100) : now.pct;
    const { checkInvoice, blocking } = await import('./invoiceguard.js');
    const stop = blocking((await checkInvoice(deal, { amount, pct })).problems);
    if (stop.length) throw new Error(`Not raised: ${stop.map((c) => c.t).join(' · ')}`);
  }
  const { OUTBOX_DS, approveAndSend } = await import('./outbox.js');
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: deal.id } }, { property: 'Kind', select: { equals: 'Invoice' } }, { property: 'Status', select: { equals: 'Draft' } }] } });
  let draftId = (r.results || [])[0]?.id;
  if (!draftId) {
    const now = dueNow(deal);
    if (!(now.amount > 0)) throw new Error('Nothing left to invoice on this deal');
    const made = await raiseInvoiceNow(deal.id, now.amount, { notify: false, part: now.part, pct: now.pct });
    draftId = made.draft;
    if (!draftId) throw new Error('The invoice was drafted in Stripe but its email could not be made. Send it from Approvals.');
  }
  if (mode === 'bank') await toBankInvoice(deal, draftId);
  return approveAndSend(draftId, {});
}

// The same invoice, paid by bank transfer or PayPal instead of the pay link (Harsh, Nov 16): the creator's verified
// details from Creator Payment Details are printed on the PDF and written in the email, and no pay link is added.
async function toBankInvoice(deal, draftId) {
  const G = await import('./invoiceguard.js');
  const row = await G.verifiedRow(deal.creator);
  if (!row || row.unverified) throw new Error(`${deal.creator} has no verified bank or PayPal details. Fill ${deal.creator}'s row in Creator Payment Details and tick Verified first`);
  const pick = G.pickDetails(row, 'any');
  if (!pick.details) throw new Error(`${deal.creator}'s row in Creator Payment Details has no details filled in`);
  const page = await notion('GET', `/pages/${draftId}`);
  const [part, invId] = String(plain(page.properties?.['Stripe Invoice']) || '').split('|');
  if (!invId) throw new Error('This invoice email has no Stripe invoice');
  const acct = await creatorStripe(deal.creator);
  // the PDF prints the details too (finalizeForSend reads this flag when it writes the footer)
  await stripe(acct.key, 'POST', `/invoices/${invId}`, { metadata: { pdf_platform: '1' } });
  const x = readInvoices(deal.stripeInvoices).find((i) => i.id === invId);
  const bill = readBilling(deal.billing) || {};
  const greet = (String(bill.contact_name || '').split(/\s+/)[0]) || 'there';
  const links = String(deal.postedLinks || '').split(/\s+/).filter((u) => /^https?:\/\//.test(u));
  const live = links.length ? `The ${deal.brand} video is live:\n${links.map((u) => `${/youtu/i.test(u) ? 'YouTube Shorts' : /instagram/i.test(u) ? 'Instagram' : /tiktok/i.test(u) ? 'TikTok' : 'Link'}: ${u}`).join('\n')}\n\n` : '';
  const body = `Hi ${greet},\n\n${live}Here is the invoice for $${Number(x?.amount || deal.finalRate).toLocaleString('en-US')}, with the PDF attached. You can pay it by ${pick.sent === 'PayPal' ? 'PayPal' : 'bank transfer'} using these details:\n\n${pick.details}\n\nPlease add the invoice number as the payment reference.\n\nBest,\n${deal.creator}'s Team`;
  const rt2 = (t) => { const out = []; for (let i = 0; i < t.length; i += 1900) out.push({ type: 'text', text: { content: t.slice(i, i + 1900) } }); return out; };
  await notion('PATCH', `/pages/${draftId}`, { properties: { Body: { rich_text: rt2(body) }, 'Stripe Invoice': { rich_text: [{ type: 'text', text: { content: `${part}|${invId}|bank` } }] }, Why: { rich_text: [{ type: 'text', text: { content: `Invoice by bank transfer: ${deal.creator}'s verified details from Creator Payment Details on the PDF and in the email (source: ${String(row.Source).slice(0, 80)}). No pay link.` } }] } } });
}



// Raise an invoice by hand for a deal (Harsh asked for a specific amount): draft it in the creator's Stripe and put
// the email in Approvals, in the deal's thread. Billing goes to the brand's saved details, else the brand name and email.
export async function raiseInvoiceNow(dealId, amountUsd, { notify = true, part = 'extra', pct = 100, dueDays = 0 } = {}) {
  const { openDeals } = await import('./briefs.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(dealId).replace(/-/g, ''));
  if (!deal) throw new Error('deal not found');
  const amount = Number(amountUsd);
  if (!(amount > 0)) throw new Error('amount must be a number above 0');
  const bill = readBilling(deal.billing) || { company_name: deal.brand, email: deal.brandEmail };
  const inv = await createStripeInvoice(deal, part, part === 'extra' ? 100 : pct, { amountUsd: amount, billing: bill, dueDays: dueDays || dueDaysFor(deal) });
  const list = readInvoices(deal.stripeInvoices);
  list.push({ part, id: inv.id, status: 'draft', amount: inv.amount });
  await setDeal(deal.id, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) }, 'Invoice Amount': { number: inv.amount } });
  const { writeEmail, createDraft } = await import('./outbox.js');
  const mail = await writeEmail({ kind: 'Invoice', deal, facts: { amount: `$${inv.amount}`, part: part === 'upfront' ? `the ${pct}% upfront payment (${deal.paymentTerms})` : 'the agreed fee', billed_to: bill.company_name, pay_link: '{{invoice_link}}', deliverables: deal.deliverables, posted_links: deal.postedLinks || undefined } });
  let body = String(mail.body);
  if (!body.includes('{{invoice_link}}')) body = body.replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\nYou can pay here: {{invoice_link}}\n${sig}`);
  if (!body.includes('{{invoice_link}}')) body += `\n\nYou can pay here: {{invoice_link}}`;
  const r = await createDraft({ kind: 'Invoice', deal, subject: mail.subject, body, why: `Invoice for $${inv.amount} drafted in ${deal.creator}'s Stripe (${inv.account}), billed to ${bill.company_name}${bill.email ? ' <' + bill.email + '>' : ''}. Sending finalizes it in Stripe and replies in the ${deal.brand} thread with the pay link and PDF.`, stripeInvoice: `${part}|${inv.id}`, notify });
  return { invoice: inv.id, amount: inv.amount, account: inv.account, billed_to: bill.company_name, draft: r.id || null, skipped: r.skipped || false };
}

// Invoice for a deal whose brand collects invoices on a platform instead of by email (Faved, creator.co: "upload an
// invoice as a PDF with our address and your bank or PayPal details", Semrush x Lindsay, Nov 5). Raised in the creator's
// Stripe, finalized with their payment details printed on it, and handed back as the PDF to upload. No email is drafted.
export async function invoicePdfForPlatform(dealId, { amountUsd, billingText, payment } = {}) {
  const { openDeals } = await import('./briefs.js');
  let deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(dealId).replace(/-/g, ''));
  if (!deal) throw new Error('deal not found');
  const props = {};
  if (String(payment || '').trim()) await saveCreatorPayment(deal.creator, payment, 'for a platform invoice').catch((e) => console.error('creator payment save', e.message));
  if (String(billingText || '').trim()) { props['Billing Details'] = { rich_text: rt(billingText) }; deal = { ...deal, billing: String(billingText).trim() }; }
  if (Object.keys(props).length) await setDeal(deal.id, props);
  if (!(await paymentDetails(deal))) throw new Error(`${deal.creator} has no verified bank or PayPal details. Harsh fills them in Creator Payment Details (from what ${deal.creator} sent) and ticks Verified, then the invoice can be made`);
  const bill = readBilling(deal.billing);
  if (!bill) throw new Error('no billing details for this invoice: pass who it is billed to as "Company: ... | Address: ..."');
  const amount = Number(amountUsd) || Number(deal.finalRate);
  if (!(amount > 0)) throw new Error('no amount: the deal has no Final Rate USD, so give the amount');
  const inv = await createStripeInvoice(deal, 'extra', 100, { amountUsd: amount, billing: bill, withPayment: true });
  const fin = await finalizeForSend(deal.creator, inv.id);
  if (!fin.pdf) throw new Error('Stripe made the invoice but the PDF could not be downloaded; it is in ' + deal.creator + "'s Stripe as " + (fin.number || inv.id));
  const list = readInvoices(deal.stripeInvoices);
  list.push({ part: 'extra', id: inv.id, status: 'open', amount: inv.amount });
  await setDeal(deal.id, { 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) }, 'Invoice Amount': { number: inv.amount }, 'Invoice Number': { rich_text: rt(fin.number || '') }, 'Next Action': { rich_text: rt(`Upload invoice ${fin.number || ''} (PDF sent on WhatsApp) where the brand asked, then tell the PM it is uploaded`) } }).catch(() => {});
  return { deal, number: fin.number, amount: fin.amount, billed_to: bill.company_name, pdf: fin.pdf };
}

// A look at the draft invoice before it is sent: what the brand will see, built from the draft in Stripe
// The same preview as a PDF, so it can be opened on WhatsApp next to the draft card (WhatsApp can't show HTML)
export async function previewInvoicePdf(creator, invoiceId, deal = null) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const acct = await creatorStripe(creator);
  if (!acct) throw new Error(`${creator}'s Stripe is not connected`);
  const inv = await stripe(acct.key, 'GET', `/invoices/${invoiceId}`, { 'expand[]': 'customer' });
  const c = typeof inv.customer === 'object' ? inv.customer : {};
  const usd = (cents) => '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const addr = c.address ? [c.address.line1, c.address.line2, c.address.city, c.address.state, c.address.postal_code, c.address.country].filter(Boolean).join(', ') : '';
  const from = deal ? await invoiceText(deal, { withPayment: inv.metadata?.pdf_platform === '1' }).catch(() => '') : (inv.footer || '');
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 56;
  let pg = doc.addPage([W, H]), y = H - M;
  const safe = (t) => String(t || '').normalize('NFKD').replace(/[^\x20-\x7E\n]/g, '');
  const line = (t, { size = 11, font = reg, color = rgb(0.1, 0.11, 0.13), x = M } = {}) => {
    for (const raw of safe(t).split('\n')) {
      let cur = '';
      for (const w of raw.split(' ')) { const nx = cur ? cur + ' ' + w : w; if (font.widthOfTextAtSize(nx, size) > W - x - M && cur) { pg.drawText(cur, { x, y: (y -= size * 1.45), size, font, color }); cur = w; } else cur = nx; }
      pg.drawText(cur, { x, y: (y -= size * 1.45), size, font, color });
      if (y < M + 40) { pg = doc.addPage([W, H]); y = H - M; }
    }
  };
  const muted = rgb(0.42, 0.45, 0.5);
  line('PREVIEW - draft, not sent yet. Stripe adds the number and PDF when you press Send.', { size: 8, color: rgb(0.6, 0.4, 0) });
  y -= 6; line('Invoice', { size: 24, font: bold });
  line(`${String(inv.currency || 'usd').toUpperCase()} - due ${inv.days_until_due || DUE_DAYS} days after sending`, { size: 10, color: muted });
  y -= 10; line('BILL TO', { size: 9, font: bold, color: muted });
  line(c.name || inv.customer_name || '', { font: bold }); if (c.email || inv.customer_email) line(c.email || inv.customer_email); if (addr) line(addr, { size: 10 });
  for (const f of inv.custom_fields || []) line(`${f.name}: ${f.value}`, { size: 10 });
  y -= 10;
  if (from) { for (const block of from.split('\n\n')) { const [head, ...rest] = block.split('\n'); line(head.replace(/:$/, '').toUpperCase(), { size: 9, font: bold, color: muted }); line(rest.join('\n'), { size: 10.5 }); y -= 8; } }
  else { line('FROM', { size: 9, font: bold, color: muted }); line(`${creator}'s business details from Stripe (added by Stripe when the invoice is sent)`); y -= 8; }
  if (inv.description) { line(inv.description, { size: 10.5 }); y -= 4; }
  pg.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 0.6, color: muted }); y -= 10;
  for (const l of inv.lines?.data || []) { const amt = usd(l.amount); line(l.description, { size: 10.5 }); pg.drawText(amt, { x: W - M - reg.widthOfTextAtSize(amt, 10.5), y, size: 10.5, font: reg }); }
  y -= 8; const tot = usd(inv.amount_due || inv.total); line('Total due', { size: 14, font: bold }); pg.drawText(tot, { x: W - M - bold.widthOfTextAtSize(tot, 14), y, size: 14, font: bold });
  const bytes = await doc.save();
  return { filename: 'Invoice preview.pdf', mimeType: 'application/pdf', data: Buffer.from(bytes).toString('base64') };
}

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
    const fields = await invoiceFields(deal.creator, billing);
    if (fields.length) await stripe(acct.key, 'POST', `/invoices/${x.id}`, { custom_fields: fields });
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

// The brand paid a Stripe invoice another way (bank transfer to the details on the PDF): Stripe can't see that,
// so Harsh presses Paid. The invoice is marked paid outside Stripe (so the pay link closes), the deal goes to Paid
// and the deal's unpaid revenue rows are ticked Paid.
export async function markPaidByHand(dealId) {
  const p = await notion('GET', `/pages/${dealId}`);
  const get = (n) => plain(p.properties?.[n]);
  const creator = get('Creator'), brand = get('Brand Name') || '';
  const list = readInvoices(get('Stripe Invoices'));
  const acct = list.some((i) => i.status === 'sent') ? await creatorStripe(creator).catch(() => null) : null;
  for (const x of list.filter((i) => i.status === 'sent')) {
    if (acct) { try { await stripe(acct.key, 'POST', `/invoices/${x.id}/pay`, { paid_out_of_band: 'true' }); } catch { /* still recorded as paid here */ } }
    x.status = 'paid';
  }
  const today = todayIST();
  await setDeal(dealId, { 'Deal Stage': { select: { name: 'Paid' } }, 'Paid Date': { date: { start: today } }, 'Stripe Invoices': { rich_text: rt(writeInvoices(list)) }, 'Next Action': { rich_text: rt('Paid outside Stripe (marked by hand)') } });
  const k = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
  const rows = await queryAll(DS.revenue, undefined, { useCache: false }).catch(() => []);
  let ticked = 0;
  for (const r of rows) {
    const t = `${plain(r.properties?.Brand) || ''} ${plain(r.properties?.['Video Title']) || ''}`;
    if (r.in_trash || plain(r.properties?.Paid) === true || String(plain(r.properties?.Creator) || '').toLowerCase() !== String(creator).toLowerCase()) continue;
    if (!plain(r.properties?.['Invoice Sent']) || !k(brand) || !k(t).includes(k(brand))) continue;
    await notion('PATCH', `/pages/${r.id}`, { properties: { Paid: { checkbox: true }, 'Payment Received': { date: { start: today } } } });
    ticked++;
  }
  return { ok: true, brand, creator, rows: ticked };
}
