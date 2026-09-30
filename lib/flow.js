// Flow: the whole agency on one screen. Where every video and every brand deal is in its journey,
// how each automation is doing, and what came out of it (videos shipped, money, emails, AI cost).
// Computed from Notion (and the n8n API when N8N_API_KEY is set). No AI calls, free to load.
import { notion, queryAll, flatten } from './notion.js';
import { allVideos, dealsSummary, moneySummary, editorOutput, todayIST, DS, LATE_WINDOW } from './tools.js';
import { OUTBOX_DS } from './outbox.js';

const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const safe = async (p, fallback) => { try { return await p; } catch (e) { return { ...fallback, _error: String(e.message || e).slice(0, 160) }; } };
const hoursAgo = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : null);

const VIDEO_STEPS = [
  { key: 'idea', label: 'Idea & brief', hint: '1–2', test: (n) => n === 1 || n === 2 },
  { key: 'script', label: 'Scripting', hint: '3–5', test: (n) => n >= 3 && n <= 5 },
  { key: 'film', label: 'To film', hint: '6', test: (n) => n === 6 },
  { key: 'edit', label: 'Editing', hint: '7', test: (n) => n === 7 },
  { key: 'review', label: 'Review', hint: '8–9', test: (n) => n === 8 || n === 9 },
  { key: 'ready', label: 'Ready to post', hint: '10–11', test: (n) => n === 10 || n === 11 },
];
const DEAL_STEPS = [
  ['Negotiating', ['Inbound', 'Negotiating']],
  ['Price agreed', ['Price Agreed', 'Signed']],
  ['Brief in', ['Brief Received']],
  ['Script sent', ['Script Sent']],
  ['Script approved', ['Script Approved', 'In Production']],
  ['Video submitted', ['Submitted', 'Approved']],
  ['Posted', ['Posted']],
  ['Invoiced', ['Invoiced']],
  ['Paid', ['Paid']],
];

// Automations we can see from the AGENT LOG / Outbox, plus n8n itself
const PM_JOBS = [
  { name: 'Inbox reader', what: 'Reads noocapcollab, files briefs, updates deals', area: 'Brand deals', every: null },
  { name: 'Morning brief', what: 'Daily Discord summary at 9am', area: 'Briefs', every: 24 },
  { name: 'Drive folders', what: 'Folders for videos at To Film', area: 'Drive', every: null },
];

async function n8nHealth() {
  let base = String(process.env.N8N_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base; // "n8n-xyz.up.railway.app" works too
  const key = process.env.N8N_API_KEY;
  if (!base || !key) return { connected: false, workflows: [] };
  const get = async (path) => {
    const r = await fetch(base + path, { headers: { 'X-N8N-API-KEY': key, accept: 'application/json' } });
    if (!r.ok) throw new Error(`n8n ${r.status}`);
    return r.json();
  };
  const [wf, ex] = await Promise.all([get('/api/v1/workflows?active=true&limit=100'), get('/api/v1/executions?limit=250')]);
  const byWf = {};
  for (const e of ex.data || []) {
    const w = (byWf[e.workflowId] ||= { runs24: 0, errors24: 0, last: null, lastStatus: null, lastError: null });
    const at = e.startedAt || e.stoppedAt;
    const recent = hoursAgo(at) <= 24;
    const status = e.status || (e.finished ? 'success' : 'error');
    if (recent) { w.runs24++; if (status === 'error' || status === 'crashed') w.errors24++; }
    if (!w.last || at > w.last) { w.last = at; w.lastStatus = status; }
    if ((status === 'error' || status === 'crashed') && (!w.lastError || at > w.lastError)) w.lastError = at;
  }
  const workflows = (wf.data || []).map((w) => {
    const s = byWf[w.id] || {};
    const health = s.lastStatus === 'error' || s.lastStatus === 'crashed' ? 'error' : s.errors24 ? 'warn' : s.last ? 'ok' : 'idle';
    return { name: w.name, last_run: s.last || null, last_status: s.lastStatus || null, runs_24h: s.runs24 || 0, errors_24h: s.errors24 || 0, health };
  }).sort((a, b) => ({ error: 0, warn: 1, ok: 2, idle: 3 }[a.health] - { error: 0, warn: 1, ok: 2, idle: 3 }[b.health]) || String(b.last_run).localeCompare(String(a.last_run)));
  return { connected: true, workflows };
}

let cache = null;

export async function buildFlow({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.data;
  const today = todayIST();
  const weekAgo = addDays(today, -6);
  const monthStart = today.slice(0, 8) + '01';
  const lateFrom = addDays(today, -LATE_WINDOW);

  const [vids, dealsR, moneyR, edWeek, logPages, sentPages, draftPages, n8n] = await Promise.all([
    safe(allVideos(), { videos: [], errors: [] }),
    safe(dealsSummary({ open_only: false }), { by_stage: {} }),
    safe(moneySummary({ from: monthStart, to: today }), { totals: {} }),
    safe(editorOutput({ from: weekAgo, to: today, include_videos: false }), { totals: {} }),
    safe(queryAll(DS.agentLog, { property: 'Time', date: { on_or_after: weekAgo } }, { useCache: false }), []),
    safe(notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { and: [{ property: 'Status', select: { equals: 'Sent' } }, { property: 'Sent At', date: { on_or_after: weekAgo } }] } }), { results: [] }),
    safe(notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { or: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Status', select: { equals: 'Failed' } }] } }), { results: [] }),
    safe(n8nHealth(), { connected: false, workflows: [] }),
  ]);

  // ---- video journey ----
  const videos = vids.videos || [];
  const live = videos.filter((v) => v.stage !== 'Posted' && !(v.post_date && v.post_date.slice(0, 10) < lateFrom));
  const videoSteps = VIDEO_STEPS.map((s) => {
    const inStep = live.filter((v) => s.test(parseInt(v.status, 10)));
    const late = inStep.filter((v) => v.post_date && v.post_date.slice(0, 10) < today).length;
    const sponsor = inStep.filter((v) => v.sponsor).length;
    const byCreator = {};
    for (const v of inStep) byCreator[v.creator] = (byCreator[v.creator] || 0) + 1;
    return { key: s.key, label: s.label, hint: s.hint, count: inStep.length, late, sponsor, creators: Object.entries(byCreator).sort((a, b) => b[1] - a[1]).slice(0, 4) };
  });
  const postedWeek = videos.filter((v) => v.stage === 'Posted' && v.post_date && v.post_date.slice(0, 10) >= weekAgo && v.post_date.slice(0, 10) <= today);
  videoSteps.push({ key: 'posted', label: 'Posted', hint: 'last 7 days', count: postedWeek.length, late: 0, sponsor: postedWeek.filter((v) => v.sponsor).length, creators: Object.entries(postedWeek.reduce((m, v) => ((m[v.creator] = (m[v.creator] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 4) });

  // ---- brand deal journey ----
  const bs = dealsR.by_stage || {};
  const dealSteps = DEAL_STEPS.map(([label, stages]) => ({
    label, count: stages.reduce((n, s) => n + (bs[s]?.deals || 0), 0), value_usd: stages.reduce((n, s) => n + (bs[s]?.value_usd || 0), 0),
  }));
  const noStage = bs['(no stage)']?.deals || 0;

  // ---- automations ----
  const log = logPages.map((p) => flatten(p));
  const jobs = PM_JOBS.map((j) => {
    const rows = log.filter((r) => r.Area === j.area).sort((a, b) => String(b.Time).localeCompare(String(a.Time)));
    const errors = rows.filter((r) => r.Outcome === 'Error').length;
    const last = rows[0]?.Time || null;
    const quiet = j.every && last && hoursAgo(last) > j.every * 3 + 1;
    return { name: j.name, what: j.what, last_run: last, runs_7d: rows.length, errors_7d: errors, health: rows[0]?.Outcome === 'Error' ? 'error' : errors ? 'warn' : quiet ? 'warn' : last ? 'ok' : 'idle' };
  });
  const sent = (sentPages.results || []).length;
  const failed = (draftPages.results || []).filter((p) => p.properties?.Status?.select?.name === 'Failed').length;
  const waiting = (draftPages.results || []).filter((p) => p.properties?.Status?.select?.name === 'Draft').length;
  jobs.push({ name: 'Email sender', what: 'Sends approved emails from noocapcollab', last_run: null, runs_7d: sent, errors_7d: failed, health: failed ? 'error' : sent ? 'ok' : 'idle' });

  // ---- results (last 7 days / this month) ----
  const count = (fn) => log.filter(fn).length;
  const results = {
    posted_week: postedWeek.length,
    delivered_week: edWeek.totals?.delivered || 0,
    changes_week: edWeek.totals?.changes_requested_in_period || 0,
    briefs_filed_week: count((r) => /^brief filed/i.test(r.Event || '')),
    deals_opened_week: count((r) => /new deal|price agreed/i.test(r.Event || '')),
    emails_sent_week: sent,
    emails_waiting: waiting,
    month_gross_usd: moneyR.totals?.gross_usd || 0,
    month_paid_usd: moneyR.totals?.paid_usd || 0,
    month_unpaid_usd: moneyR.totals?.unpaid_usd || 0,
    month_cut_usd: moneyR.totals?.noocap_cut_usd || 0,
    ai_cost_week_usd: Math.round(log.reduce((n, r) => n + Number(r['Cost USD'] || 0), 0) * 100) / 100,
    pm_actions_week: log.length,
  };

  const data = {
    today, generated_at: new Date().toISOString(),
    video: { steps: videoSteps, live: live.length },
    deals: { steps: dealSteps, no_stage: noStage },
    automations: { pm: jobs, n8n },
    results,
    errors: [vids, dealsR, moneyR, edWeek, n8n].map((x) => x && x._error).filter(Boolean).concat(vids.errors || []),
  };
  cache = { at: Date.now(), data };
  return data;
}
