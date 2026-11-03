// PM · Weekly scorecard. Every Monday morning one message: how many decisions the PM made last week, how many of them
// had to be corrected (by Harsh, by the second reader or by the system check), the accuracy that gives, which lessons
// came back, how the nightly test bank did, what the AI cost, and which kinds of email have earned autopilot.
// Everything is counted from what the PM already saves (PM OUTBOX, Agent Log, PM LESSONS, AI SPEND). No AI calls.
import { notion, plain, queryAll } from './notion.js';
import { DS } from './tools.js';
import { OUTBOX_DS } from './outbox.js';
import { LESSONS_DS } from './lessons.js';
import { AI_SPEND_DS } from './aispend.js';

// Emails that never go on autopilot, whatever their record: money, prices and new deals always wait for a person
export const NEVER_AUTO = ['Invoice', 'Payment chase', 'Billing details', 'Reply', 'Counter', 'Quote', 'Close deal', 'Decline', 'Rate hold', 'Other'];
export const EARN_DAYS = 14;
export const EARN_MIN_SENT = 8;

const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
const createdAfter = (iso) => ({ timestamp: 'created_time', created_time: { on_or_after: iso } });

export async function outboxSince(days) {
  const rows = await queryAll(OUTBOX_DS, createdAfter(since(days)), { useCache: false }).catch(() => []);
  return rows.map((p) => ({ kind: plain(p.properties?.Kind), status: plain(p.properties?.Status), error: plain(p.properties?.Error) || '', why: plain(p.properties?.Why) || '', created: p.created_time }));
}

// Per email kind: how many went out, and how many a person (or the check) had to stop or change
export function kindRecord(rows = [], edits = []) {
  const out = {};
  for (const r of rows) {
    const k = r.kind || 'Other';
    const o = (out[k] ||= { sent: 0, rejected: 0, autoRejected: 0, edited: 0, waiting: 0 });
    if (r.status === 'Sent') o.sent++;
    else if (r.status === 'Rejected') (/^Auto-rejected/i.test(r.error) ? o.autoRejected++ : o.rejected++);
    else if (r.status === 'Draft') o.waiting++;
  }
  for (const e of edits) { const k = Object.keys(out).find((kk) => new RegExp(`\\b${kk}\\b`, 'i').test(e)); if (k) out[k].edited++; }
  return out;
}

// Kinds with a clean record over the last two weeks that aren't on autopilot yet
export function earnedKinds(record = {}, autoNow = []) {
  return Object.entries(record).filter(([k, o]) => !NEVER_AUTO.includes(k) && !autoNow.includes(k) && o.sent >= EARN_MIN_SENT && !o.rejected && !o.autoRejected && !o.edited).map(([k, o]) => ({ kind: k, sent: o.sent }));
}

export function accuracy({ decisions, corrections }) {
  if (!decisions) return null;
  return Math.max(0, Math.round((1 - corrections / decisions) * 1000) / 10);
}

export async function buildScorecard({ days = 7 } = {}) {
  const rows = await outboxSince(days);
  const lessons = await queryAll(LESSONS_DS, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since(days) } }, { useCache: false }).catch(() => []);
  const L = lessons.map((p) => ({ lesson: plain(p.properties?.Lesson), source: plain(p.properties?.Source), seen: Number(plain(p.properties?.['Times Seen']) || 1), created: p.created_time, example: plain(p.properties?.Example) || '' }));
  const fresh = L.filter((l) => Date.parse(l.created) >= Date.parse(since(days)) && l.source !== 'Rulebook');
  const repeated = L.filter((l) => l.seen > 1 && Date.parse(l.created) < Date.parse(since(days)));
  const editsByKind = fresh.filter((l) => l.source === 'Draft edit').map((l) => l.example);
  const record = kindRecord(rows, editsByKind);
  const log = await queryAll(DS.agentLog, { and: [{ property: 'Event', title: { starts_with: 'Second read' } }, createdAfter(since(days))] }, { useCache: false }).catch(() => []);
  const sr = { agree: 0, disagree: 0, flags: 0 };
  for (const p of log) { const t = plain(p.properties?.Event) || ''; if (/DISAGREES/.test(t)) sr.disagree++; else if (/flags/.test(t)) sr.flags++; else sr.agree++; }
  const tests = await queryAll(DS.agentLog, { and: [{ property: 'Event', title: { starts_with: 'Test bank' } }, createdAfter(since(days))] }, { useCache: false }).catch(() => []);
  const lastTest = tests.sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))[0];
  const spend = await notion('POST', `/data_sources/${AI_SPEND_DS}/query`, { page_size: 1, filter: { property: 'Month', title: { equals: new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 7) } } }).then((r) => (r.results || [])[0]).catch(() => null);
  const totals = Object.values(record).reduce((a, o) => ({ sent: a.sent + o.sent, rejected: a.rejected + o.rejected, autoRejected: a.autoRejected + o.autoRejected, edited: a.edited + o.edited }), { sent: 0, rejected: 0, autoRejected: 0, edited: 0 });
  const decisions = totals.sent + totals.rejected + totals.autoRejected + sr.agree + sr.disagree;
  const corrections = totals.rejected + totals.autoRejected + totals.edited + sr.disagree + fresh.filter((l) => ['Harsh correction', 'System check'].includes(l.source)).length;
  const { AUTO_KINDS } = await import('./heartbeat.js');
  const earned = earnedKinds(kindRecord(await outboxSince(EARN_DAYS), editsByKind), [...AUTO_KINDS, ...(await autopilotKinds())]);
  return {
    days, decisions, corrections, accuracy: accuracy({ decisions, corrections }), totals, record, sr,
    newLessons: fresh.map((l) => l.lesson), repeated: repeated.map((l) => `${l.lesson} (${l.seen}×)`),
    test: lastTest ? plain(lastTest.properties?.Event) : null,
    spend: spend ? { usd: Number(plain(spend.properties?.['Spent USD']) || 0), budget: Number(plain(spend.properties?.['Budget USD']) || 0) } : null,
    earned,
  };
}

export function scorecardText(s) {
  const lines = [`📊 **PM scorecard, last ${s.days} days**`];
  lines.push(s.accuracy === null ? '• Not enough decisions yet to score.' : `• **${s.accuracy}% right**: ${s.decisions} decisions, ${s.corrections} needed correcting`);
  lines.push(`• Emails: ${s.totals.sent} sent, ${s.totals.edited} changed by you first, ${s.totals.rejected} rejected by you, ${s.totals.autoRejected} stopped by the check`);
  if (s.sr.agree + s.sr.disagree) lines.push(`• Second reader: agreed ${s.sr.agree}, disagreed ${s.sr.disagree}, flagged ${s.sr.flags} drafts`);
  if (s.test) lines.push(`• ${s.test}`);
  if (s.newLessons.length) lines.push(`• New lessons: ${s.newLessons.slice(0, 5).join('; ')}${s.newLessons.length > 5 ? ` +${s.newLessons.length - 5}` : ''}`);
  if (s.repeated.length) lines.push(`• Came back again: ${s.repeated.slice(0, 4).join('; ')}`);
  if (s.spend) lines.push(`• AI cost this month so far: $${s.spend.usd.toFixed(2)}${s.spend.budget ? ` of the $${s.spend.budget} budget` : ''}`);
  if (s.earned.length) lines.push(`• Ready for autopilot (two clean weeks): ${s.earned.map((e) => `${e.kind} (${e.sent} sent, none corrected)`).join(', ')}. Tell me "autopilot ${s.earned[0].kind} on" to let it send on its own with the 30-minute hold.`);
  return lines.join('\n');
}

// Kinds Harsh switched on for autopilot from WhatsApp or the chat (latest setting per kind wins)
let autoCache = { at: 0, kinds: [] };
export async function autopilotKinds() {
  if (Date.now() - autoCache.at < 10 * 60e3) return autoCache.kinds;
  const rows = await queryAll(DS.agentLog, { property: 'Event', title: { starts_with: 'Autopilot setting:' } }, { useCache: false }).catch(() => []);
  const latest = {};
  for (const p of rows.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time))) {
    const m = (plain(p.properties?.Event) || '').match(/^Autopilot setting:\s*(.+?)\s+(on|off)\s*$/i);
    if (m) latest[m[1]] = m[2].toLowerCase() === 'on';
  }
  autoCache = { at: Date.now(), kinds: Object.entries(latest).filter(([k, on]) => on && !NEVER_AUTO.includes(k)).map(([k]) => k) };
  return autoCache.kinds;
}
