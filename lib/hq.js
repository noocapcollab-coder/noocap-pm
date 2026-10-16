// HQ: one live snapshot of the whole agency for the dashboard tab.
// Everything is computed here from Notion, nothing from the AI, so it costs nothing to load.
import { notion, plain } from './notion.js';
import { allVideos, dealsSummary, moneySummary, editorOutput, agentLog, todayIST, DS, LATE_WINDOW, BOARDS } from './tools.js';
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

  const [vids, dealsR, moneyR, money30, edWeek, edToday, logR, drafts, helpR, chase, openD, intakeR, leadsR, mailR, contactsMap] = await Promise.all([
    safe(allVideos(), { videos: [], errors: [] }),
    safe(dealsSummary({}), { by_stage: {}, deals: [], overdue_invoices: [], actions_due: [] }),
    safe(moneySummary({ from: monthStart, to: today }), { totals: {}, creators: [] }),
    safe(moneySummary({ from: addDays(today, -29), to: today, include_items: true }), { totals: {}, creators: [], items: [] }),
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
    // Every email in or out of a brand thread in the last 6 days (Agent Log), so Active brands knows who is still in touch
    safe(notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 100, filter: { and: [{ property: 'Email Date', date: { on_or_after: addDays(today, -6) } }, { property: 'From Side', select: { is_not_empty: true } }] }, sorts: [{ property: 'Email Date', direction: 'descending' }] }), { results: [] }),
    import('./contacts.js').then((m) => m.loadContacts()).catch(() => new Map()),
  ]);

  const videos = vids.videos || [];
  // The Deals board is loaded separately so a problem there can never take HQ down
  const boardMod = await import('./board.js').catch((e) => ({ error: e.message }));

  // ---- posting schedule: overdue + today + next 6 days ----
  const slim = (v) => ({ creator: v.creator, title: v.title || 'Untitled', stage: v.stage, status: v.status, editor: v.editor, sponsor: v.sponsor, url: v.url, date: v.post_date ? v.post_date.slice(0, 10) : null });
  // Only the last LATE_WINDOW days count as late. Older cards are stale boards (posted but never moved), so they're ignored.
  const lateFrom = addDays(today, -LATE_WINDOW);
  // cards dated before the window are left out everywhere on HQ (schedule, pipeline, editor load, counts)
  // A card with no post date only counts if someone touched it in the last 21 days; older undated cards are forgotten ideas
  const freshUndated = (v) => !v.post_date && v.edited && String(v.edited).slice(0, 10) >= addDays(today, -21);
  const live = videos.filter((v) => v.stage !== 'Posted' && (v.post_date ? v.post_date.slice(0, 10) >= lateFrom : freshUndated(v)));
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
  const isDone = (v) => v.stage === 'Posted' || /scheduled/i.test(v.status || ''); // scheduled on the platform = will go out on its own
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
    money30: (() => {
      const items = money30.items || [];
      const paidItems = items.filter((i) => i.paid);
      return {
        received: paidItems.reduce((n, i) => n + Number(i.amount_usd || 0), 0),
        received_videos: paidItems.length,
        cut: Math.round(paidItems.reduce((n, i) => n + Number(i.cut_usd || 0), 0) * 100) / 100,
        awaiting: chase.totals?.awaiting_usd || 0, awaiting_n: (chase.awaiting_payment || []).length,
        to_invoice: chase.totals?.needs_invoice_usd || 0, to_invoice_n: (chase.needs_invoice || []).length,
      };
    })(),
    money: { gross: moneyR.totals?.gross_usd || 0, paid: moneyR.totals?.paid_usd || 0, unpaid: moneyR.totals?.unpaid_usd || 0, cut: moneyR.totals?.noocap_cut_usd || 0, overdue_count: overdueInv.length, overdue_usd: overdueInv.reduce((n, i) => n + Number(i.amount || 0), 0) },
    agent: { events_week: logR.events || 0, events_capped: !!logR.events_capped, cost_week: logR.ai_cost_usd || 0, last_event: lastEvent },
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
    ...(() => { const active = activeBrands(Array.isArray(openD) ? openD : [], videos, today, mailTouch(mailR)); return { active, chase: invoicePlan(chase, active, Array.isArray(openD) ? openD : [], today) }; })(),
    leads: leadsR,
    health: (() => { try { return dataHealth(Array.isArray(openD) ? openD : [], videos, contactsMap, BOARDS); } catch (e) { return [{ brand: 'Data checks', creator: '', why: 'failed: ' + String(e.message).slice(0, 120), url: '' }]; } })(),
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

// ---- Active brands: deals we've won, one row each, with where the video is and who has it ----
const WON = ['Price Agreed', 'Signed', 'Brief Received', 'Script Sent', 'Script Approved', 'In Production', 'Submitted', 'Approved', 'Posted', 'Invoiced'];
const STEPS = ['Brief', 'Script', 'Script OK', 'Filming & editing', 'Video OK', 'Posted', 'Paid'];
const pid = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
// What the video card says. The card is the team's real work, so it wins over the deal stage whenever there is one.
function cardStep(n, v) {
  if (n === 12) return { step: 5, doing: 'Posted, invoice to raise', who: v.creator || 'Creator' };
  if (n === 10 || n === 11) return { step: 4, doing: 'Video approved, ready to post', who: v.creator || 'Creator' };
  if (n === 9) return { step: 3, doing: 'Video with the brand for review', who: 'Brand' };
  if (n === 8) return { step: 3, doing: 'Editor making changes', who: v.editor || 'Editor' };
  if (n === 7) return { step: 3, doing: 'In edit', who: v.editor || 'Editor' };
  if (n === 6) return { step: 3, doing: 'To film', who: v.creator || 'Creator' };
  if (n === 5) return { step: 2, doing: 'Script with the brand', who: 'Brand' };
  if (n >= 1 && n <= 4) return { step: 1, doing: 'Script being written', who: 'Shreya' };
  return null;
}
const brandKey = (s) => String(s || '').toLowerCase().replace(/[×x]\s*\w+\s*$/i, '').replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq|ugc|video|reel|sponsor)\b/g, '').replace(/[^a-z0-9]+/g, '');
const LATE_DAYS = 5;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
// Brand → last email date in either direction, from Agent Log event titles ("brand reply: Capcut × Brad", "Lead · we replied: Re: … CapCut …")
function mailTouch(r) {
  const out = [];
  for (const p of r?.results || []) {
    const ev = (p.properties?.Event?.title || []).map((t) => t.plain_text).join('');
    const at = p.properties?.['Email Date']?.date?.start;
    if (ev && at) out.push({ text: brandKey(ev), creator: p.properties?.Creator?.select?.name || null, at: String(at).slice(0, 10) });
  }
  return out;
}
export function activeBrands(deals, videos, today, mail = []) {
  const touched = (brand, creator) => { const k = brandKey(String(brand || '').replace(/\s*-\s*\d+\s*$/, '')); if (k.length < 3) return null; const hit = mail.filter((m) => m.text.includes(k) && (!m.creator || !creator || m.creator.toLowerCase() === String(creator).toLowerCase())).map((m) => m.at).sort().pop(); return hit || null; };
  const vById = {};
  for (const v of videos) vById[pid(v.url) || String(v.id || '').replace(/-/g, '')] = v;
  const used = new Set();
  const rows = [];
  const num = (v) => (v ? parseInt(String(v.status), 10) : NaN);
  for (const d of deals) {
    if (!WON.includes(d.stage) || d.paused === true && !/^On hold/i.test(d.nextAction || '')) continue;
    let v = vById[pid(d.linkedVideo)] || null;
    // A repeat deal still linked to last campaign's posted video: that card is history, not this deal's video
    if (v && num(v) === 12 && !['Posted', 'Invoiced'].includes(d.stage)) v = null;
    // No card linked yet: find this brand's open sponsor card on the creator's board
    if (!v) {
      const key = brandKey(d.brand);
      if (key.length >= 3) v = videos.find((x) => (x.sponsor || /\s×\s/.test(x.title || '')) && !used.has(x.url) && num(x) >= 1 && num(x) <= 11 && (!d.creator || !x.creator || String(x.creator).toLowerCase() === String(d.creator).toLowerCase()) && brandKey(x.title).includes(key)) || null;
    }
    if (v) used.add(v.url);
    const n = num(v);
    let step = 0, doing = 'Waiting for the brief', who = 'Brand';
    const fromCard = v ? cardStep(n, v) : null;
    if (d.stage === 'Invoiced') { step = 5; doing = 'Invoiced, waiting for payment'; who = 'Brand'; }
    else if (fromCard) ({ step, doing, who } = fromCard);
    else if (d.stage === 'Posted') { step = 5; doing = 'Posted, invoice to raise'; who = d.creator || 'Creator'; }
    else if (d.stage === 'Approved') { step = 4; doing = 'Video approved, ready to post'; who = d.creator || 'Creator'; }
    else if (d.stage === 'Submitted') { step = 3; doing = 'Video with the brand for review'; who = 'Brand'; }
    else if (d.stage === 'Script Approved' || d.stage === 'In Production') { step = 3; doing = 'To film'; who = d.creator || 'Creator'; }
    else if (d.stage === 'Script Sent') { step = 2; doing = 'Script with the brand'; who = 'Brand'; }
    else if (d.stage === 'Brief Received') { step = 1; doing = 'Script being written'; who = 'Shreya'; }
    if (/^On hold/i.test(d.nextAction || '')) { doing = 'On hold at the brand\'s request'; who = 'Brand'; }
    const post = v?.post_date ? String(v.post_date).slice(0, 10) : d.deadline ? String(d.deadline).slice(0, 10) : null;
    // Late = the ball is in our court for more than 5 days: the brand wrote and we haven't answered, or our team is
    // holding it (script, filming, edit) and nothing has moved. A post date passing while we wait on the brand isn't late.
    const lb = d.lastBrand ? String(d.lastBrand).slice(0, 10) : null, lo = d.lastOur ? String(d.lastOur).slice(0, 10) : null;
    const unanswered = lb && (!lo || lb > lo) ? daysBetween(lb, today) : 0;
    const idle = who !== 'Brand' && v?.edited ? daysBetween(String(v.edited).slice(0, 10), today) : 0;
    const lastMail = touched(d.brand, d.creator);
    const inTouch = lastMail && daysBetween(lastMail, today) <= LATE_DAYS;
    const lateWhy = unanswered > LATE_DAYS ? `no reply to the brand for ${unanswered}d` : !inTouch && idle > LATE_DAYS && step < 5 && !/^Invoiced/.test(doing) ? `nothing moved for ${idle}d` : '';
    rows.push({ brand: d.brand, creator: d.creator || '?', stage: d.stage, url: d.url, video: v?.url || null, step, steps: STEPS, doing, who, post, late: !!lateWhy, late_why: lateWhy, post_passed: !!(post && post < today && step < 5), next: d.nextAction || '', rate: d.finalRate || null });
  }
  // Sponsor cards being worked on with no deal row in Notion: still active work, so they show too (flagged)
  for (const v of videos) {
    const n = num(v);
    const brandCard = v.sponsor || /\s×\s/.test(v.title || '');
    if (!brandCard || used.has(v.url) || !(n >= 1 && n <= 11)) continue;
    // Old cards nobody touched for weeks are leftovers, not active work
    const recent = v.edited && Date.now() - Date.parse(v.edited) < 21 * 864e5;
    if (!recent) continue;
    const c = cardStep(n, v);
    const post = v.post_date ? String(v.post_date).slice(0, 10) : null;
    const lastMail = touched(v.title, v.creator);
    const idleCard = lastMail && daysBetween(lastMail, today) <= LATE_DAYS ? 0 : c.who !== 'Brand' && v.edited ? daysBetween(String(v.edited).slice(0, 10), today) : 0;
    rows.push({ brand: String(v.title || 'Untitled').replace(/\s*[×x]\s*\w+\s*$/i, ''), creator: v.creator || '?', stage: null, url: v.url, video: v.url, step: c.step, steps: STEPS, ...c, post, late: idleCard > LATE_DAYS, late_why: idleCard > LATE_DAYS ? `nothing moved for ${idleCard}d` : '', post_passed: !!(post && post < today && c.step < 5), next: 'No deal in Notion for this card yet', rate: null, noDeal: true });
  }
  return rows.sort((a, b) => (b.late - a.late) || (b.post_passed - a.post_passed) || String(a.post || '9999').localeCompare(String(b.post || '9999')));
}

// ---- Invoices, checked against Active brands ----
// "Invoice not raised" only holds when the brand's deal agrees: a deal already marked Invoiced moves the row to waiting,
// a posted-today video waits a day before anyone is reminded, and videos about to post show as "coming up" so the
// creator can be told ahead, instead of a reminder arriving out of nowhere.
export function invoicePlan(chase, active, deals, today) {
  if (!chase || !Array.isArray(chase.needs_invoice)) return chase;
  const key = (s) => brandKey(String(s || '').replace(/\s*[-–—|:(].*$/, '').replace(/\s*\d+\s*$/, ''));
  const dealFor = (x) => { const k = key(x.brand || x.video); return k.length >= 3 ? deals.find((d) => String(d.creator || '').toLowerCase() === String(x.creator || '').toLowerCase() && key(d.brand) && (k.includes(key(d.brand)) || key(d.brand).includes(k))) : null; };
  const raise = [], wait = [...(chase.awaiting_payment || [])];
  for (const x of chase.needs_invoice) {
    const d = dealFor(x);
    if (d && (d.stage === 'Invoiced' || d.stage === 'Paid')) { wait.push({ ...x, invoiced: d.invoiceSent || null, days: x.days, by_deal: d.stage }); continue; }
    raise.push({ ...x, deal_stage: d?.stage || null, deal_url: d?.url || null, brand_email: d?.brandEmail || null, remind_ok: (x.days || 0) >= 1 });
  }
  const inRaise = new Set(raise.map((x) => key(x.brand || x.video) + '|' + String(x.creator).toLowerCase()));
  const soon = addDays(today, 7);
  const coming = (active || []).filter((r) => !r.noDeal || r.video).filter((r) => (r.step === 4 || (r.step === 3 && r.post && r.post <= soon)) && !inRaise.has(key(r.brand) + '|' + String(r.creator).toLowerCase()))
    .map((r) => ({ creator: r.creator, brand: r.brand, amount: r.rate || null, post: r.post, doing: r.doing, url: r.video || r.url }))
    .sort((a, b) => String(a.post || '9999').localeCompare(String(b.post || '9999')));
  const sum = (xs) => xs.reduce((n, x) => n + (Number(x.amount) || 0), 0);
  return { ...chase, needs_invoice: raise, awaiting_payment: wait, coming_up: coming, totals: { ...(chase.totals || {}), needs_invoice_usd: sum(raise), awaiting_usd: sum(wait) } };
}

// ---- Data checks: records that disagree with each other ----
// Each one is a mistake the PM could act on (wrong signature, wrong thread, wrong inbox on Cc), caught the day it
// appears instead of after an email goes out. Read-only: fixing is done in Notion.
const CREATOR_DOMAINS = Object.fromEntries(String(process.env.CREATOR_DOMAINS || 'buildroom.ai:Duncan,chriscordero.net:Chris,valchy.ai:Valeri,automateaiconsulting.com:Lindsay')
  .split(',').map((p) => p.split(':').map((x) => x.trim())).filter(([d, c]) => d && c).map(([d, c]) => [d.toLowerCase(), c]));
export function dataHealth(deals, videos, contacts, boards = []) {
  const out = [];
  const lc = (s) => String(s || '').toLowerCase();
  const live = deals.filter((d) => !['Paid', 'Lost'].includes(d.stage));
  const vById = Object.fromEntries(videos.map((v) => [pid(v.url), v]));
  const names = [...new Set([...boards.map((b) => b.creator), ...Object.values(CREATOR_DOMAINS)])].filter(Boolean);
  const add = (d, why, fix) => out.push({ brand: d.brand, creator: d.creator || '?', stage: d.stage, why, fix, url: d.url });
  // one thread, several deals
  const byThread = {};
  for (const d of live) if (d.threadId) (byThread[d.threadId] ||= []).push(d);
  for (const d of live) {
    if (!d.creator) { add(d, 'No creator on the deal', 'Set Creator, or the PM signs emails as nobody'); continue; }
    // the video card sits on another creator's board
    const v = d.linkedVideo ? vById[pid(d.linkedVideo)] : null;
    if (v && v.creator && lc(v.creator) !== lc(d.creator)) add(d, `Linked video is on ${v.creator}'s board`, 'Fix Creator on the deal or the Linked Video');
    // the thread is named after another creator ("(valeridoesai)X(tripo)")
    const subj = lc(d.threadSubject);
    const named = names.filter((c) => new RegExp(`(^|[^a-z])${lc(c)}`).test(subj));
    if (named.length === 1 && lc(named[0]) !== lc(d.creator)) add(d, `Thread subject names ${named[0]}`, 'This thread probably belongs to another deal: check Thread ID');
    // another creator's inbox on the Cc
    const others = [...new Set((String(d.threadCc || '').match(/@([\w.-]+)/g) || []).map((a) => CREATOR_DOMAINS[a.slice(1).toLowerCase()]).filter((c) => c && lc(c) !== lc(d.creator)))];
    if (others.length) add(d, `${others.join(' and ')}'s inbox is on the Cc`, 'Remove it from Thread CC so emails stop copying them');
    // the brand contact on file works with other creators only
    const k = String(d.brandEmail || '').toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    const c = k && contacts?.get?.(k);
    if (c && c.creators.length && !c.creators.some((x) => lc(x) === lc(d.creator))) add(d, `${k} is on file for ${c.creators.join(', ')} only`, 'Add this creator to the contact in Brand Contacts, or fix the deal');
    if (!d.brandEmail && !['Inbound', 'Negotiating'].includes(d.stage)) add(d, 'No brand email', 'Add Brand Email so follow-ups and invoices can go out');
    if ((byThread[d.threadId] || []).length > 1) add(d, `Thread shared with ${byThread[d.threadId].filter((x) => x !== d).map((x) => `${x.brand} × ${x.creator || '?'}`).join(', ')}`, 'Only one deal should own a thread');
  }
  return out;
}
