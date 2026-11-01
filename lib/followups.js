// Follow-ups tracker for HQ: every follow-up the PM has sent or drafted (lead nudges after our quote, deal check-ins,
// payment chases), what happened after each one (did the brand reply, did it turn into a deal or a payment), and
// who is being chased right now. Built from what the PM already saves: no AI, nothing written anywhere.
import { queryAll, plain } from './notion.js';
import { DS, followGap } from './tools.js';
import { OUTBOX_DS } from './outbox.js';

export const FOLLOW_KINDS = { 'Lead follow-up': 'lead', 'Follow-up': 'deal', 'Payment chase': 'payment' };
export const TYPE_NAME = { lead: 'Lead follow-ups', deal: 'Deal check-ins', payment: 'Payment chases' };
const MAX_NUDGES = 3;
const MAX_QUIET_DAYS = 12;
const LEAD_WON = ['Locked', 'Won'];
const DEAL_DONE = ['Paid', 'Lost'];
const t = (s) => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : null; };
const month = (ms) => new Date(ms + 5.5 * 36e5).toISOString().slice(0, 7);
const dayOf = (ms) => (ms == null ? null : new Date(ms + 5.5 * 36e5).toISOString().slice(0, 10));
const DAY = 864e5;

// drafts: [{ kind, status, sentAt, created, leadId, dealId, creator, subject, why, url }]
// leads:  [{ id, url, brand, creator, status, followUps, lastOur, lastBrand, quoted, ask, agreed }]
// deals:  [{ id, url, brand, creator, stage, followUps, lastOur, lastBrand, finalRate, invoiceAmount, paidDate, invoiceSent }]
export function buildFollowups({ drafts, leads, deals, now = Date.now() }) {
  const leadById = new Map(leads.map((l) => [norm(l.id), l]));
  const dealById = new Map(deals.map((d) => [norm(d.id), d]));
  // One "chase" per lead or deal (and per type): its follow-ups in order and what came after them
  const chases = new Map();
  for (const d of drafts) {
    const type = FOLLOW_KINDS[d.kind];
    if (!type) continue;
    const target = type === 'lead' ? leadById.get(norm(d.leadId)) : dealById.get(norm(d.dealId));
    const key = `${type}:${norm(type === 'lead' ? d.leadId : d.dealId) || d.subject}`;
    const c = chases.get(key) || { key, type, target, sent: [], waiting: [], rejected: 0, expired: 0, creator: d.creator, subject: d.subject };
    chases.set(key, c);
    if (d.status === 'Sent' && t(d.sentAt || d.created) != null) c.sent.push(t(d.sentAt || d.created));
    else if (d.status === 'Draft') c.waiting.push(d);
    else if (d.status === 'Rejected') c.rejected++;
    else if (d.status === 'Expired') c.expired++;
    if (!c.creator && d.creator) c.creator = d.creator;
  }

  const rows = [];
  for (const c of chases.values()) {
    c.sent.sort((a, b) => a - b);
    const tg = c.target || {};
    const brand = tg.brand || (c.subject || '').replace(/^re:\s*/i, '').slice(0, 60) || 'Unknown';
    const creator = tg.creator || c.creator || '';
    const replyAt = t(tg.lastBrand);
    const first = c.sent[0] ?? null, last = c.sent[c.sent.length - 1] ?? null;
    // Which follow-up the brand answered: the last one sent before their latest email
    let repliedTo = 0;
    if (first != null && replyAt != null && replyAt > first) repliedTo = c.sent.filter((s) => s < replyAt).length;
    let outcome = 'waiting', value = 0;
    if (c.type === 'lead') {
      const won = LEAD_WON.includes(tg.status) || Number(tg.agreed) > 0;
      value = Number(tg.agreed || tg.quoted || tg.ask || 0);
      if (won && first != null && (repliedTo > 0 || (replyAt ?? 0) >= first)) outcome = 'won';
      else if (won) outcome = 'won-before';
      else if (tg.status === 'Lost') outcome = repliedTo ? 'replied-lost' : 'lost';
      else if (repliedTo) outcome = 'replied';
      else if (c.sent.length >= MAX_NUDGES || (last != null && (now - last) / DAY > MAX_QUIET_DAYS)) outcome = 'quiet';
    } else if (c.type === 'payment') {
      value = Number(tg.invoiceAmount || tg.finalRate || 0);
      const paidAt = t(tg.paidDate);
      // Paid on or after the first chase counts for the chase; paid before it (the chase crossed the payment) doesn't
      if (tg.stage === 'Paid' || paidAt) outcome = first != null && paidAt != null && paidAt + DAY < first ? 'paid-before' : 'paid';
      else if (repliedTo) outcome = 'replied';
      else if (c.sent.length >= MAX_NUDGES) outcome = 'quiet';
    } else {
      value = Number(tg.finalRate || 0);
      if (repliedTo) outcome = 'replied';
      else if (DEAL_DONE.includes(tg.stage)) outcome = tg.stage === 'Lost' ? 'lost' : 'replied';
      else if (c.sent.length >= MAX_NUDGES) outcome = 'quiet';
    }
    if (!c.sent.length && c.waiting.length) outcome = 'draft';
    rows.push({ key: c.key, type: c.type, brand, creator, url: tg.url || null, sent: c.sent.length, firstSent: dayOf(first), lastSent: dayOf(last), lastBrand: dayOf(replyAt), repliedTo, outcome, value, waitingDrafts: c.waiting.length, rejected: c.rejected, expired: c.expired, month: first != null ? month(first) : null });
  }

  // Being chased right now: quoted leads still waiting on the brand, and deals the PM is checking in on
  const active = [];
  for (const l of leads) {
    if (l.status !== 'Waiting on brand' || !(Number(l.ask) > 0 || Number(l.quoted) > 0)) continue;
    const lastAt = Math.max(t(l.lastOur) ?? 0, t(l.lastBrand) ?? 0);
    if (!lastAt) continue;
    const quiet = (now - lastAt) / DAY;
    const n = Number(l.followUps || 0);
    const done = n >= MAX_NUDGES || quiet > MAX_QUIET_DAYS;
    const row = rows.find((r) => r.key === `lead:${norm(l.id)}`);
    active.push({ type: 'lead', brand: l.brand, creator: l.creator, url: l.url, amount: Number(l.ask || l.quoted || 0), nudges: n, of: MAX_NUDGES, lastOur: dayOf(t(l.lastOur)), lastBrand: dayOf(t(l.lastBrand)), quietDays: Math.floor(quiet), next: done ? null : dayOf(lastAt + followGap(n) * DAY), state: row?.waitingDrafts ? 'in Approvals' : done ? 'gone quiet' : 'scheduled' });
  }
  for (const d of deals) {
    if (DEAL_DONE.includes(d.stage) || !(d.followUps > 0)) continue;
    const ourLater = (t(d.lastOur) ?? 0) >= (t(d.lastBrand) ?? 0);
    if (!ourLater) continue;
    const type = d.stage === 'Invoiced' ? 'payment' : 'deal';
    const lastAt = Math.max(t(d.lastOur) ?? 0, t(d.lastBrand) ?? 0, t(d.invoiceSent) ?? 0);
    const n = d.followUps;
    const row = rows.find((r) => r.key === `${type}:${norm(d.id)}`);
    active.push({ type, brand: d.brand, creator: d.creator, url: d.url, amount: Number(type === 'payment' ? d.invoiceAmount || d.finalRate : d.finalRate) || 0, nudges: n, of: MAX_NUDGES, stage: d.stage, lastOur: dayOf(t(d.lastOur)), lastBrand: dayOf(t(d.lastBrand)), quietDays: lastAt ? Math.floor((now - lastAt) / DAY) : null, next: n >= MAX_NUDGES || !lastAt ? null : dayOf(lastAt + followGap(n) * DAY), state: row?.waitingDrafts ? 'in Approvals' : n >= MAX_NUDGES ? 'handed to you' : 'scheduled' });
  }
  active.sort((a, b) => String(a.next || '9999').localeCompare(String(b.next || '9999')));

  // Totals, and the same split by type, creator and month
  const sum = (xs) => {
    const chased = xs.filter((r) => r.sent > 0);
    const replied = chased.filter((r) => r.repliedTo > 0 || ['won', 'paid', 'replied', 'replied-lost'].includes(r.outcome));
    const won = chased.filter((r) => r.outcome === 'won' || r.outcome === 'paid');
    return {
      chased: chased.length, sent: chased.reduce((a, r) => a + r.sent, 0), replied: replied.length,
      replyRate: chased.length ? Math.round(replied.length / chased.length * 100) : 0,
      won: won.length, wonValue: won.reduce((a, r) => a + (r.value || 0), 0),
      quiet: chased.filter((r) => r.outcome === 'quiet').length, lost: chased.filter((r) => /lost/.test(r.outcome)).length,
      waiting: chased.filter((r) => r.outcome === 'waiting').length,
    };
  };
  const group = (keyOf) => {
    const m = new Map();
    for (const r of rows) { const k = keyOf(r); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([k, xs]) => ({ name: k, ...sum(xs) }));
  };
  // Which follow-up brings the answer: of the chases that got follow-up N, how many replied right after it
  const byNudge = [1, 2, 3].map((n) => {
    const got = rows.filter((r) => r.sent >= n);
    const answered = got.filter((r) => r.repliedTo === n);
    return { n, got: got.length, replied: answered.length, rate: got.length ? Math.round(answered.length / got.length * 100) : 0, won: answered.filter((r) => r.outcome === 'won' || r.outcome === 'paid').length };
  });

  const thisMonth = month(now);
  return {
    generated_at: new Date(now).toISOString(),
    totals: sum(rows), thisMonth: sum(rows.filter((r) => r.month === thisMonth)), month: thisMonth,
    byType: group((r) => TYPE_NAME[r.type]), byCreator: group((r) => r.creator || 'Unknown').sort((a, b) => b.sent - a.sent),
    byMonth: group((r) => r.month).sort((a, b) => b.name.localeCompare(a.name)),
    byNudge,
    active,
    wins: rows.filter((r) => ['won', 'paid'].includes(r.outcome)).sort((a, b) => String(b.lastBrand).localeCompare(String(a.lastBrand))),
    history: rows.filter((r) => r.sent > 0).sort((a, b) => String(b.lastSent).localeCompare(String(a.lastSent))),
    drafts: rows.filter((r) => r.waitingDrafts > 0).length,
    rejected: rows.reduce((a, r) => a + r.rejected, 0),
  };
}
const norm = (id) => String(id || '').replace(/-/g, '').toLowerCase();

let cache = { at: 0, data: null };
export async function followupsData({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < 120000) return cache.data;
  const filter = { or: Object.keys(FOLLOW_KINDS).map((k) => ({ property: 'Kind', select: { equals: k } })) };
  const [draftPages, leadPages, dealPages] = await Promise.all([
    queryAll(OUTBOX_DS, filter, { useCache: false }),
    queryAll(DS.leads, undefined, { useCache: false }),
    queryAll(DS.deals, undefined, { useCache: false }),
  ]);
  const g = (p, n) => plain(p.properties?.[n]);
  const rel = (p, n) => (p.properties?.[n]?.relation || [])[0]?.id || null;
  const drafts = draftPages.map((p) => ({ kind: g(p, 'Kind'), status: g(p, 'Status'), sentAt: g(p, 'Sent At'), created: p.created_time, leadId: rel(p, 'Lead'), dealId: rel(p, 'Deal'), creator: g(p, 'Creator'), subject: g(p, 'Subject') || '', url: p.url }));
  const leads = leadPages.map((p) => ({ id: p.id, url: p.url, brand: g(p, 'Brand') || 'Unknown', creator: g(p, 'Creator'), status: g(p, 'Status'), followUps: Number(g(p, 'Follow-ups') || 0), lastOur: g(p, 'Last Our Email'), lastBrand: g(p, 'Last Brand Email'), quoted: g(p, 'Quoted USD'), ask: g(p, 'Ask USD'), agreed: g(p, 'Agreed USD') }));
  const deals = dealPages.map((p) => ({ id: p.id, url: p.url, brand: g(p, 'Brand Name') || 'Untitled', creator: g(p, 'Creator'), stage: g(p, 'Deal Stage'), followUps: Number(g(p, 'Follow-ups Sent') || 0), lastOur: g(p, 'Last Our Reply'), lastBrand: g(p, 'Last Brand Reply'), finalRate: g(p, 'Final Rate USD'), invoiceAmount: g(p, 'Invoice Amount'), paidDate: g(p, 'Paid Date'), invoiceSent: g(p, 'Invoice Sent Date') }));
  const data = buildFollowups({ drafts, leads, deals });
  cache = { at: Date.now(), data };
  return data;
}

// One line for the morning brief
export function briefLine(f) {
  if (!f) return '';
  const leadsNow = f.active.filter((a) => a.type === 'lead' && a.state !== 'gone quiet').length;
  const dealsNow = f.active.filter((a) => a.type !== 'lead').length;
  const m = f.thisMonth;
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  return `Follow-ups: chasing ${n(leadsNow, 'quoted brand')} and ${n(dealsNow, 'deal')} · this month ${m.sent} sent, ${m.replied} replied (${m.replyRate}%), ${m.won} won${m.wonValue ? ` ($${Math.round(m.wonValue).toLocaleString('en-US')})` : ''}`;
}
