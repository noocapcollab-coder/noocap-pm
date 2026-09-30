// Money chase: who to invoice, who owes us, which brands went quiet, which cuts to collect.
// Source of truth is what the team actually uses: SPONSOR cards on the creator boards + Sponsor Video Revenue,
// plus the Brand Deals table for email back-and-forth. No AI calls.
//
// Flow per sponsor video:  12- Posted  ->  revenue row created (bot)  ->  Invoice Sent date (creator sends it,
// team ticks the date or the PM sees the invoice email)  ->  Paid  ->  Cut Collected.
import { notion, queryAll, flatten, clearCache } from './notion.js';
import { BOARDS, DS, todayIST, readVideo } from './tools.js';
import { openDeals, discord } from './briefs.js';

export const BACKLOG_FROM = '2026-09-01'; // posted sponsor videos before this are never auto-logged
const RECENT_DAYS = 30;                      // anything older than this is ignored everywhere (logging, digest, HQ)
// Creators whose sponsor deals NOOCAP doesn't handle: never logged, chased or listed
export const NOT_OUR_DEALS = []; // e.g. ['emtech'] to stop tracking a creator's sponsor money
const ours = (creator) => !NOT_OUR_DEALS.includes(String(creator || '').toLowerCase().replace(/[^a-z]/g, ''));
const recentFrom = (today) => { const d = new Date(Date.parse(today) - RECENT_DAYS * 864e5).toISOString().slice(0, 10); return d > BACKLOG_FROM ? d : BACKLOG_FROM; };
const QUIET_DAYS = 3;                        // brand counts as gone quiet after this many days
const CHASE_EVERY = 7;                       // unpaid invoice reminder at day 7, 14, 21
const MAX_REMINDERS = 3;
const MAX_CREATE_PER_RUN = 12;

const day = (d) => (d ? String(d).slice(0, 10) : null);
const daysSince = (d, today = todayIST()) => (d ? Math.floor((new Date(today) - new Date(day(d))) / 864e5) : null);
const bare = (id) => String(id || '').replace(/-/g, '').toLowerCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const usd = (n) => (n ? '$' + Math.round(Number(n)).toLocaleString('en-US') : '');
const rt = (s) => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];

// "HIGGSFIELD - 4 AUG" -> "HIGGSFIELD", "LUMA 2 - TO BE POSTED BEFORE LUMA 1" -> "LUMA 2"
export const brandFromTitle = (t) => String(t || '').split(/\s[-–—|:]\s|\s\(/)[0].trim().slice(0, 60);

async function sponsorVideos() {
  const out = [];
  await Promise.all(BOARDS.map(async (b) => {
    let pages = [];
    try { pages = await queryAll(b.ds, undefined, { useCache: false }); } catch { return; }
    for (const page of pages) {
      const v = readVideo(page, b.creator);
      if (v.sponsor && v.stage === 'Posted' && ours(v.creator)) out.push(v);
    }
  }));
  return out;
}

async function revenueRows() {
  const pages = await queryAll(DS.revenue, undefined, { useCache: false });
  return pages.map((p) => ({ ...flatten(p), _id: p.id, _url: p.url }));
}

function findRow(rows, v) {
  const id = bare(v.id);
  return rows.find((r) => r['Video Link'] && bare(r['Video Link']).includes(id))
    || rows.find((r) => norm(r['Video Title']) === norm(v.title) && (!r.Creator || norm(r.Creator) === norm(v.creator)));
}

// Heartbeat step: every posted sponsor video gets a revenue row; new ones ping Discord right away.
// Also sends the 7/14/21-day unpaid reminders. Returns what it did.
export async function syncMoney() {
  const today = todayIST();
  const [videos, rows] = await Promise.all([sponsorVideos(), revenueRows()]);
  const created = [], pinged = [], reminded = [];

  // Clean-up of an earlier bug: rows the PM logged for cards with no POST DATE (old cards, not real posts) go to trash
  const noDate = new Set(videos.filter((v) => !v.post_date).map((v) => bare(v.id)));
  for (const r of rows) {
    if (!/^Logged by the PM/.test(r.Notes || '') || r.Paid === true || r['Invoice Sent']) continue;
    if (!ours(r.Creator)) { try { await notion('PATCH', `/pages/${r._id}`, { in_trash: true }); } catch { /* next run */ } continue; }
    const link = bare(r['Video Link']);
    if ([...noDate].some((id) => link.includes(id))) { try { await notion('PATCH', `/pages/${r._id}`, { in_trash: true }); } catch { /* next run */ } }
  }

  // Only cards with a real POST DATE in the last 30 days (a card with no date can't be told apart from an old one)
  const todo = videos.filter((v) => v.post_date && day(v.post_date) <= today && day(v.post_date) >= recentFrom(today) && !findRow(rows, v))
    .sort((a, b) => String(a.post_date).localeCompare(String(b.post_date)));
  const fresh = [];
  for (const v of todo.slice(0, MAX_CREATE_PER_RUN)) {
    const posted = day(v.post_date);
    const props = {
      'Video Title': { title: rt(v.title) },
      'Video Link': { url: v.url },
      Creator: { select: { name: v.creator } },
      Brand: { rich_text: rt(brandFromTitle(v.title)) },
      'Posted Date': { date: { start: posted } },
      Paid: { checkbox: false },
      Notes: { rich_text: rt(`Logged by the PM when the video was posted (${today}). Tick Invoice Sent once ${v.creator} has invoiced the brand.`) },
    };
    if (v.rate) props['Amount USD'] = { number: v.rate };
    try {
      const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.revenue }, properties: props });
      created.push({ ...v, row: page.url });
      // Instant ping only for a card that was really just posted (post date and last edit in the last 2 days);
      // everything else shows up in the 9am digest instead
      const editedRecently = Date.now() - new Date(v.edited || 0).getTime() < 2 * 864e5;
      if (daysSince(posted, today) <= 2 && editedRecently) fresh.push({ ...v, row: page.url });
    } catch (e) { created.push({ ...v, error: String(e.message).slice(0, 120) }); }
  }
  // At most one message per run, however many were posted
  if (fresh.length === 1) {
    const v = fresh[0];
    await discord(`🧾 **${brandFromTitle(v.title)} × ${v.creator} · sponsor video posted${v.rate ? ' · ' + usd(v.rate) : ''}**\n• Ask ${v.creator} to send their invoice to noocapcollab. I'll draft the invoice email to the brand for you to approve\n→ [Open revenue row](${v.row})`, 'pm');
  } else if (fresh.length > 1) {
    await discord(`🧾 **${fresh.length} sponsor videos posted, ask the creators for their invoices**\n` + fresh.slice(0, 8).map((v) => `• ${brandFromTitle(v.title)} × ${v.creator}`).join('\n') + `\nSend them to noocapcollab and I'll draft the invoice emails to the brands.`, 'pm');
  }
  pinged.push(...fresh.map((v) => v.title));

  // Unpaid invoices. NOOCAP chases the brand itself: if the video has a brand deal with an email thread, make sure the
  // deal says Invoiced so the heartbeat drafts the payment-chase emails (day 7, 14, 21) for approval. Only invoices
  // with no deal to email from fall back to a Discord reminder to chase by hand.
  const deals = await openDeals().catch(() => []);
  const nb = (x) => String(x || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
  for (const r of rows) {
    if (!ours(r.Creator) || r.Paid === true || !r['Invoice Sent'] || day(r['Invoice Sent']) < recentFrom(today)) continue;
    const brandKey = nb(r.Brand || brandFromTitle(r['Video Title']));
    const deal = brandKey && deals.find((d) => d.brandEmail && nb(d.brand) === brandKey && norm(d.creator) === norm(r.Creator) && d.stage !== 'Lost');
    if (deal) {
      if (!['Invoiced', 'Paid'].includes(deal.stage) || !deal.invoiceSent) {
        const p = { 'Invoice Sent Date': { date: { start: day(r['Invoice Sent']) } }, 'Next Action': { rich_text: [{ type: 'text', text: { content: 'Waiting for payment' } }] } };
        if (deal.stage !== 'Paid') p['Deal Stage'] = { select: { name: 'Invoiced' } };
        if (r['Amount USD']) p['Invoice Amount'] = { number: Number(r['Amount USD']) };
        try { await notion('PATCH', `/pages/${deal.id}`, { properties: p }); } catch { /* next run */ }
      }
      continue; // the heartbeat's payment chase takes it from here
    }
    const waited = daysSince(r['Invoice Sent'], today);
    const n = Number(r.Reminders || 0);
    if (n >= MAX_REMINDERS || waited < CHASE_EVERY * (n + 1)) continue;
    const brand = r.Brand || brandFromTitle(r['Video Title']);
    const last = n + 1 >= MAX_REMINDERS;
    await discord(`⏳ **${brand} × ${r.Creator || '?'} · unpaid ${waited}d${r['Amount USD'] ? ' · ' + usd(r['Amount USD']) : ''}**\n• Reminder ${n + 1}/${MAX_REMINDERS}: no brand email thread on file, so chase this one by hand${last ? '. Last reminder' : ''}\n→ [Open revenue row](${r._url})`, 'pm');
    try { await notion('PATCH', `/pages/${r._id}`, { properties: { Reminders: { number: n + 1 } } }); } catch { /* next run retries */ }
    reminded.push(brand);
  }

  if (created.length) clearCache();
  return { created: created.length, pinged, reminded, errors: created.filter((c) => c.error).map((c) => `${c.title}: ${c.error}`) };
}

// The four buckets, for the 9am digest and the HQ panel
export async function moneyChase() {
  const today = todayIST();
  const [rows, deals, cutPages] = await Promise.all([revenueRows(), openDeals().catch(() => []), queryAll(DS.cuts).catch(() => [])]);
  // NOOCAP only takes a cut from creators listed in Creator Cut (Brad, Chris, Emtech have none)
  const cutPct = {};
  for (const p of cutPages) { const c = flatten(p); if (c.Creator && Number(c['Cut Percent']) > 0) cutPct[norm(c.Creator)] = Number(c['Cut Percent']); }
  // A revenue row without an amount borrows the rate from its brand deal (same creator, brand name in the row)
  const allDeals = await queryAll(DS.deals).catch(() => []);
  const bkey = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
  const dealRates = allDeals.map((p) => { const f = flatten(p); return { creator: norm(f.Creator), brand: bkey(f['Brand Name']), rate: Number(f['Final Rate USD'] || f['Invoice Amount'] || 0) }; }).filter((d) => d.rate && d.brand.length >= 3);
  const rateFor = (r) => {
    const txt = bkey(`${r.Brand || ''} ${r['Video Title'] || ''}`);
    const hit = dealRates.find((d) => d.creator === norm(r.Creator) && txt.includes(d.brand));
    return hit ? hit.rate : null;
  };
  const item = (r, days, extra = {}) => ({ creator: r.Creator || '?', brand: r.Brand || brandFromTitle(r['Video Title']), video: r['Video Title'], amount: Number(r['Amount USD'] || 0) || rateFor(r), days: days == null ? days : Math.max(0, days), url: r._url, ...extra });

  const needsInvoice = [], awaitingPayment = [], cutPending = [];
  for (const r of rows) {
    if (!ours(r.Creator)) continue;
    const posted = day(r['Posted Date']) || day(r._created);
    // Only the last 30 days count. Older rows are history, not something to chase.
    const from = recentFrom(today);
    if (r.Paid === true) {
      const paidOn = day(r['Payment Received']) || posted;
      const pct = cutPct[norm(r.Creator)];
      if (pct && r['Cut Collected'] !== true && paidOn >= from) {
        const it = item(r, daysSince(paidOn, today));
        cutPending.push({ ...it, amount: it.amount ? Math.round(it.amount * pct) / 100 : null, cut_percent: pct });
      }
      continue;
    }
    if (r['Invoice Sent']) { if (day(r['Invoice Sent']) >= from) awaitingPayment.push(item(r, daysSince(r['Invoice Sent'], today), { invoiced: day(r['Invoice Sent']) })); }
    else if (posted >= from) needsInvoice.push(item(r, daysSince(posted, today)));
  }

  // Brand deals: we spoke last and the brand has gone quiet, or they spoke last and we haven't answered
  const quiet = [], replyNeeded = [];
  for (const d of deals) {
    if (d.paused || /^(Paid|Lost)$/.test(d.stage || '') || !ours(d.creator)) continue;
    const lastOur = [d.lastOur, d.scriptSent, d.linksSent, d.invoiceSent, d.confirmed].map(day).filter(Boolean).sort().pop() || null;
    const theirs = day(d.lastBrand);
    const base = { creator: d.creator || '?', brand: d.brand, stage: d.stage || 'no stage', url: d.url };
    if (Math.max(daysSince(lastOur, today) ?? 999, daysSince(theirs, today) ?? 999) > RECENT_DAYS && !(lastOur && daysSince(lastOur, today) <= RECENT_DAYS) && !(theirs && daysSince(theirs, today) <= RECENT_DAYS)) continue; // dead thread
    if (lastOur && (!theirs || theirs <= lastOur) && daysSince(lastOur, today) >= QUIET_DAYS) quiet.push({ ...base, days: daysSince(lastOur, today), follow_ups: d.followUps });
    else if (theirs && (!lastOur || theirs > lastOur) && daysSince(theirs, today) >= 1) replyNeeded.push({ ...base, days: daysSince(theirs, today) });
  }

  const byDays = (a, b) => (b.days ?? 0) - (a.days ?? 0);
  const sum = (xs) => xs.reduce((n, x) => n + (x.amount || 0), 0);
  [needsInvoice, awaitingPayment, cutPending, quiet, replyNeeded].forEach((xs) => xs.sort(byDays));
  return {
    today,
    needs_invoice: needsInvoice, awaiting_payment: awaitingPayment, cut_pending: cutPending, quiet, reply_needed: replyNeeded,
    totals: { needs_invoice_usd: sum(needsInvoice), awaiting_usd: sum(awaitingPayment), cut_pending_usd: sum(cutPending), unknown_amounts: [...needsInvoice, ...awaitingPayment].filter((x) => !x.amount).length },
  };
}

// 9am Discord digest
export async function moneyDigest() {
  const m = await moneyChase();
  const L = [`💰 **Money to chase · ${m.today}**`];
  const line = (x) => `• ${x.brand} × ${x.creator}${x.amount ? ' · ' + usd(x.amount) : ''} · ${x.days}d`;
  const block = (title, xs, fmt = line, max = 10) => {
    if (!xs.length) return;
    L.push(`\n${title}`);
    for (const x of xs.slice(0, max)) L.push(fmt(x));
    if (xs.length > max) L.push(`• …and ${xs.length - max} more (HQ tab has the full list)`);
  };
  block(`🧾 **Posted, invoice not sent yet (${m.needs_invoice.length})** — ask the creator for their invoice`, m.needs_invoice, (x) => `• ${x.brand} × ${x.creator}${x.amount ? ' · ' + usd(x.amount) : ''} · posted ${x.days}d ago`);
  block(`⏳ **Waiting for payment (${m.awaiting_payment.length}) · ${usd(m.totals.awaiting_usd) || '$0'}**`, m.awaiting_payment, (x) => `• ${x.brand} × ${x.creator}${x.amount ? ' · ' + usd(x.amount) : ''} · ${x.invoiced ? `invoiced ${x.days}d ago` : `unpaid ${x.days}d, invoice date unknown`}`);
  block(`🤐 **Brand gone quiet ${QUIET_DAYS}+ days (${m.quiet.length})**`, m.quiet, (x) => `• ${x.brand} × ${x.creator} · ${x.stage} · no reply ${x.days}d${x.follow_ups ? ` (${x.follow_ups} follow-ups sent)` : ''}`);
  block(`✉️ **Brand replied, we haven't (${m.reply_needed.length})**`, m.reply_needed, (x) => `• ${x.brand} × ${x.creator} · ${x.stage} · ${x.days}d`);
  block(`🏦 **NOOCAP cut to collect (${m.cut_pending.length}) · ${usd(m.totals.cut_pending_usd) || '$0'}**`, m.cut_pending, (x) => `• ${x.creator} · ${x.brand}${x.amount ? ' · ' + usd(x.amount) + ` (${x.cut_percent}%)` : ''}`, 6);
  if (L.length === 1) L.push('Nothing to chase today ✅');
  if (m.totals.unknown_amounts) L.push(`\n_${m.totals.unknown_amounts} rows have no amount yet, fill Amount USD in Sponsor Video Revenue._`);
  // Discord caps a message at 2000 characters, so long digests go out in parts
  let buf = '';
  for (const l of L) {
    if ((buf + '\n' + l).length > 1900) { await discord(buf, 'pm'); buf = ''; }
    buf = buf ? buf + '\n' + l : l;
  }
  if (buf) await discord(buf, 'pm');
  return m;
}
