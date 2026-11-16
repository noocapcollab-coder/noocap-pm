// Invoice guard (Harsh, Nov 16: "make sure we don't send wrong information to the brands").
// Every invoice is checked against what the brand and the creator actually wrote before it can be raised or sent:
//   1. payment details come only from the Creator Payment Details table, and only from a row Harsh marked Verified
//   2. the greeting names someone who signed one of the brand's emails, else "Hi there,"
//   3. the platforms on the deal are ones the brand asked for
//   4. the amount matches the agreed fee, the fee is in the emails, and the revenue sheet agrees
//   5. the billed-to company is one the brand gave us
//   6. posted links are real posts on the right platform, not used on another deal, and (YouTube) on the creator's
//      channel and posted after the deal began
// A contradiction blocks the invoice. Something that can't be checked (no emails on file) is shown as a warning on the
// Invoices page so Harsh looks at it before he clicks.
import { notion, plain, queryAll } from './notion.js';
import { DS } from './tools.js';

export const PAYMENT_DS = '41a508e9-9dda-8174-a6a4-000b93982149';
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9@.]+/g, ' ');

// ---------- 1. payment details ----------
const PAY_FIELDS = [['Account Holder Name', 'Account holder'], ['Bank Name', 'Bank'], ['Account Number / IBAN', 'Account number / IBAN'], ['Routing / SWIFT / IFSC / Sort Code', 'Routing / SWIFT'], ['Account Type', 'Account type'], ['Bank Address', 'Bank address'], ['PayPal Email', 'PayPal'], ['Currency', 'Currency']];
export function paymentText(row) {
  return PAY_FIELDS.map(([k, label]) => (String(row?.[k] || '').trim() ? `${label}: ${String(row[k]).trim()}` : '')).filter(Boolean).join('\n');
}
export async function creatorPayment(creator) {
  const rows = await queryAll(PAYMENT_DS, undefined, { useCache: false }).catch(() => []);
  const r = rows.find((p) => norm(plain(p.properties?.Creator)) === norm(creator));
  if (!r) return { verified: false, text: '', source: '', url: '' };
  const row = Object.fromEntries(Object.keys(r.properties || {}).map((k) => [k, plain(r.properties[k])]));
  const text = paymentText(row);
  const verified = (row.Verified === true || row.Verified === '__YES__') && !!text && !!String(row.Source || '').trim();
  return { verified, text: verified ? text : '', source: String(row.Source || ''), url: r.url, method: row.Method || '' };
}
// Details someone typed in chat or on WhatsApp are kept for Harsh to check, never used until he ticks Verified
export async function savePendingPayment(creator, text, source) {
  const t = String(text || '').trim();
  if (!creator || !t) return false;
  const rows = await queryAll(PAYMENT_DS, undefined, { useCache: false }).catch(() => []);
  const r = rows.find((p) => norm(plain(p.properties?.Creator)) === norm(creator));
  const props = { 'Old Details (unverified)': { rich_text: [{ type: 'text', text: { content: t.slice(0, 1900) } }] }, Notes: { rich_text: [{ type: 'text', text: { content: `Given ${source || 'in chat'} on ${new Date().toISOString().slice(0, 10)}. Not used on invoices until you copy them into the fields above and tick Verified.`.slice(0, 1900) } }] } };
  if (r) await notion('PATCH', `/pages/${r.id}`, { properties: props });
  else await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: PAYMENT_DS }, properties: { Creator: { title: [{ type: 'text', text: { content: creator } }] }, ...props } });
  return true;
}
// Bank or PayPal details written into an email body that aren't the creator's verified ones
const PAY_LINE = /\b(iban|swift|bic|routing|sort code|ifsc|account (?:number|no\.?|#)|acct|paypal)\b[^\n]*/gi;
export function strayPaymentDetails(body, verifiedText = '') {
  const v = norm(verifiedText);
  return [...String(body || '').replace(/<br\s*\/?>/gi, '\n').matchAll(PAY_LINE)].map((m) => m[0].trim())
    .filter((line) => { const digits = line.match(/[A-Z0-9@._-]{5,}/gi) || []; return digits.some((d) => !v.includes(norm(d))); });
}

// ---------- the brand's own words ----------
// Transcript lines: "📨 2026-11-12 · brand (Sophie Wilson <sophie@x.com>) · subject\ntext"
export function brandLines(convo) {
  return String(convo || '').split(/\n\n(?=📨 )/).filter((l) => /^📨 [^\n]*· brand \(/.test(l));
}
export function creatorLines(convo) {
  return String(convo || '').split(/\n\n(?=📨 )/).filter((l) => /^📨 [^\n]*· [^\n]*'s team ·/.test(l));
}

// ---------- 2. greeting ----------
// The first names that sign the brand's emails (sender name in the header, or a sign-off line)
export function brandSigners(convo) {
  const out = new Set();
  for (const l of brandLines(convo)) {
    const head = l.split('\n')[0];
    const from = (head.match(/· brand \(([^<)]+)/) || [])[1];
    if (from && /[a-z]/i.test(from) && !/@/.test(from)) out.add(from.trim().split(/\s+/)[0].replace(/["']/g, '').toLowerCase());
    const sign = l.match(/\n(?:best|thanks|thank you|regards|cheers|kind regards|best regards|warm regards|many thanks)[,!.]?\s*\n+\s*([A-Z][a-z]+)/i);
    if (sign) out.add(sign[1].toLowerCase());
  }
  return out;
}
export function fixGreeting(body, convo) {
  const b = String(body || '');
  const m = b.match(/^(\s*(?:hi|hello|hey|dear)\s+)([A-Z][\w'-]+)(\s+and\s+[A-Z][\w'-]+)?(\s*[,!])/i);
  if (!m || /^there$/i.test(m[2])) return { body: b, changed: false };
  const names = [m[2], ...(m[3] ? [m[3].replace(/^\s+and\s+/i, '')] : [])];
  const signers = brandSigners(convo);
  if (!signers.size) return { body: b, changed: false };
  if (names.every((n) => signers.has(n.toLowerCase()))) return { body: b, changed: false };
  return { body: b.replace(m[0], `${m[1].replace(/dear/i, 'Hi')}there${m[4]}`), changed: true, was: names.join(' and ') };
}

// ---------- 3-6 ----------
const PLATFORMS = [['YouTube', /youtube|\bshorts?\b|\byt\b/i], ['TikTok', /tik\s?tok/i], ['Instagram', /instagram|\bIG\b|\breels?\b/i]];
export function platformsIn(text) {
  const t = String(text || '').replace(/\b(no|not|without|except)\s+(on\s+)?(tik\s?tok|youtube( shorts)?|instagram)\b/gi, '');
  return PLATFORMS.filter(([, re]) => re.test(t)).map(([n]) => n);
}
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
// "$1,200", "1200 USD", "USD 1,200", "$1.2k", "1.2K"
export function amountsIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:\$|usd\s*|us\$\s*)\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?|(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*(?:usd|dollars|\$)/gi)) {
    const n = Number(String(m[1] || m[3]).replace(/,/g, '')) * ((m[2] || m[4]) ? 1000 : 1);
    if (n >= 50) out.add(Math.round(n * 100) / 100);
  }
  return out;
}
const POST_URL = { YouTube: /^https?:\/\/(www\.|m\.)?(youtube\.com\/(shorts\/|watch\?v=)[\w-]{11}|youtu\.be\/[\w-]{11})/i, Instagram: /^https?:\/\/(www\.)?instagram\.com\/(reel|reels|p)\/[\w-]+/i, TikTok: /^https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\/(@[\w.]+\/video\/\d+|[\w]+\/?$)/i };
export const platformOf = (u) => (/youtu/i.test(u) ? 'YouTube' : /instagram\.com/i.test(u) ? 'Instagram' : /tiktok\.com/i.test(u) ? 'TikTok' : '');
export const youtubeId = (u) => (String(u).match(/(?:shorts\/|watch\?v=|youtu\.be\/)([\w-]{11})/) || [])[1] || '';

// Pure: everything that can be judged from the deal, the emails and what was looked up
// facts: { deal, bill, amount, pct, convo, paymentOk, otherDealLinks: Set, youtube: { [id]: { channelId, at } }, channels: [ids], revenue: [amounts] }
export function invoiceProblems(f) {
  const { deal = {}, bill, convo = '' } = f;
  const out = [];
  const add = (k, ok, t, block = !ok) => out.push({ k, ok, t, block: !ok && block });
  const brandText = brandLines(convo).join('\n\n');
  const anyText = String(convo || '');
  const haveEmails = brandLines(convo).length > 0;

  // 4. amount
  const rate = Number(deal.finalRate) || 0;
  const pct = Number(f.pct) || 100;
  const expect = Math.round(rate * pct) / 100;
  if (f.amount != null && rate) add('amount-match', Math.abs(Number(f.amount) - expect) < 0.5, Math.abs(Number(f.amount) - expect) < 0.5 ? `Amount ${money(f.amount)} matches the agreed fee${pct < 100 ? ` (${pct}% of ${money(rate)})` : ''}` : `Amount ${money(f.amount)} doesn't match the agreed fee ${pct < 100 ? `(${pct}% of ${money(rate)} = ${money(expect)})` : money(rate)}`);
  if (rate) {
    const said = amountsIn(anyText);
    if (!haveEmails) add('amount-emails', false, `Couldn't check ${money(rate)} against the emails (none on file for this deal)`, false);
    // a fee agreed on a call or on WhatsApp is real too: a warning Harsh ticks, not a stop
    else add('amount-emails', said.has(rate), said.has(rate) ? `${money(rate)} is the fee agreed in the emails` : `${money(rate)} isn't anywhere in the emails${said.size ? ` (they mention ${[...said].slice(0, 4).map(money).join(', ')})` : ''}. Check the fee on the deal`, false);
  }
  if ((f.revenue || []).length && rate) {
    const ok = f.revenue.some((a) => Math.abs(a - rate) < 0.5);
    add('amount-revenue', ok, ok ? 'Revenue sheet agrees on the fee' : `Revenue sheet says ${f.revenue.map(money).join(' / ')}, the deal says ${money(rate)}`);
  }

  // 5. billed-to
  if (bill?.company_name) {
    const found = norm(brandText).includes(norm(bill.company_name)) || norm(anyText).includes(norm(bill.company_name));
    if (!haveEmails) add('billing-source', false, `Couldn't check "${bill.company_name}" against the brand's emails (none on file)`, false);
    else add('billing-source', found, found ? `Billed to ${bill.company_name}, as the brand wrote it` : `"${bill.company_name}" isn't in any of the brand's emails. Bill only what they sent`);
  }

  // 3. platforms
  const onDeal = platformsIn(deal.deliverables);
  if (onDeal.length && haveEmails) {
    const asked = platformsIn(brandText);
    const extra = onDeal.filter((p) => !asked.includes(p));
    add('platforms', !extra.length, !extra.length ? `Platforms match the brand's emails (${onDeal.join(', ')})` : `The deal lists ${extra.join(' and ')}, but the brand's emails never mention ${extra.length > 1 ? 'them' : 'it'}. Fix the deliverables`);
  }

  // 6. posted links
  const links = String(deal.postedLinks || '').split(/\s+/).filter((u) => /^https?:\/\//.test(u));
  for (const u of links) {
    const p = platformOf(u);
    if (!p) { add(`link-${u}`, false, `${u} isn't an Instagram, YouTube or TikTok link`); continue; }
    if (!POST_URL[p].test(u)) { add(`link-${u}`, false, `${u} doesn't look like a single ${p} post`); continue; }
    if (f.otherDealLinks?.has(u.replace(/[?#].*$/, '').replace(/\/$/, ''))) { add(`link-${u}`, false, `${u} is already the posted link of another deal`); continue; }
    const yt = p === 'YouTube' ? f.youtube?.[youtubeId(u)] : null;
    if (p === 'YouTube' && f.youtube) {
      if (!yt) { add(`link-${u}`, false, `${u} isn't a live YouTube video`); continue; }
      if ((f.channels || []).length && !f.channels.includes(yt.channelId)) { add(`link-${u}`, false, `${u} is on another YouTube channel, not ${deal.creator}'s`); continue; }
      if (deal.created && yt.at && Date.parse(yt.at) < Date.parse(deal.created) - 864e5) { add(`link-${u}`, false, `${u} was posted ${String(yt.at).slice(0, 10)}, before this deal began`); continue; }
    }
    add(`link-${u}`, true, `${p} link checked`);
  }

  // 1. payment details
  if (f.strayPayment?.length) add('payment', false, `The email has payment details that aren't ${deal.creator}'s verified ones (${f.strayPayment[0].slice(0, 60)}). Payments go through the pay link only`);
  return out;
}

// Loads what the checks need for one deal
export async function checkInvoice(deal, { amount, pct, body } = {}) {
  const { readBilling } = await import('./invoicing.js');
  const bill = readBilling(deal.billing);
  const convo = await (await import('./memory.js')).readTranscript(deal.id, 60000).catch(() => '');
  const pay = await creatorPayment(deal.creator).catch(() => ({ verified: false, text: '' }));
  const facts = { deal, bill, amount, pct, convo, strayPayment: body ? strayPaymentDetails(body, pay.text) : [] };
  // revenue sheet rows for this brand and creator
  try {
    const rows = await queryAll(DS.revenue);
    facts.revenue = rows.filter((p) => norm(plain(p.properties?.Brand)).includes(norm(deal.brand).slice(0, 6)) && norm(plain(p.properties?.Creator)) === norm(deal.creator))
      .map((p) => Number(plain(p.properties?.['Amount USD']))).filter((n) => n > 0);
  } catch { facts.revenue = []; }
  // posted links already used on other deals
  const links = String(deal.postedLinks || '').split(/\s+/).filter((u) => /^https?:\/\//.test(u));
  if (links.length) {
    try {
      const deals = await queryAll(DS.deals);
      facts.otherDealLinks = new Set(deals.filter((p) => p.id.replace(/-/g, '') !== String(deal.id).replace(/-/g, '')).flatMap((p) => String(plain(p.properties?.['Posted Links']) || '').split(/\s+/)).filter(Boolean).map((u) => u.replace(/[?#].*$/, '').replace(/\/$/, '')));
    } catch { /* checked next time */ }
    const ids = links.map(youtubeId).filter(Boolean);
    const key = process.env.YOUTUBE_API_KEY;
    if (ids.length && key) {
      try {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(',')}&key=${key}`).then((x) => x.json());
        if (!r.error) facts.youtube = Object.fromEntries((r.items || []).map((v) => [v.id, { channelId: v.snippet?.channelId, at: v.snippet?.publishedAt }]));
        const { POSTED_LINK_CREATORS } = await import('./postedlinks.js');
        const c = POSTED_LINK_CREATORS[deal.creator];
        facts.channels = c?.youtubeChannel ? [c.youtubeChannel] : [];
      } catch { /* checked next time */ }
    }
  }
  return { problems: invoiceProblems(facts), pay, bill, convo };
}

export const blocking = (problems) => problems.filter((p) => p.block);
