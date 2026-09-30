// Run tracking: every automation run (heartbeat, inbox, leads, sends) gets one row in PM RUNS with when it started,
// how long it took, what it did, each step's timing and any errors. A row is written as "Running" when the run
// starts and finished when it ends, so a run that crashed or timed out stays visible as stuck.
import { notion, queryAll, flatten } from './notion.js';

export const RUNS_DS = 'caf1a59e-ec98-4af1-b522-b4a23aa5d1e3';
const KEEP_DAYS = 14;
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1990) } }];
const clip = (s, n = 150) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Start a run. Returns a context with step() for timing each part, and finish() to close it. Never throws.
export async function startRun(job, title, { trigger = 'n8n' } = {}) {
  const ctx = { job, title: clip(title, 120) || job, trigger, t0: Date.now(), last: Date.now(), steps: [], id: null };
  try {
    const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: RUNS_DS }, properties: {
      Run: { title: rt(ctx.title) }, Job: { select: { name: job } }, Status: { select: { name: 'Running' } },
      Started: { date: { start: new Date(ctx.t0).toISOString() } }, Trigger: { select: { name: trigger } },
    } });
    ctx.id = page.id;
  } catch (e) { console.error('RUN start log failed', e.message); }
  // Time the code since the last mark as one named step
  ctx.mark = (name, note = '', ok = true) => { const now = Date.now(); ctx.steps.push({ name, ms: now - ctx.last, ok, note: clip(note, 90) }); ctx.last = now; };
  // Run fn as a named step; a failure is recorded and returned as null instead of thrown
  ctx.step = async (name, fn) => {
    ctx.last = Date.now();
    try { const r = await fn(); ctx.mark(name); return r; } catch (e) { ctx.mark(name, e.message, false); ctx.errors = [...(ctx.errors || []), `${name}: ${clip(e.message, 200)}`]; return null; }
  };
  ctx.finish = (out) => finishRun(ctx, out);
  return ctx;
}

export async function finishRun(ctx, { did = [], errors = [], status, steps } = {}) {
  const errs = [...(ctx.errors || []), ...errors].filter(Boolean);
  const didList = (Array.isArray(did) ? did : [did]).filter(Boolean);
  const st = status || (errs.length ? (didList.length ? 'Partial' : 'Failed') : 'OK');
  const allSteps = steps || ctx.steps;
  const props = {
    Status: { select: { name: st } }, 'Duration ms': { number: Date.now() - ctx.t0 },
    Did: { rich_text: rt(didList.length ? didList.join('\n') : st === 'Failed' ? 'Stopped with an error before doing anything' : 'Nothing to do') },
    Errors: { rich_text: rt(errs.join('\n')) },
    Steps: { rich_text: rt(allSteps.map((s) => `${s.ok === false ? '✗' : '✓'} ${s.name} · ${s.ms}ms${s.note ? ' · ' + s.note : ''}`).join('\n')) },
  };
  try {
    if (ctx.id) await notion('PATCH', `/pages/${ctx.id}`, { properties: props });
    else await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: RUNS_DS }, properties: { ...props, Run: { title: rt(ctx.title) }, Job: { select: { name: ctx.job } }, Started: { date: { start: new Date(ctx.t0).toISOString() } }, Trigger: { select: { name: ctx.trigger } } } });
  } catch (e) { console.error('RUN finish log failed', e.message); }
  return st;
}

// Wrap a whole job: start, run, finish (status from the summary, or Failed if it throws). Re-throws the error.
export async function withRun(job, title, fn, { trigger, summarize } = {}) {
  const ctx = await startRun(job, title, { trigger });
  try {
    const out = await fn(ctx);
    const sum = summarize ? summarize(out, ctx) : { did: [] };
    await finishRun(ctx, sum);
    return out;
  } catch (e) {
    await finishRun(ctx, { errors: [String(e.message || e).slice(0, 400)], status: 'Failed' });
    throw e;
  }
}

// Heartbeat report -> plain lines of what happened
export function heartbeatSummary(r = {}) {
  const did = [];
  const list = (xs, n = 4) => xs.slice(0, n).join(', ') + (xs.length > n ? ` +${xs.length - n} more` : '');
  if (r.drafts?.length) did.push(`Drafted ${r.drafts.length}: ${list(r.drafts)}`);
  if (r.handed_to_harsh?.length) did.push(`Handed to you: ${list(r.handed_to_harsh)}`);
  const made = r.drive?.made || [];
  if (made.length) did.push(`Drive folders: ${list(made.map((m) => `${m.creator} · ${m.title}`))}`);
  if (Array.isArray(r.leadNudges) && r.leadNudges.length) did.push(`Lead follow-ups: ${list(r.leadNudges.map(String))}`);
  if (r.autopilot?.sent?.length) did.push(`Auto-sent ${r.autopilot.sent.length}: ${list(r.autopilot.sent)}`);
  if (r.autopilot?.skipped?.length) did.push(`Autopilot skipped ${r.autopilot.skipped.length}: ${list(r.autopilot.skipped, 2)}`);
  if (r.promises?.reminded?.length) did.push(`Promise reminders: ${list(r.promises.reminded)}`);
  if (r.money) { const m = r.money; if (m.created) did.push(`Revenue rows logged: ${m.created}`); if (m.reminded?.length) did.push(`Payment reminders: ${list(m.reminded)}`); }
  if (r.brief === 'sent') did.push('Morning brief sent');
  if (typeof r.autolog === 'number') did.push(`Autopilot digest sent (${r.autolog} emails)`);
  return { did, errors: r.errors || [], steps: r.steps };
}

// Inbox / leads results -> lines
export function emailSummary(results = []) {
  const did = [], errors = [];
  for (const r of results) {
    const line = `${clip(r.subject || '(no subject)', 70)} → ${r.action || '?'}${r.why ? ' · ' + clip(r.why, 80) : ''}`;
    if (r.error || r.action === 'error' || r.action === 'gave_up') errors.push(`${clip(r.subject || '(no subject)', 70)}: ${clip(r.error || r.why, 200)}`);
    else did.push(line);
  }
  return { did, errors };
}

// n8n's own execution history (every workflow, every run, including ones that never reach the PM).
// Needs N8N_BASE_URL + N8N_API_KEY in Vercel. Cached 15s so the 5-second page refresh doesn't hammer n8n.
let n8nCache = null;
export async function n8nRuns() {
  const base = String(process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.N8N_API_KEY;
  if (!base || !key) return { connected: false, runs: [] };
  if (n8nCache && Date.now() - n8nCache.at < 15000) return n8nCache.data;
  const get = async (path) => {
    const r = await fetch(base + path, { headers: { 'X-N8N-API-KEY': key, accept: 'application/json' } });
    if (!r.ok) throw new Error(`n8n ${r.status}${r.status === 401 ? ' (check N8N_API_KEY)' : ''}`);
    return r.json();
  };
  const since = Date.now() - 24 * 36e5;
  const [wf, first] = await Promise.all([get('/api/v1/workflows?limit=250'), get('/api/v1/executions?limit=250&includeData=false')]);
  const names = Object.fromEntries((wf.data || []).map((w) => [String(w.id), w.name]));
  let ex = first.data || [], cursor = first.nextCursor;
  // page back until we have the full 24 hours (max 1,000 executions)
  while (cursor && ex.length < 1000 && Date.parse(ex[ex.length - 1]?.startedAt || 0) > since) {
    const more = await get(`/api/v1/executions?limit=250&includeData=false&cursor=${encodeURIComponent(cursor)}`);
    ex = ex.concat(more.data || []); cursor = more.nextCursor;
  }
  ex = ex.filter((e) => Date.parse(e.startedAt || e.createdAt || 0) > since);
  const map = { success: 'OK', error: 'Failed', crashed: 'Failed', running: 'Running', waiting: 'Running', new: 'Running', canceled: 'Skipped' };
  const runs = ex.map((e) => {
    const status = map[e.status] || (e.finished ? 'OK' : e.stoppedAt ? 'Failed' : 'Running');
    const started = e.startedAt || e.createdAt;
    const ms = e.stoppedAt && started ? Date.parse(e.stoppedAt) - Date.parse(started) : null;
    return { id: 'n8n-' + e.id, n8nId: e.id, url: `${base}/workflow/${e.workflowId}/executions/${e.id}`, job: 'n8n', workflow: names[String(e.workflowId)] || `Workflow ${e.workflowId}`,
      title: names[String(e.workflowId)] || `Workflow ${e.workflowId}`, status, started, ms, did: `${e.mode || 'run'} execution #${e.id}${e.retryOf ? ` (retry of #${e.retryOf})` : ''}`, errors: '', steps: '', trigger: 'n8n' };
  });
  // Error details (message + failing node) for the most recent failures
  const failed = runs.filter((r) => r.status === 'Failed').slice(0, 12);
  await Promise.all(failed.map(async (r) => {
    try {
      const d = await get(`/api/v1/executions/${r.n8nId}?includeData=true`);
      const rd = d.data?.resultData || {};
      const err = rd.error || {};
      const node = err.node?.name || rd.lastNodeExecuted || '';
      r.errors = `${node ? node + ': ' : ''}${String(err.message || err.description || 'failed').slice(0, 400)}`;
      const run = rd.runData || {};
      r.steps = Object.entries(run).map(([n, arr]) => { const x = (arr || [])[0] || {}; return `${x.error ? '✗' : '✓'} ${n} · ${x.executionTime || 0}ms${x.error ? ' · ' + String(x.error.message || '').slice(0, 80) : ''}`; }).join('\n');
    } catch { r.errors = r.errors || 'failed (details unavailable)'; }
  }));
  const data = { connected: true, runs };
  n8nCache = { at: Date.now(), data };
  return data;
}

// Latest runs + per-job health for the dashboard
let cache = null;
export async function listRuns({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 3000) return cache.data;
  const since = new Date(Date.now() - 24 * 36e5).toISOString();
  const [pages, n8n] = await Promise.all([
    queryAll(RUNS_DS, { property: 'Started', date: { on_or_after: since } }, { maxPages: 800, useCache: false }),
    n8nRuns().catch((e) => ({ connected: true, error: String(e.message || e).slice(0, 160), runs: [] })),
  ]);
  const runs = pages.map((p) => {
    const f = flatten(p);
    let status = f.Status || 'Running';
    const started = f.Started || p.created_time;
    // A run still "Running" after 5 minutes was killed (timeout or crash) before it could finish
    if (status === 'Running' && Date.now() - Date.parse(started) > 5 * 60e3) status = 'Stuck';
    return { id: p.id, url: p.url, job: f.Job || 'Other', title: f.Run || '', status, started, ms: f['Duration ms'] ?? null, did: f.Did || '', errors: f.Errors || '', steps: f.Steps || '', trigger: f.Trigger || '' };
  }).concat(n8n.runs).sort((a, z) => String(z.started).localeCompare(String(a.started)));
  const jobs = {};
  for (const r of runs) {
    const j = (jobs[r.job] ||= { job: r.job, runs: 0, failed: 0, partial: 0, stuck: 0, total_ms: 0, timed: 0, last: null, last_fail: null });
    j.runs++;
    if (r.status === 'Failed') j.failed++;
    if (r.status === 'Partial') j.partial++;
    if (r.status === 'Stuck') j.stuck++;
    if (r.ms != null) { j.total_ms += r.ms; j.timed++; }
    if (!j.last) j.last = { at: r.started, status: r.status, ms: r.ms, title: r.title };
    if (!j.last_fail && ['Failed', 'Partial', 'Stuck'].includes(r.status)) j.last_fail = { at: r.started, status: r.status, error: clip(r.errors || r.title, 200) };
  }
  for (const j of Object.values(jobs)) { j.avg_ms = j.timed ? Math.round(j.total_ms / j.timed) : null; delete j.total_ms; delete j.timed; }
  const workflows = {};
  for (const r of n8n.runs) {
    const w = (workflows[r.workflow] ||= { name: r.workflow, runs: 0, failed: 0, last: null, last_fail: null });
    w.runs++; if (r.status === 'Failed') w.failed++;
    if (!w.last || r.started > w.last.at) w.last = { at: r.started, status: r.status };
    if (r.status === 'Failed' && (!w.last_fail || r.started > w.last_fail.at)) w.last_fail = { at: r.started, error: r.errors };
  }
  const data = { generated_at: new Date().toISOString(), jobs: Object.values(jobs), runs: runs.slice(0, 300), total_24h: runs.length,
    n8n: { connected: n8n.connected, error: n8n.error || null, workflows: Object.values(workflows).sort((a, z) => z.failed - a.failed || String(z.last?.at).localeCompare(String(a.last?.at))) } };
  cache = { at: Date.now(), data };
  return data;
}

// Keep the table small: trash runs older than two weeks, a batch at a time
export async function pruneRuns() {
  const before = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
  const r = await notion('POST', `/data_sources/${RUNS_DS}/query`, { page_size: 40, filter: { property: 'Started', date: { before } } });
  let n = 0;
  for (const p of r.results || []) { try { await notion('PATCH', `/pages/${p.id}`, { in_trash: true }); n++; } catch { /* next time */ } }
  return n;
}
