// The whole dashboard as one compact text block, so the PM chat knows everything on every page without
// having to pick the right tool first: production per creator, today and this week, late cards, editors,
// every brand deal and creator-inbox offer with its next step, Approvals, money and revenue, and automation health.
// Built from the same functions the dashboard pages use. Cached for 60 seconds.
import { buildHQ } from './hq.js';
import { todayIST } from './tools.js';

let cache = null;
const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const short = (t, n = 70) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const safe = (p) => p.catch((e) => ({ _error: String(e.message || e).slice(0, 120) }));

export async function buildSnapshot({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.text;
  const today = todayIST();
  const [hq, rev, runs] = await Promise.all([
    safe(buildHQ({ fresh })),
    safe(import('./revenue.js').then((m) => m.revenueData({ fresh: false }))),
    safe(import('./runs.js').then((m) => m.listRuns({ fresh: false }))),
  ]);
  const L = [];
  const time = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(11, 16);
  L.push(`AGENCY SNAPSHOT · built ${today} ${time} IST from the live dashboard (same data as every dashboard page). Use it to answer directly; call tools only for details it doesn't hold.`);

  if (!hq._error) {
    const o = hq.overview || {};
    // ---------- production ----------
    L.push(`\n## This week (${o.week?.start} to ${o.week?.end}): ${o.week?.posted || 0} of ${o.week?.planned || 0} scheduled videos posted`);
    const pipe = Object.fromEntries((hq.pipeline?.creators || []).map((c) => [c.creator, c]));
    for (const c of o.creators || []) {
      const p = pipe[c.name];
      const stages = p ? (hq.pipeline.stages || []).filter((s) => p[s]).map((s) => `${s} ${p[s]}`).join(', ') : 'nothing in production';
      L.push(`- ${c.name}: ${c.posted}/${c.planned} posted this week, ${c.late} late, in production: ${stages} (health ${c.health === 'ok' ? 'on track' : c.health === 'warn' ? 'watch' : 'behind'})`);
    }
    const t = hq.pipeline?.totals || {};
    L.push(`- Pipeline totals: ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const days = hq.schedule?.days || [];
    const tp = days[0]?.items || [];
    L.push(`\n## Posting today (${tp.length})`);
    for (const v of tp) L.push(`- ${v.creator} · ${short(v.title)} · ${v.status}${v.editor ? ' · ' + v.editor : ''}${v.sponsor ? ' · SPONSOR' : ''}`);
    L.push('\n## Next 6 days');
    for (const d of days.slice(1)) if (d.items.length) L.push(`- ${d.date}: ` + d.items.map((v) => `${v.creator} "${short(v.title, 45)}" (${v.stage}${v.editor ? ', ' + v.editor : ''})`).join('; '));
    const late = hq.schedule?.overdue || [];
    if (late.length) {
      L.push(`\n## Past post date, last 7 days (${late.length}; Ready ones probably went out but aren't marked 12- Posted)`);
      for (const v of late) L.push(`- ${v.creator} · ${short(v.title)} · ${v.status} · ${v.days_late}d late${v.editor ? ' · ' + v.editor : ''}`);
    }
    L.push('\n## Editors');
    for (const e of hq.editors || []) L.push(`- ${e.editor}: ${e.editing} editing, ${e.review} in review, delivered ${e.delivered_today} today / ${e.delivered_week} this week, ${e.changes_week} change requests${e.avg_edit_hours != null ? `, avg ${e.avg_edit_hours}h per edit` : ''}`);

    // ---------- brand deals (the Brand deals page) ----------
    const cols = (hq.board?.columns || []).filter((c) => c.key !== 'cut');
    L.push('\n## Brand deals, by what happens next (Brand deals page)');
    for (const c of cols) {
      if (!c.items.length) continue;
      L.push(`${c.title} (${c.items.length}):`);
      for (const x of c.items.slice(0, 15)) L.push(`- ${x.brand} × ${x.creator} · ${c.key === 'money' ? 'video' : 'stage'} ${x.stage} · ${short(x.tag, 50)}${x.sub ? ' · ' + short(x.sub, 70) : ''}${x.amount ? ' · ' + usd(x.amount) : ''}${x.draft ? ' · email drafted, waiting in Approvals' : ''}`);
    }
    const unplaced = hq.deals?.unplaced || [];
    if (unplaced.length) { L.push('Emails the PM could not match to a deal:'); for (const u of unplaced.slice(0, 6)) L.push(`- ${short(u.event, 90)}${u.creator ? ' · ' + u.creator : ''}`); }
    const inv = hq.deals?.overdue_invoices || [];
    if (inv.length) L.push('Overdue brand invoices: ' + inv.map((i) => `${i.brand} × ${i.creator || '?'} ${i.days_overdue}d${i.amount ? ' ' + usd(i.amount) : ''}`).join('; '));
    const ld = hq.leads || {};
    const leads = (ld.columns || []).flatMap((c) => c.items.map((x) => ({ ...x, col: c.title })));
    L.push(`\n## Creator-inbox offers being negotiated (mainly Chris) · ${leads.length} active, ${ld.cold || 0} gone cold, ${ld.under_min || 0} under the $1,000 minimum (ignored)`);
    for (const x of leads.slice(0, 25)) L.push(`- ${x.brand} × ${x.creator} · ${x.status}${x.budget ? ' · their budget ' + usd(x.budget) : ''}${x.ask ? ' · our ask ' + usd(x.ask) : ''}${x.next ? ' · next: ' + short(x.next, 80) : ''}${x.days != null ? ` · ${x.weOwe ? 'brand wrote' : 'we wrote'} ${x.days}d ago` : ''}`);
    for (const a of ld.approvals || []) L.push(`- NEEDS HARSH: ${a.brand} × ${a.creator} wants ${usd(a.approval)} (below our floor, our ask ${usd(a.ask)})`);
    L.push(`\n## Approvals: ${hq.kpis?.approvals || 0} emails waiting for Harsh`);
    for (const d of (hq.board?.columns || []).flatMap((c) => c.items).filter((x) => x.draft).slice(0, 10)) L.push(`- ${d.brand} × ${d.creator}`);

    // ---------- money ----------
    const m3 = o.money30 || {};
    const ch = hq.chase || {};
    L.push(`\n## Money (last 30 days): received ${usd(m3.received)} from ${m3.received_videos || 0} videos, NOOCAP cut on that ${usd(m3.cut)}, invoiced and awaiting ${usd(m3.awaiting)} (${m3.awaiting_n || 0}), posted but not invoiced ${usd(m3.to_invoice)} (${m3.to_invoice_n || 0})`);
    if ((ch.needs_invoice || []).length) L.push('Posted, invoice not sent: ' + ch.needs_invoice.slice(0, 12).map((x) => `${x.brand} × ${x.creator}${x.amount ? ' ' + usd(x.amount) : ''} (${x.days}d)`).join('; '));
    if ((ch.awaiting_payment || []).length) L.push('Invoiced, waiting for the brand to pay: ' + ch.awaiting_payment.slice(0, 12).map((x) => `${x.brand} × ${x.creator}${x.amount ? ' ' + usd(x.amount) : ''} (${x.days}d)`).join('; '));
    if ((ch.cut_pending || []).length) L.push(`NOOCAP cut not collected yet (internal): ${usd(ch.totals?.cut_pending_usd)} across ${ch.cut_pending.length} videos`);
  } else L.push(`\n(Dashboard data could not load: ${hq._error}. Use the tools.)`);

  // ---------- revenue page ----------
  if (!rev._error && rev.videos) {
    const by = {};
    const monthEnd = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).toISOString().slice(0, 10);
    for (const v of rev.videos) {
      const b = (by[v.creator] ||= { received: 0, unpaid: 0, cut: 0, expected: 0, n: 0 });
      b.n++;
      if (v.paid) { b.received += v.amount || 0; b.cut += (v.amount || 0) * (Number(rev.cuts?.[v.creator] || 0) / 100); }
      else { b.unpaid += v.amount || 0; if (v.deal?.expected && v.deal.expected <= monthEnd) b.expected += v.amount || 0; }
    }
    L.push('\n## Client revenue, all time (Revenue page): per creator received / unpaid / NOOCAP cut % / expected by month end');
    for (const [c, b] of Object.entries(by).sort((a, z) => z[1].received - a[1].received)) L.push(`- ${c}: received ${usd(b.received)}, unpaid ${usd(b.unpaid)}, cut ${rev.cuts?.[c] ?? 0}% (${usd(b.cut)}), expected this month ${usd(b.expected)}, ${b.n} sponsor videos`);
    const upcoming = rev.videos.filter((v) => !v.paid && v.deal?.expected).sort((a, z) => a.deal.expected.localeCompare(z.deal.expected)).slice(0, 15);
    if (upcoming.length) L.push('Agreed deal money coming in: ' + upcoming.map((v) => `${v.deal.brand || v.brand} × ${v.creator} ${usd(v.amount)} expected ${v.deal.expected} (${v.deal.stage})`).join('; '));
  }

  // ---------- automations ----------
  if (!runs._error && runs.jobs) {
    L.push(`\n## Automations, last 24h (Automation runs page): ${runs.total_24h} runs`);
    for (const j of runs.jobs) L.push(`- ${j.job}: ${j.runs} runs, ${j.failed} failed, ${j.partial} partial${j.stuck ? `, ${j.stuck} stuck` : ''}, last ${j.last?.status || '?'} at ${String(j.last?.at || '').slice(11, 16)} UTC${j.last_fail ? ` · last problem: ${short(j.last_fail.error, 90)}` : ''}`);
    const bad = (runs.n8n?.workflows || []).filter((w) => w.failed);
    if (bad.length) L.push('n8n workflows with failures: ' + bad.map((w) => `${w.name} (${w.failed}/${w.runs})`).join('; '));
  }

  const text = L.join('\n').slice(0, 24000);
  cache = { at: Date.now(), text };
  return text;
}
