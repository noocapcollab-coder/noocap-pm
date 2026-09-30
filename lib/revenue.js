// Client revenue: every sponsor video on the creator boards joined to its row in Sponsor Video Revenue,
// plus each creator's NOOCAP cut %. Ported from the RevenueDashboard repo so it lives inside Agency HQ.
// Join key: the revenue row's Video Link = the board card's Notion URL (or contains its id).
import { notion, queryAll, flatten, titleOf, clearCache } from './notion.js';
import { BOARDS, DS, readVideo } from './tools.js';
import { brandFromTitle } from './money.js';

const lc = (s) => String(s || '').toLowerCase().trim();
const bare = (id) => String(id || '').replace(/-/g, '').toLowerCase();
const day = (d) => (d ? String(d).slice(0, 10) : '');
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
// Same person, different spellings across tables ("Dymtro" in revenue, "Dmytro" on the board)
export const ckey = (s) => {
  const k = lc(s).replace(/[^a-z ]/g, '');
  if (k.startsWith('valer')) return 'valeri';
  if (k.startsWith('david')) return 'david';
  if (k.startsWith('dym') || k.startsWith('dmy')) return 'dmytro';
  return k;
};
const bkey = (s) => lc(s).replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
// A deal counts as agreed money from Price Agreed onward (Lost never counts)
const DEAL_STAGES = ['Inbound', 'Negotiating', 'Price Agreed', 'Signed', 'Brief Received', 'Script Sent', 'Script Approved', 'In Production', 'Submitted', 'Approved', 'Posted', 'Invoiced', 'Paid'];
const agreed = (stage) => DEAL_STAGES.indexOf(stage) >= DEAL_STAGES.indexOf('Price Agreed');
const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const PAY_TERMS = 21; // days from invoice to payment when the deal has no due date
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Board helpers the shared readVideo doesn't cover
function cycleOf(page) {
  for (const [name, v] of Object.entries(page.properties || {})) {
    if (!/month/i.test(name)) continue;
    if (v.type === 'select' && v.select) return v.select.name.trim();
    if (v.type === 'status' && v.status) return v.status.name.trim();
    if (v.type === 'multi_select' && v.multi_select?.[0]) return v.multi_select[0].name.trim();
  }
  return '';
}
function isLongForm(page) {
  for (const [name, v] of Object.entries(page.properties || {})) {
    if (!/format|content type/i.test(name)) continue;
    const vals = v.type === 'select' ? [v.select?.name] : v.type === 'status' ? [v.status?.name] : v.type === 'multi_select' ? (v.multi_select || []).map((o) => o.name) : [];
    if (vals.some((x) => /long/i.test(x || ''))) return true;
  }
  return false;
}
function videoDate(page) {
  const entries = Object.entries(page.properties || {}).filter(([, v]) => v.type === 'date' && v.date?.start);
  if (!entries.length) return '';
  const score = (name) => { const n = lc(name); return /post/.test(n) ? 5 : (n === 'da' || /\bdate\b|air|publish/.test(n)) ? 4 : /due/.test(n) ? 2 : 1; };
  entries.sort((a, b) => score(b[0]) - score(a[0]));
  return day(entries[0][1].date.start);
}
const cycleFromDate = (d) => (d ? `${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : '');

// Select options on the revenue table's Creator column, so writes reuse the existing spelling
let revSchema = null;
async function creatorOption(name) {
  if (!revSchema) {
    try { revSchema = await notion('GET', `/data_sources/${DS.revenue}`); } catch { revSchema = { properties: {} }; }
  }
  const opts = revSchema.properties?.Creator?.select?.options || [];
  const hit = opts.find((o) => ckey(o.name) === ckey(name));
  return hit ? hit.name : name;
}

export async function revenueData({ fresh = false } = {}) {
  const useCache = !fresh;
  const warnings = [];
  const display = {}; // ckey -> board spelling
  BOARDS.forEach((b) => { display[ckey(b.creator)] = b.creator; });
  const nameOf = (s) => display[ckey(s)] || s || 'No creator set';

  const safe = (p, label) => p.catch((e) => { warnings.push(`${label} couldn't be read (${String(e.message || e).slice(0, 80)})`); return []; });
  const [boards, revPages, dealPages, cutPages] = await Promise.all([
    Promise.all(BOARDS.map(async (b) => ({ b, pages: await safe(queryAll(b.ds, undefined, { useCache }), `${b.creator} board`) }))),
    safe(queryAll(DS.revenue, undefined, { useCache }), 'Revenue table'),
    safe(queryAll(DS.deals, undefined, { useCache }), 'Brand Deals'),
    safe(queryAll(DS.cuts, undefined, { useCache }), 'Creator Cut'),
  ]);

  // Revenue rows
  const rows = revPages.map((p) => {
    const f = flatten(p);
    return {
      revPageId: p.id, revUrl: p.url, link: f['Video Link'] || '', title: f['Video Title'] || '', creator: nameOf(f.Creator),
      brand: f.Brand || '', amount: f['Amount USD'] != null ? Number(f['Amount USD']) : null, paid: f.Paid === true,
      paidDate: day(f['Payment Received']), invoiced: day(f['Invoice Sent']), posted: day(f['Posted Date']), cutCollected: f['Cut Collected'] === true,
      created: day(p.created_time),
    };
  });
  const used = new Set();
  const findRow = (v) => {
    const id = bare(v.id);
    return rows.find((r) => !used.has(r.revPageId) && r.link && bare(r.link).includes(id))
      || rows.find((r) => !used.has(r.revPageId) && !r.link && lc(r.title) === lc(v.title) && ckey(r.creator) === ckey(v.creator));
  };

  // Brand deals. Agreed ones (Price Agreed onward) are linked to their video so the rate fills in on its own,
  // and agreed deals with no video or revenue row yet still show up as upcoming money.
  const today = todayIST();
  const allDeals = dealPages.map((p) => {
    const f = flatten(p);
    const brandName = f['Brand Name'] || titleOf(p);
    return {
      id: p.id, url: p.url, brandName, brand: bkey(brandName), creator: nameOf(f.Creator), ck: ckey(f.Creator), stage: f['Deal Stage'] || '',
      rate: Number(f['Final Rate USD'] || f['Invoice Amount'] || 0) || null, offer: Number(f['Offer Amount'] || 0) || null,
      linkedVideo: f['Linked Video'] || '', deadline: day(f.Deadline), invoiceSent: day(f['Invoice Sent Date']), invoiceDue: day(f['Invoice Due Date']),
      paidDate: day(f['Paid Date']), edited: day(p.last_edited_time),
    };
  });
  const deals = allDeals.filter((d) => agreed(d.stage) && d.rate);
  const dealUsed = new Set();
  const dealFor = (v) => {
    const id = bare(v.id);
    let d = deals.find((x) => !dealUsed.has(x.id) && x.linkedVideo && bare(x.linkedVideo).includes(id));
    if (!d) { const t = bkey(v.title); d = deals.find((x) => !dealUsed.has(x.id) && !x.linkedVideo && x.ck === ckey(v.creator) && x.brand.length >= 3 && t.includes(x.brand)); }
    if (d) dealUsed.add(d.id);
    return d || null;
  };
  // When the money should land: the invoice due date, else invoice sent + terms, else post date or deadline + terms
  const expectedOf = (d, postDate) => d.invoiceDue || (d.invoiceSent && addDays(d.invoiceSent, PAY_TERMS)) || ((postDate || d.deadline) && addDays(postDate || d.deadline, PAY_TERMS)) || '';
  const dealInfo = (d, postDate) => d && { id: d.id, url: d.url, stage: d.stage, rate: d.rate, brand: d.brandName, expected: d.stage === 'Paid' ? '' : expectedOf(d, postDate), paidDate: d.paidDate };
  // Rates from any deal (even unagreed offers), only used as a one-click suggestion
  const rateDeals = allDeals.map((d) => ({ ...d, r: d.rate || d.offer })).filter((d) => d.r && d.brand.length >= 3);
  const suggest = (creator, text) => { const t = bkey(text); const hit = rateDeals.find((d) => d.ck === ckey(creator) && t.includes(d.brand)); return hit ? hit.r : null; };
  // Apply a linked deal to a revenue entry: fill a missing amount, and count a deal marked Paid as paid
  const withDeal = (e, d) => {
    if (!d) return e;
    e.deal = d;
    if (!e.amount && d.rate) { e.amount = d.rate; e.amountFrom = 'deal'; e.suggested = null; }
    if (!e.paid && d.stage === 'Paid') { e.paid = true; e.paidFrom = 'deal'; e.paidDate = e.paidDate || d.paidDate || ''; }
    return e;
  };

  const cuts = {};
  for (const p of cutPages) { const f = flatten(p); if (f.Creator) cuts[nameOf(f.Creator)] = Number(f['Cut Percent'] || 0); }

  // Sponsor videos on the boards
  const videos = [];
  const seen = new Set();
  for (const { b, pages } of boards) {
    for (const page of pages) {
      const v = readVideo(page, b.creator);
      if (!v.sponsor || isLongForm(page) || /^archive/i.test(v.status || '') || seen.has(page.id)) continue;
      seen.add(page.id);
      const d = dealFor(v);
      const r = findRow(v) || (d && rows.find((x) => !used.has(x.revPageId) && x.link && bare(x.link).includes(bare(d.id))));
      if (r) used.add(r.revPageId);
      const date = videoDate(page) || r?.posted || '';
      const amount = r?.amount ?? null;
      videos.push(withDeal({
        key: page.id, creator: b.creator, title: v.title, brand: r?.brand || brandFromTitle(v.title), status: v.status || '', link: page.url, date,
        cycle: cycleOf(page) || cycleFromDate(date) || 'No date', revPageId: r?.revPageId || null, revUrl: r?.revUrl || null,
        amount, paid: !!r?.paid, paidDate: r?.paidDate || '', invoiced: r?.invoiced || '', cutCollected: !!r?.cutCollected,
        suggested: amount ? null : (v.rate || suggest(b.creator, `${r?.brand || ''} ${v.title}`)),
      }, dealInfo(d, date)));
    }
  }
  // Agreed deals with no video card yet: upcoming money (a revenue row made from the deal links by the deal URL)
  for (const d of deals) {
    if (dealUsed.has(d.id)) continue;
    const r = rows.find((x) => !used.has(x.revPageId) && x.link && bare(x.link).includes(bare(d.id)))
      || rows.find((x) => !used.has(x.revPageId) && !x.paid && !x.link && ckey(x.creator) === d.ck && d.brand.length >= 3 && bkey(`${x.brand} ${x.title}`).includes(d.brand));
    if (r) used.add(r.revPageId);
    if (!r && d.stage === 'Paid') continue; // paid long ago with no revenue row, nothing to add
    const info = dealInfo(d, '');
    if (!r && info.expected && info.expected < addDays(today, -120)) continue; // stale deal, not upcoming
    if (!r && !info.expected && d.edited < addDays(today, -60)) continue;
    dealUsed.add(d.id);
    const date = r?.posted || info.expected || d.deadline || '';
    videos.push(withDeal({
      key: d.id, creator: d.creator, title: r?.title || d.brandName, brand: d.brandName, status: d.stage, link: d.url, date,
      cycle: cycleFromDate(date) || 'No date', revPageId: r?.revPageId || null, revUrl: r?.revUrl || null, amount: r?.amount ?? null,
      paid: !!r?.paid, paidDate: r?.paidDate || '', invoiced: r?.invoiced || d.invoiceSent || '', cutCollected: !!r?.cutCollected, suggested: null, dealOnly: true,
    }, info));
  }
  // Revenue rows with no card on any board still count (money must never go missing)
  for (const r of rows) {
    if (used.has(r.revPageId)) continue;
    const date = r.posted || r.paidDate || r.created;
    videos.push(withDeal({
      key: r.revPageId, creator: r.creator, title: r.title || r.brand || 'Untitled', brand: r.brand || brandFromTitle(r.title), status: 'Revenue row only', link: r.link || r.revUrl, date,
      cycle: cycleFromDate(date) || 'No date', revPageId: r.revPageId, revUrl: r.revUrl, amount: r.amount, paid: r.paid, paidDate: r.paidDate, invoiced: r.invoiced,
      cutCollected: r.cutCollected, suggested: r.amount ? null : suggest(r.creator, `${r.brand} ${r.title}`), orphan: true,
    }, null));
  }
  videos.sort((a, z) => a.creator.localeCompare(z.creator) || String(z.date).localeCompare(String(a.date)) || a.title.localeCompare(z.title));
  return { ok: true, generated_at: new Date().toISOString(), today, creators: BOARDS.map((b) => b.creator), videos, cuts, warnings };
}

// Upsert one revenue row. Only the fields sent are written.
export async function setRevenue(b) {
  if (!b.revPageId && !b.link) throw new Error('link or revPageId required');
  const p = {};
  if (b.title != null && !b.revPageId) p['Video Title'] = { title: rt(String(b.title).slice(0, 200)) };
  if (b.creator && !b.revPageId) p.Creator = { select: { name: await creatorOption(b.creator) } };
  if (!b.revPageId) {
    if (b.link) p['Video Link'] = { url: b.link };
    p.Brand = { rich_text: rt(b.brand || brandFromTitle(b.title)) };
    if (b.date) p['Posted Date'] = { date: { start: day(b.date) } };
  }
  if ('amount' in b) { const n = b.amount === '' || b.amount == null ? null : Number(b.amount); p['Amount USD'] = { number: Number.isFinite(n) ? n : null }; }
  if ('paid' in b) {
    p.Paid = { checkbox: !!b.paid };
    p['Payment Received'] = b.paid ? { date: { start: day(b.paidDate) || new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10) } } : { date: null };
  } else if (b.paidDate) p['Payment Received'] = { date: { start: day(b.paidDate) } };
  if ('cutCollected' in b) p['Cut Collected'] = { checkbox: !!b.cutCollected };
  const page = b.revPageId
    ? await notion('PATCH', `/pages/${b.revPageId}`, { properties: p })
    : await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.revenue }, properties: p });
  clearCache();
  return { ok: true, revPageId: page.id, revUrl: page.url };
}

// Set a creator's cut %: patch their Creator Cut row, or create it
export async function setCut(creator, pct) {
  const n = Number(pct);
  if (!creator || !Number.isFinite(n) || n < 0 || n > 100) throw new Error('Cut must be a number from 0 to 100');
  const rows = await queryAll(DS.cuts, undefined, { useCache: false });
  const hit = rows.find((p) => ckey(titleOf(p)) === ckey(creator));
  if (hit) await notion('PATCH', `/pages/${hit.id}`, { properties: { 'Cut Percent': { number: n } } });
  else await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.cuts }, properties: { Creator: { title: rt(creator) }, 'Cut Percent': { number: n } } });
  clearCache();
  return { ok: true, creator, pct: n };
}

// Remove a revenue row (goes to Notion trash, recoverable). The board card is untouched.
export async function deleteRevenue(revPageId) {
  if (!revPageId) throw new Error('revPageId required');
  await notion('PATCH', `/pages/${revPageId}`, { in_trash: true });
  clearCache();
  return { ok: true, revPageId };
}
