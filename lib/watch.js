// PM · Watchdog. Checks every 15 minutes that the automation is actually working and tells #pm-alerts on Discord the
// moment something breaks, instead of Harsh finding out from a screenshot. Each problem is announced once, repeated
// every 6 hours while it lasts, and followed by a "fixed" message when it clears.
//
// What it watches:
//  - the heartbeat (has it run in the last 25 minutes, did its last runs fail)
//  - the inbox runs (several failures in the last hour)
//  - runs stuck as "Running" (killed before they finished)
//  - the shared board snapshot the dashboards read (fresh, every board loaded)
//  - the n8n workflows (any whose last run failed)
// Bounced emails are announced straight away by bounceAlert(), called from the inbox handlers.
import { notion, plain } from './notion.js';
import { DS } from './tools.js';
import { discord, log } from './briefs.js';
import { RUNS_DS } from './runs.js';

const STATE_TITLE = 'Watchdog state';
const REPEAT_MS = 6 * 36e5;
const ago = (t) => { const m = Math.round((Date.now() - Date.parse(t)) / 6e4); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

async function runs(job, sinceMin) {
  const r = await notion('POST', `/data_sources/${RUNS_DS}/query`, { page_size: 30, filter: { and: [
    { property: 'Job', select: { equals: job } },
    { property: 'Started', date: { on_or_after: new Date(Date.now() - sinceMin * 6e4).toISOString() } },
  ] }, sorts: [{ property: 'Started', direction: 'descending' }] });
  return (r.results || []).map((p) => ({ status: plain(p.properties?.Status), started: plain(p.properties?.Started), errors: plain(p.properties?.Errors) || '' }));
}

// Every check returns the problems it found: { key, text }
async function checkHeartbeat() {
  const out = [];
  const hb = await runs('Heartbeat', 180);
  if (!hb.length || Date.now() - Date.parse(hb[0].started) > 25 * 6e4) {
    out.push({ key: 'heartbeat-silent', text: `The PM heartbeat hasn't run ${hb.length ? `since ${ago(hb[0].started)}` : 'in 3 hours'}. Follow-ups, drafts and invoices are paused until it runs again (check Vercel → noocap-pm → Cron Jobs).` });
  }
  const done = hb.filter((r) => r.status !== 'Running');
  if (done.length >= 2 && done.slice(0, 2).every((r) => r.status === 'Failed')) out.push({ key: 'heartbeat-failing', text: `The last 2 heartbeat runs failed: ${done[0].errors.slice(0, 220) || 'no error text'}` });
  const stuck = hb.filter((r) => r.status === 'Running' && Date.now() - Date.parse(r.started) > 10 * 6e4);
  if (stuck.length >= 2) out.push({ key: 'heartbeat-stuck', text: `${stuck.length} heartbeat runs in the last 3 hours were cut off before finishing (still "Running"). They're probably hitting Vercel's time limit.` });
  // Notion saying "slow down" shows up as errors inside runs that otherwise finished
  const limited = done.filter((r) => /rate.?limit|429/i.test(r.errors)).length;
  if (limited >= 3) out.push({ key: 'notion-rate-limit', text: `${limited} of the last ${done.length} heartbeat runs hit Notion's rate limit. Something is reading Notion too often.` });
  return out;
}

async function checkInbox() {
  const ib = await runs('Inbox', 60);
  const failed = ib.filter((r) => r.status === 'Failed');
  return failed.length >= 2 ? [{ key: 'inbox-failing', text: `${failed.length} brand emails failed to process in the last hour. Latest error: ${failed[0].errors.slice(0, 220) || 'none recorded'}` }] : [];
}

async function checkSnapshot() {
  const k = process.env.BOARDS_KEY;
  if (!k) return [];
  try {
    const r = await fetch(`https://noocap-pm.vercel.app/api/boards?k=${encodeURIComponent(k)}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [{ key: 'snapshot-down', text: `The board snapshot the dashboards read is answering ${r.status}. Calendar, Scripting and the video brief fall back to Notion and may slow down.` }];
    const d = await r.json();
    const out = [];
    if (Date.now() - Date.parse(d.at) > 15 * 6e4) out.push({ key: 'snapshot-stale', text: `The board snapshot was last updated ${ago(d.at)}, so dashboards are showing old cards. The every-minute sync may have stopped.` });
    const bad = Object.values(d.boards || {}).filter((b) => b.error || b.stale).map((b) => b.creator);
    if (bad.length) out.push({ key: 'snapshot-boards', text: `These creator boards aren't loading into the dashboards: ${bad.join(', ')}. Check the board still exists and the Notion integration can see it.` });
    return out;
  } catch (e) { return [{ key: 'snapshot-down', text: `The board snapshot couldn't be reached (${String(e.message).slice(0, 80)}).` }]; }
}

async function checkWorkflows() {
  try {
    const r = await fetch('https://noocapcrm.vercel.app/api/workflows', { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.workflows || d || []).filter?.((w) => w.state === 'error').map((w) => ({ key: `n8n-${w.id}`, text: `n8n workflow "${w.name}" failed on its last run${w.lastRunAt ? ` (${ago(w.lastRunAt)})` : ''}.` })) || [];
  } catch { return []; }
}

async function stateRow() {
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { equals: STATE_TITLE } } });
  const p = (r.results || [])[0];
  let s = {};
  try { s = JSON.parse(plain(p?.properties?.Details) || '{}'); } catch { s = {}; }
  return { id: p?.id, s };
}

export async function runWatch() {
  const found = (await Promise.all([checkHeartbeat(), checkInbox(), checkSnapshot(), checkWorkflows()].map((p) => p.catch(() => [])))).flat();
  const { id, s } = await stateRow();
  const now = Date.now();
  const next = {};
  const alerts = [], fixed = [];
  for (const f of found) {
    const old = s[f.key];
    next[f.key] = { since: old?.since || now, last: old?.last || 0, text: f.text };
    if (!old || now - old.last > REPEAT_MS) { alerts.push(f.text + (old ? ` (still broken, since ${ago(new Date(old.since).toISOString())})` : '')); next[f.key].last = now; }
  }
  for (const k of Object.keys(s)) if (!next[k]) fixed.push(s[k].text);
  if (alerts.length) await discord(`🚨 **Something needs attention**\n` + alerts.map((t) => '• ' + t).join('\n'), 'pm').catch(() => {});
  if (fixed.length) await discord(`✅ **Back to normal**\n` + fixed.map((t) => '• ' + t.split('. ')[0]).join('\n'), 'pm').catch(() => {});
  const details = JSON.stringify(next).slice(0, 1900);
  if (id) await notion('PATCH', `/pages/${id}`, { properties: { Details: { rich_text: [{ type: 'text', text: { content: details } }] } } });
  else await log({ event: STATE_TITLE, outcome: 'Rule', email: { messageId: '' }, details });
  return { problems: found.map((f) => f.key), alerted: alerts.length, fixed: fixed.length };
}

// A "message not delivered" email: say which address bounced and which email it was, straight away
const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const BOUNCE_SUBJ = /deliver(y|ed)|undeliver|address not found|returned mail|failure notice|not delivered|delivery status/i;
export async function bounceAlert(email, inbox = 'noocapcollab') {
  if (!BOUNCE_FROM.test(String(email.from || '')) || !BOUNCE_SUBJ.test(String(email.subject || ''))) return false;
  // Announce each bounce once, even if the inbox hands it over again
  const tag = `Bounce ${String(email.messageId || email.subject || '').slice(0, 150)}`;
  const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Event', title: { equals: tag } } }).catch(() => ({ results: [] }));
  if ((seen.results || []).length) return true;
  await log({ event: tag, outcome: 'Rule', email: { messageId: '' }, details: `Bounce in ${inbox}` }).catch(() => {});
  const { addrs, orig } = parseBounce(email.text);
  await discord(`📭 **An email bounced** (${inbox})\n• Didn't reach: ${addrs.join(', ') || 'address not shown'}${orig ? `\n• Email: ${orig.slice(0, 120)}` : ''}\n• Fix the address on the deal or lead so the next one goes through`, 'pm').catch(() => {});
  return true;
}
export function isBounce(email) { return BOUNCE_FROM.test(String(email.from || '')) && BOUNCE_SUBJ.test(String(email.subject || '')); }
// Which address bounced and which email it was (only the bounce notice itself, not the quoted original's From/To)
export function parseBounce(raw) {
  const text = String(raw || '');
  const head = text.split(/-{2,}\s*Original message|^From:/im)[0] || text;
  const addrs = [...new Set((head.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).filter((a) => !/mailer-daemon|postmaster|google\.com|googlemail|noocapcollab/i.test(a)))].slice(0, 3);
  const orig = (text.match(/^Subject:\s*(.+)$/im) || [])[1] || '';
  return { addrs, orig };
}
