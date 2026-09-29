// HQ: one live snapshot of the whole agency for the dashboard tab.
// Everything is computed here from Notion, nothing from the AI, so it costs nothing to load.
import { notion, plain } from './notion.js';
import { allVideos, dealsSummary, moneySummary, editorOutput, agentLog, todayIST, DS, LATE_WINDOW } from './tools.js';
import { flatten } from './notion.js';
import { OUTBOX_DS } from './outbox.js';
import { moneyChase } from './money.js';
import { openDeals } from './briefs.js';

const STAGES = ['Scripting', 'Filming', 'Editing', 'Review', 'Ready'];

const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const safe = async (p, fallback) => { try { return await p; } catch (e) { return { ...fallback, _error: String(e.message || e).slice(0, 160) }; } };

let cache = null;

// AI spend this month, split by creator: email reading (Agent Log) + email writing (Outbox). Cached 30 min.
let costCache = null;
export async function aiCosts({ fresh = false } = {}) {
  if (!fresh && costCache && Date.now() - costCache.at < 30 * 60e3) return costCache.data;
  const { queryAll } = await import('./notion.js');
  const monthStart = todayIST().slice(0, 8) + '01';
  const since = new Date(Date.parse(monthStart + 'T00:00:00+05:30')).toISOString();
  const by = {};
  const add = (who, kind, n) => { const k = who || 'Unassigned'; by[k] = by[k] || { reading: 0, writing: 0 }; by[k][kind] += Number(n || 0); };
  const logs = await queryAll(DS.agentLog, { and: [{ property: 'Time', date: { on_or_after: since } }, { property: 'Cost USD', number: { greater_than: 0 } }] }, { useCache: false }).catch(() => []);
  for (const p of logs) add(plain(p.properties?.Creator), 'reading', plain(p.properties?.['Cost USD']));
  const drafts = await queryAll(OUTBOX_DS, { and: [{ timestamp: 'created_time', created_time: { on_or_after: since } }, { property: 'Cost USD', number: { greater_than: 0 } }] }, { useCache: false }).catch(() => []);
  for (const p of drafts) add(plain(p.properties?.Creator), 'writing', plain(p.properties?.['Cost USD']));
  const r2 = (n) => Math.round(n * 100) / 100;
  const raw = Object.values(by).reduce((n, v) => n + v.reading + v.writing, 0);
  const creators = Object.entries(by).map(([name, v]) => ({ name, reading: r2(v.reading), writing: r2(v.writing), total: r2(v.reading + v.writing), raw: v.reading + v.writing })).sort((a, b) => b.raw - a.raw);
  const data = { month: monthStart.slice(0, 7), total: r2(raw), creators, emailsRead: logs.length, draftsWritten: drafts.length };
  costCache = { at: Date.now(), data };
  return data;
}

export async function buildHQ({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 45_000) return cache.data;
  const today = todayIST();
  const monthStart = today.slice(0, 8) + '01';
  const weekAgo = addDays(today, -6);
  const weekAhead = addDays(today, 6);

  const [vids, dealsR, moneyR, edWeek, edToday, logR, drafts, helpR, chase, openD, intakeR, leadsR] = await Promise.all([
    safe(allVideos(), { videos: [], errors: [] }),
    safe(dealsSummary({}), { by_stage: {}, deals: [], overdue_invoices: [], actions_due: [] }),
    safe(moneySummary({ from: monthStart, to: today }), { totals: {}, creators: [] }),
    safe(editorOutput({ from: weekAgo, to: today, include_videos: false }), { editors: [], totals: {} }),
    safe(editorOutput({ from: today, to: today, include_videos: false }), { editors: [], totals: {} }),
    safe(agentLog({ days: 7 }), { recent: [], ai_cost_usd: 0, events: 0 }),
    safe(notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { property: 'Status', select: { equals: 'Draft' } } }), { results: [] }),
    // emails the PM couldn't place (no deal / no creator); tick the log row's Outcome to anything else once sorted
    safe(notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 20, filter: { and: [{ property: 'Outcome', select: { equals: 'Needs approval' } }, { property: 'Time', date: { on_or_after: addDays(today, -14) } }] }, sorts: [{ property: 'Time', direction: 'descending' }] }), { results: [] }),
    safe(moneyChase(), { needs_invoice: [], awaiting_payment: [], cut_pending: [], quiet: [], reply_needed: [], totals: {} }),
    safe(openDeals(), []),
    safe(import('./board.js').then((m) => m.intakeRowsOpen()), []),
    safe(import('./leads.js').then((m) => m.leadsBoard()), { columns: [], total: 0 }),
  ]);

  const videos = vids.videos || [];
  // The Deals board is loaded separately so a problem there can never take HQ down
  const boardMod = await import('./board.js').catch((e) => ({ error: e.message }));

  // ---- posting schedule: overdue + today + next 6 days ----
  const slim = (v) => ({ creator: v.creator, title: v.title || 'Untitled', stage: v.stage, status: v.status, editor: v.editor, sponsor: v.sponsor, url: v.url, date: v.post_date ? v.post_date.slice(0, 10) : null });
  // Only the last LATE_WINDOW days count as late. Older cards are stale boards (posted but never moved), so they're ignored.
  const lateFrom = addDays(today, -LATE_WINDOW);
  // cards dated before the window are left out everywhere on HQ (schedule, pipeline, editor load, counts)
  const live = videos.filter((v) => v.stage !== 'Posted' && !(v.post_date && v.post_date.slice(0, 10) < lateFrom));
  const overdue = live.filter((v) => v.post_date && v.post_date.slice(0, 10) < today && v.post_date.slice(0, 10) >= lateFrom)
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

  // ---- Overview page (the HQ design): this week, per creator, today's posts, money. All from data already loaded ----
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  const weekStart = addDays(today, -((dow + 6) % 7)), weekEnd = addDays(weekStart, 6);
  const pd = (v) => (v.post_date ? v.post_date.slice(0, 10) : null);
  const inWeek = videos.filter((v) => pd(v) && pd(v) >= weekStart && pd(v) <= weekEnd && v.stage !== 'Archived');
  const isDone = (v) => v.stage === 'Posted';
  const timeIST = (v) => (v.post_date && v.post_date.length > 10 ? new Date(Date.parse(v.post_date) + 5.5 * 36e5).toISOString().slice(11, 16) : null);
  const crNames = [...new Set([...inWeek.map((v) => v.creator), ...pipeline.map((c) => c.creator)])].filter(Boolean);
  const creatorsWeek = crNames.map((name) => {
    const mine = inWeek.filter((v) => v.creator === name);
    const dueSoFar = mine.filter((v) => pd(v) <= today).length;
    const posted = mine.filter(isDone).length;
    const late = overdue.filter((v) => v.creator === name).length;
    const todayOpen = todayItems.filter((v) => v.creator === name && v.stage !== 'Ready' && v.stage !== 'Posted').length;
    const health = late ? 'bad' : (todayOpen || posted < dueSoFar) ? 'warn' : 'ok';
    return { name, planned: mine.length, posted, late, health, live: byCreator[name]?.total || 0 };
  }).sort((a, b) => b.planned - a.planned || b.live - a.live || a.name.localeCompare(b.name));
  const nextWeekDates = (v) => pd(v) && pd(v) >= today && pd(v) <= weekAhead;
  const unscripted = live.filter((v) => nextWeekDates(v) && (v.stage === 'Scripting' || v.stage === 'Idea'));
  const overdueInv = dealsR.overdue_invoices || [];
  const lastEvent = (logR.recent || [])[0]?.time || null;
  const overview = {
    week: { start: weekStart, end: weekEnd, planned: inWeek.length, posted: inWeek.filter(isDone).length },
    in_production: STAGES.reduce((n, s) => n + (stageTotals[s] || 0), 0),
    posted_week_all: inWeek.filter(isDone).length,
    today_posts: todayItems.map((v) => ({ ...v, time: timeIST(videos.find((x) => x.url === v.url) || {}) })).sort((a, b) => String(a.time || '99').localeCompare(String(b.time || '99'))),
    unscripted_next7: unscripted.length,
    unscripted_names: [...new Set(unscripted.map((v) => v.creator))].slice(0, 3),
    creators: creatorsWeek,
    deals_open: dealsR.count ?? dealRows.length,
    deals_waiting_brand: dealRows.filter((d) => d.days_waiting_on_brand > 0).length,
    money: { gross: moneyR.totals?.gross_usd || 0, paid: moneyR.totals?.paid_usd || 0, unpaid: moneyR.totals?.unpaid_usd || 0, cut: moneyR.totals?.noocap_cut_usd || 0, overdue_count: overdueInv.length, overdue_usd: overdueInv.reduce((n, i) => n + Number(i.amount || 0), 0) },
    agent: { events_week: logR.events || 0, cost_week: logR.ai_cost_usd || 0, last_event: lastEvent },
  };

  const data = {
    today,
    overview,
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
    chase,
    leads: leadsR,
    board: (() => {
      // drafts with brand names for deal-less replies
      const ds = (drafts.results || []).filter((p) => !p.in_trash).map((p) => {
        const g = (n) => plain(p.properties?.[n]);
        const to = g('To') || '';
        return { id: p.id, kind: g('Kind'), creator: g('Creator') || null, dealId: p.properties?.Deal?.relation?.[0]?.id || null, created: p.created_time, brand: ((g('Why') || '').match(/^(.+?) asked:/) || [])[1] || (to.split('@')[1] || '').split('.')[0] || 'Brand' };
      });
      try { if (boardMod.error) throw new Error('board.js missing in lib: ' + boardMod.error); return boardMod.buildBoard({ deals: Array.isArray(openD) ? openD : [], drafts: ds, videos, intake: Array.isArray(intakeR) ? intakeR : [], chase, today }); } catch (e) { return { columns: [], total: 0, error: String(e.message).slice(0, 160) }; }
    })(),
    activity,
    errors: [...(vids.errors || []), ...['_error'].flatMap((k) => [dealsR, moneyR, edWeek, logR, drafts, chase].map((x) => x[k]).filter(Boolean))],
  };
  cache = { at: Date.now(), data };
  return data;
}
