// HQ: one live snapshot of the whole agency for the dashboard tab.
// Everything is computed here from Notion, nothing from the AI, so it costs nothing to load.
import { notion } from './notion.js';
import { allVideos, dealsSummary, moneySummary, editorOutput, agentLog, todayIST, DS } from './tools.js';
import { flatten } from './notion.js';
import { OUTBOX_DS } from './outbox.js';

const STAGES = ['Scripting', 'Filming', 'Editing', 'Review', 'Ready'];
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const safe = async (p, fallback) => { try { return await p; } catch (e) { return { ...fallback, _error: String(e.message || e).slice(0, 160) }; } };

let cache = null;

export async function buildHQ({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 45_000) return cache.data;
  const today = todayIST();
  const monthStart = today.slice(0, 8) + '01';
  const weekAgo = addDays(today, -6);
  const weekAhead = addDays(today, 6);

  const [vids, dealsR, moneyR, edWeek, edToday, logR, drafts, helpR] = await Promise.all([
    safe(allVideos(), { videos: [], errors: [] }),
    safe(dealsSummary({}), { by_stage: {}, deals: [], overdue_invoices: [], actions_due: [] }),
    safe(moneySummary({ from: monthStart, to: today }), { totals: {}, creators: [] }),
    safe(editorOutput({ from: weekAgo, to: today, include_videos: false }), { editors: [], totals: {} }),
    safe(editorOutput({ from: today, to: today, include_videos: false }), { editors: [], totals: {} }),
    safe(agentLog({ days: 7 }), { recent: [], ai_cost_usd: 0, events: 0 }),
    safe(notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { property: 'Status', select: { equals: 'Draft' } } }), { results: [] }),
    // emails the PM couldn't place (no deal / no creator); tick the log row's Outcome to anything else once sorted
    safe(notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 20, filter: { and: [{ property: 'Outcome', select: { equals: 'Needs approval' } }, { property: 'Time', date: { on_or_after: addDays(today, -14) } }] }, sorts: [{ property: 'Time', direction: 'descending' }] }), { results: [] }),
  ]);

  const videos = vids.videos || [];
  const live = videos.filter((v) => v.stage !== 'Posted');

  // ---- posting schedule: overdue + today + next 6 days ----
  const slim = (v) => ({ creator: v.creator, title: v.title || 'Untitled', stage: v.stage, status: v.status, editor: v.editor, sponsor: v.sponsor, url: v.url, date: v.post_date ? v.post_date.slice(0, 10) : null });
  const overdue = live.filter((v) => v.post_date && v.post_date.slice(0, 10) < today)
    .map((v) => ({ ...slim(v), days_late: Math.round((new Date(today) - new Date(v.post_date.slice(0, 10))) / 864e5) }))
    .sort((a, b) => b.days_late - a.days_late);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    const items = videos.filter((v) => v.post_date && v.post_date.slice(0, 10) === d).map(slim)
      .sort((a, b) => STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage));
    days.push({ date: d, items });
  }
  const todayItems = days[0].items;

  // ---- pipeline per creator ----
  const byCreator = {};
  for (const v of live) {
    if (!STAGES.includes(v.stage)) continue;
    const c = (byCreator[v.creator] ||= { creator: v.creator, total: 0, ...Object.fromEntries(STAGES.map((s) => [s, 0])) });
    c[v.stage]++; c.total++;
  }
  const pipeline = Object.values(byCreator).sort((a, b) => b.total - a.total);
  const stageTotals = Object.fromEntries(STAGES.map((s) => [s, pipeline.reduce((n, c) => n + c[s], 0)]));

  // ---- editor load (live cards assigned per editor) + output ----
  const load = {};
  for (const v of live) {
    if (!v.editor || !['Editing', 'Review'].includes(v.stage)) continue;
    const e = (load[v.editor] ||= { editor: v.editor, editing: 0, review: 0 });
    if (v.stage === 'Review') e.review++; else e.editing++;
  }
  const outWeek = Object.fromEntries((edWeek.editors || []).map((e) => [e.editor, e]));
  const outToday = Object.fromEntries((edToday.editors || []).map((e) => [e.editor, e.delivered]));
  const names = [...new Set([...Object.keys(load), ...Object.keys(outWeek)])].filter((n) => n && n !== '(no editor)');
  const editors = names.map((n) => ({
    editor: n,
    editing: load[n]?.editing || 0,
    review: load[n]?.review || 0,
    delivered_today: outToday[n] || 0,
    delivered_week: outWeek[n]?.delivered || 0,
    changes_week: outWeek[n]?.changes_requested_in_period || 0,
    avg_edit_hours: outWeek[n]?.avg_edit_hours ?? null,
  })).sort((a, b) => b.delivered_week - a.delivered_week || (b.editing + b.review) - (a.editing + a.review));

  // ---- brand deals ----
  const dealRows = dealsR.deals || [];
  const attention = [];
  for (const d of dealRows) {
    const why = [];
    if (d.needs_check) why.push('needs your check');
    if (d.invoice_overdue_days > 0) why.push(`invoice ${d.invoice_overdue_days}d overdue`);
    if (d.days_waiting_on_brand >= 3) why.push(`brand quiet ${d.days_waiting_on_brand}d`);
    if (why.length) attention.push({ brand: d.brand, creator: d.creator, stage: d.stage, why: why.join(' · '), url: d.url });
  }

  // ---- emails the PM needs help placing ----
  const unplaced = (helpR.results || []).map((p) => ({ ...flatten(p), _url: p.url }))
    .filter((r) => /^(unmatched|brief needs)/i.test(r.Event || ''))
    .map((r) => ({ event: String(r.Event).replace(/^Unmatched [a-z_]+:\s*/i, '').replace(/^Brief needs a creator:\s*/i, 'Brief: '), creator: r.Creator || null, time: r.Time, url: r._url, details: String(r.Details || '').split('\n').slice(1, 4).join(' ').replace(/\*\*/g, '').slice(0, 200) }));

  // ---- bot activity ----
  const activity = (logR.recent || []).slice(0, 12).map((r) => ({ time: r.time, event: r.event, area: r.area, outcome: r.outcome, creator: r.creator }));

  const data = {
    today,
    generated_at: new Date().toISOString(),
    kpis: {
      posting_today: todayItems.length,
      ready_today: todayItems.filter((v) => v.stage === 'Ready' || v.stage === 'Posted').length,
      overdue: overdue.length,
      in_edit: stageTotals.Editing,
      in_review: stageTotals.Review,
      ready: stageTotals.Ready,
      delivered_today: edToday.totals?.delivered || 0,
      delivered_week: edWeek.totals?.delivered || 0,
      approvals: (drafts.results || []).filter((p) => !p.in_trash).length,
      open_deals: dealRows.length,
      month_gross_usd: moneyR.totals?.gross_usd || 0,
      month_unpaid_usd: moneyR.totals?.unpaid_usd || 0,
      month_cut_usd: moneyR.totals?.noocap_cut_usd || 0,
      ai_cost_week_usd: logR.ai_cost_usd || 0,
    },
    schedule: { overdue: overdue.slice(0, 12), days },
    pipeline: { stages: STAGES, creators: pipeline, totals: stageTotals },
    editors,
    deals: {
      by_stage: dealsR.by_stage || {},
      attention: attention.slice(0, 10),
      unplaced,
      overdue_invoices: dealsR.overdue_invoices || [],
    },
    money: { month: monthStart.slice(0, 7), totals: moneyR.totals || {}, creators: (moneyR.creators || []).slice(0, 8) },
    activity,
    errors: [...(vids.errors || []), ...['_error'].flatMap((k) => [dealsR, moneyR, edWeek, logR, drafts].map((x) => x[k]).filter(Boolean))],
  };
  cache = { at: Date.now(), data };
  return data;
}
