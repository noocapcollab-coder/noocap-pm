// PM · Test bank that grows by itself, and the gate that keeps a change only when the whole bank still passes
// (Harsh, 13 Nov 2026: "every new lesson or code fix adds its email to the test bank, and the bank runs before a
// change is kept").
//
// The bank lives in Notion (PM TEST BANK). Two kinds of case:
//   Reader: a real brand email and what it means (event, flags, stage). The PM's own reader must read it that way.
//   Writer: a real brand email, the draft Harsh rejected or rewrote, and the lesson it taught. The PM writes the
//           reply again and a checker says whether the new draft repeats the mistake.
// Cases are added automatically: a draft rejected with a reason or rewritten by Harsh adds a writer case, a correction
// in chat that names the email adds a reader case, and the system check adds both kinds when it fixes something.
// The built-in cases in lib/evalcases.js are copied in on the first run.
//
// The gate: after every deploy (new commit) and every new lesson, the heartbeat starts a full run. A case that
// passed before and fails now is a regression. A regression after a new lesson switches that lesson off; a regression
// after a code change is reported for the system check to revert. A new case that has never passed means the lesson
// alone did not fix the mistake, so it is flagged for a code fix. All bank runs use Gemini's free tier (no spend).
import { notion, plain, queryAll } from './notion.js';

export const TB_DS = process.env.TEST_BANK_DS || 'f525b932-565c-40b3-83bd-5bea95a9e16f';
const LESSONS_DS = process.env.LESSONS_DS || '1e7ad6d4-df5d-4c01-84aa-59cb1d2e86d8';
const SOURCES = ['Built in', 'Draft rejected', 'Draft edit', 'Harsh correction', 'System check', 'Claude'];
export const GATE_GAP_MIN = { commit: 30, lesson: 180 }; // a new commit is tested within ~30 min, new lessons batch up
const BUDGET_MS = 230 * 1000; // stop starting cases after this, so the run always finishes inside the function limit
const rtChunks = (s) => { const t = String(s || ''); const out = []; for (let i = 0; i < t.length && out.length < 50; i += 1900) out.push({ type: 'text', text: { content: t.slice(i, i + 1900) } }); return out.length ? out : [{ type: 'text', text: { content: '' } }]; };
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
const fullText = (p) => (p?.rich_text || []).map((t) => t.plain_text).join('');
export const slugId = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'case';
const commitNow = () => (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);

// ---------- cases ----------
export function rowToCase(p) {
  const g = (n) => plain(p.properties?.[n]);
  let data = {};
  try { data = JSON.parse(fullText(p.properties?.Data) || '{}'); } catch { data = {}; }
  return {
    page: p.id, id: g('Case'), kind: g('Kind') || 'Reader', why: g('Why') || '', source: g('Source') || '',
    lesson: g('Lesson') || '', active: !!p.properties?.Active?.checkbox, last: g('Last Result') || 'Not run',
    everPassed: !!p.properties?.['Ever Passed']?.checkbox, added: p.created_time, ...data,
  };
}

// A case is worth keeping only with a real email to test on and something to check
export function validCase(c = {}) {
  if (!String(c.email?.text || '').trim()) return false;
  if ((c.kind || 'Reader') === 'Writer') return !!(c.expect?.lesson?.lesson || c.expect?.lesson?.never || c.expect?.lesson?.do);
  const e = c.expect || {};
  return !!(e.event || e.not_event || e.not_stage || (e.flags || []).length);
}

export async function addCase({ id, kind = 'Reader', why = '', email, deal = {}, expect = {}, lesson = '', source = 'Claude' }) {
  try {
    const c = { kind, email: { from: email?.from || '', subject: email?.subject || '', threadId: email?.threadId || deal?.threadId || '', text: String(email?.text || '').slice(0, 6000) }, deal: { brand: deal.brand || '', creator: deal.creator || '', stage: deal.stage || '', threadId: deal.threadId || email?.threadId || '', ...(deal.linkedVideo ? { linkedVideo: deal.linkedVideo } : {}) }, expect };
    if (!validCase(c)) return { skipped: 'no email text or nothing to check' };
    const name = slugId(id || `${deal.brand || 'email'} ${kind} ${new Date().toISOString().slice(0, 10)} ${Math.random().toString(36).slice(2, 6)}`);
    const have = await notion('POST', `/data_sources/${TB_DS}/query`, { page_size: 1, filter: { property: 'Case', title: { equals: name } } }).catch(() => ({ results: [] }));
    if ((have.results || []).length) return { exists: name };
    await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: TB_DS }, properties: {
      Case: { title: rt(name) }, Kind: { select: { name: kind === 'Writer' ? 'Writer' : 'Reader' } }, Why: { rich_text: rt(why) },
      Data: { rich_text: rtChunks(JSON.stringify({ email: c.email, deal: c.deal, expect })) }, Lesson: { rich_text: rt(lesson) },
      Source: { select: { name: SOURCES.includes(source) ? source : 'Claude' } }, Active: { checkbox: true }, 'Last Result': { select: { name: 'Not run' } },
    } });
    return { added: name };
  } catch (e) { console.error('addCase', e.message); return null; }
}

// Harsh rejected or rewrote a draft and a lesson came out of it: the brand email it answered becomes a writer case
export async function caseFromDraft(d = {}, learned, { source = 'Draft rejected', reason = '', after = '' } = {}) {
  const l = learned?.lesson;
  if (!l || !String(d.context || '').trim()) return null;
  return addCase({
    id: `${d.brand || d.creator || 'brand'} ${d.kind || 'reply'} ${String(d.id || '').replace(/-/g, '').slice(0, 8)}`,
    kind: 'Writer', why: `${source}${reason ? `: ${reason}` : ''}`.slice(0, 400), source,
    email: { from: d.to || '', subject: d.subject || '', threadId: d.threadId || '', text: d.context },
    deal: { brand: d.brand || '', creator: d.creator || '', threadId: d.threadId || '' },
    expect: { kind: d.kind || 'Reply', lesson: { lesson: l.lesson, do: l.do, never: l.never }, bad: String(d.body || '').replace(/<br\s*\/?>/g, '\n').slice(0, 1500), ...(after ? { good: String(after).replace(/<br\s*\/?>/g, '\n').slice(0, 1500) } : {}) },
    lesson: l.lesson,
  });
}

export async function loadBank() {
  const pages = await queryAll(TB_DS, { property: 'Active', checkbox: { equals: true } }, { useCache: false });
  return pages.map(rowToCase).filter(validCase);
}

// The cases in lib/evalcases.js, copied into Notion once so their results are tracked like every other case
async function seedBuiltIn(have) {
  const { CASES } = await import('./evalcases.js');
  const names = new Set(have.map((c) => c.id));
  let n = 0;
  for (const c of CASES) {
    if (names.has(slugId(c.id))) continue;
    const r = await addCase({ id: c.id, kind: 'Reader', why: c.why, email: c.email, deal: c.deal, expect: c.expect, source: 'Built in' });
    if (r?.added) n++;
  }
  return n;
}

// ---------- running ----------
const VERDICT = {
  name: 'verdict',
  description: 'Say whether the new draft repeats the mistake the lesson is about.',
  input_schema: { type: 'object', properties: { repeats_mistake: { type: 'boolean' }, reason: { type: 'string', description: 'One short sentence' } }, required: ['repeats_mistake', 'reason'] },
};

async function runReader(c) {
  const I = await import('./inbox.js');
  const { judge } = await import('./evals.js');
  const email = { ...c.email, date: new Date().toISOString(), messageId: `eval-${c.id}`, attachments: [] };
  const { x } = await I.readEmail(email, [{ ...c.deal }], '');
  I.applyTextGuards(x, email);
  return { fails: judge(c, x), got: x.event };
}

async function runWriter(c) {
  const { writeEmail } = await import('./outbox.js');
  const { claude, HAIKU } = await import('./claude.js');
  const e = c.expect || {};
  const deal = { ...c.deal, memory: `The brand's latest message (answer this one):\nFrom: ${c.email.from}\nSubject: ${c.email.subject}\n${c.email.text}` };
  const mail = await writeEmail({ kind: e.kind || 'Reply', deal, facts: {} });
  const body = String(mail.body || '').replace(/<br\s*\/?>/g, '\n').trim();
  if (!body) return { fails: ['wrote nothing'], got: '' };
  const l = e.lesson || {};
  const out = await claude({
    _job: 'test-bank', model: HAIKU, max_tokens: 300,
    system: 'You check one email draft against one lesson an AI project manager learned from a past mistake. Say repeats_mistake true only when the new draft clearly does what the lesson says never to do, or clearly fails to do what it says to do. Missing facts the writer was never given (rates, dates, links) are not a mistake. Judge only this lesson.',
    tools: [VERDICT], tool_choice: { type: 'tool', name: 'verdict' },
    messages: [{ role: 'user', content: `LESSON: ${l.lesson || ''}\nDo: ${l.do || ''}\nNever: ${l.never || ''}\n\nTHE BRAND'S EMAIL:\n${String(c.email.text).slice(0, 2500)}\n\nTHE OLD DRAFT THAT WAS REJECTED FOR THIS:\n${String(e.bad || '').slice(0, 1500)}\n${e.good ? `\nWHAT HARSH SENT INSTEAD:\n${String(e.good).slice(0, 1500)}\n` : ''}\nTHE NEW DRAFT TO CHECK:\n${body.slice(0, 2500)}` }],
  });
  const v = (out.content || []).find((b) => b.type === 'tool_use')?.input || {};
  return { fails: v.repeats_mistake ? [`repeats the mistake: ${String(v.reason || l.lesson).slice(0, 200)}`] : [], got: body.slice(0, 300) };
}

export async function runCase(c) {
  try { return c.kind === 'Writer' ? await runWriter(c) : await runReader(c); }
  catch (e) { return { fails: [`could not run: ${String(e.message || e).slice(0, 140)}`], error: true }; }
}

// Compare a run with what the cases did before: a case that passed before and fails now is a regression, a case that
// has never passed is still waiting for a fix (the lesson alone was not enough). Cases that errored are not judged.
export function compare(cases, results) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const regressions = [], stillBroken = [], fixed = [];
  for (const c of cases) {
    const r = byId[c.id];
    if (!r || r.error) continue;
    const pass = !r.fails.length;
    if (!pass && c.everPassed) regressions.push(r);
    else if (!pass) stillBroken.push(r);
    else if (pass && c.last === 'Fail') fixed.push(r);
  }
  return { regressions, stillBroken, fixed };
}

// Newest active lesson (so a new lesson triggers a run) and the last bank run (so a run is not repeated)
async function lastGate() {
  const r = await notion('POST', `/data_sources/${(await import('./tools.js')).DS.agentLog}/query`, {
    page_size: 1, sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    filter: { or: [{ property: 'Event', title: { starts_with: 'Test bank' } }, { property: 'Event', title: { starts_with: 'Bank gate' } }] },
  }).catch(() => ({ results: [] }));
  const p = (r.results || [])[0];
  if (!p) return null;
  const details = fullText(p.properties?.Details);
  const m = details.match(/"commit":"([0-9a-f]*)","lessonAt":"([^"]*)"/);
  return { at: p.created_time, commit: m?.[1] || '', lessonAt: m?.[2] || '' };
}

async function newestLesson() {
  const r = await notion('POST', `/data_sources/${LESSONS_DS}/query`, { page_size: 1, filter: { property: 'Active', checkbox: { equals: true } }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }).catch(() => ({ results: [] }));
  return (r.results || [])[0]?.created_time || '';
}

// Should the heartbeat start a gate run now? Pure, so it is tested.
export function gateReason({ last, commit, lessonAt, now = Date.now() }) {
  const mins = last ? (now - Date.parse(last.at)) / 60000 : Infinity;
  // No gate run yet for this commit (older nightly runs did not record one) counts as a new commit
  if (commit && (!last || commit !== last.commit) && mins >= GATE_GAP_MIN.commit) return 'commit';
  if (lessonAt && (!last || !last.lessonAt || Date.parse(lessonAt) > Date.parse(last.lessonAt)) && mins >= GATE_GAP_MIN.lesson) return 'lesson';
  return null;
}

export async function gateDue() {
  const [last, lessonAt] = await Promise.all([lastGate(), newestLesson()]);
  return { reason: gateReason({ last, commit: commitNow(), lessonAt }), last, lessonAt };
}

// Heartbeat hook: start a gate run in its own function call (it takes minutes) and return straight away
export async function maybeStartGate() {
  try {
    const due = await gateDue();
    if (!due.reason) return null;
    const base = process.env.PM_PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
    if (!base || !process.env.CRON_SECRET) return null;
    // The marker stops the next heartbeat from starting a second run while this one works
    const { log } = await import('./briefs.js');
    await log({ event: `Bank gate · running after a new ${due.reason}`, outcome: 'Rule', email: { messageId: '' }, details: JSON.stringify({ commit: commitNow(), lessonAt: due.lessonAt, since: due.last }), area: 'System' });
    fetch(`${base.replace(/\/$/, '')}/api/daily?gate=${due.reason}&since=${encodeURIComponent(due.last?.lessonAt || '')}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(4000) }).catch(() => {});
    return due.reason;
  } catch (e) { console.error('maybeStartGate', e.message); return null; }
}

// The whole bank, then the verdict. reason: 'nightly' | 'commit' | 'lesson' | 'manual'. since: lessons created after
// this time are the ones a lesson regression switches off.
export async function runBank({ reason = 'manual', since = '', notify = true } = {}) {
  const { freeOnly } = await import('./gemini.js');
  return freeOnly.run(true, async () => {
    const started = Date.now();
    let cases = await loadBank().catch(() => []);
    if (await seedBuiltIn(cases).catch(() => 0)) cases = await loadBank();
    const lessonAt = await newestLesson();
    const results = [];
    let skipped = 0;
    for (let i = 0; i < cases.length; i += 5) {
      if (Date.now() - started > BUDGET_MS) { skipped = cases.length - i; break; }
      results.push(...await Promise.all(cases.slice(i, i + 5).map(async (c) => ({ id: c.id, kind: c.kind, why: c.why, ...(await runCase(c)) }))));
    }
    const { regressions, stillBroken, fixed } = compare(cases, results);
    // Write each result back to its row (one at a time, gentle on Notion)
    const today = new Date().toISOString();
    for (const r of results) {
      if (r.error) continue;
      const c = cases.find((x) => x.id === r.id);
      const pass = !r.fails.length;
      await notion('PATCH', `/pages/${c.page}`, { properties: { 'Last Result': { select: { name: pass ? 'Pass' : 'Fail' } }, 'Last Run': { date: { start: today } }, 'Last Note': { rich_text: rt(pass ? `ok (${String(r.got || '').slice(0, 120)})` : r.fails.join('; ')) }, ...(pass ? { 'Ever Passed': { checkbox: true } } : {}) } }).catch(() => {});
      await new Promise((ok) => setTimeout(ok, 350));
    }
    // A new lesson broke something that worked: switch the new lessons off (only when no code changed with them)
    const switchedOff = [];
    if (regressions.length && reason === 'lesson' && since) {
      const fresh = await queryAll(LESSONS_DS, { and: [{ property: 'Active', checkbox: { equals: true } }, { timestamp: 'created_time', created_time: { after: since } }] }, { useCache: false }).catch(() => []);
      for (const p of fresh) {
        await notion('PATCH', `/pages/${p.id}`, { properties: { Active: { checkbox: false }, 'How it was fixed': { rich_text: rt(`Switched off by the test bank on ${today.slice(0, 10)}: after this lesson, ${regressions.map((r) => r.id).join(', ')} failed though they passed before.`) } } }).catch(() => {});
        switchedOff.push(plain(p.properties?.Lesson));
      }
    }
    const errors = results.filter((r) => r.error).length;
    const summary = { reason, commit: commitNow(), total: results.length, passed: results.filter((r) => !r.fails.length).length, regressions: regressions.length, stillBroken: stillBroken.length, fixed: fixed.length, errors, skipped };
    const { log, discord } = await import('./briefs.js');
    const date = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
    // commit and lessonAt lead the details so lastGate() can read them even when the rest is cut off
    await log({
      event: `Test bank ${date}: ${summary.passed}/${summary.total} right${reason !== 'nightly' ? ` (after a new ${reason}${summary.commit ? ' ' + summary.commit : ''})` : ''}${regressions.length ? `, ${regressions.length} BROKEN` : ''}`,
      outcome: regressions.length || stillBroken.length ? 'Needs approval' : 'Rule', email: { messageId: '' }, area: 'System',
      details: JSON.stringify({ commit: summary.commit, lessonAt, summary, regressions: regressions.map((r) => `${r.id}: ${r.fails.join('; ')}`), stillBroken: stillBroken.map((r) => r.id), switchedOff }),
    }).catch(() => {});
    if (notify && (regressions.length || (stillBroken.length && reason === 'nightly'))) {
      const lines = [`🧪 **Test bank: ${summary.passed}/${summary.total} right**${reason !== 'nightly' ? ` after a new ${reason}${summary.commit ? ` (${summary.commit})` : ''}` : ''}`];
      if (regressions.length) lines.push(`⛔ Broke ${regressions.length} case${regressions.length > 1 ? 's' : ''} that passed before:`, ...regressions.slice(0, 5).map((r) => `• ${r.id}: ${r.fails.join('; ').slice(0, 160)}`));
      if (switchedOff.length) lines.push(`I switched off the new lesson${switchedOff.length > 1 ? 's' : ''} that caused it: ${switchedOff.join('; ').slice(0, 300)}`);
      else if (regressions.length && reason === 'commit') lines.push('The system check will undo that code change on its next run unless it can fix the cause.');
      if (stillBroken.length) lines.push(`Still not fixed by their lesson (needs a code fix): ${stillBroken.slice(0, 6).map((r) => r.id).join(', ')}`);
      await discord(lines.join('\n'), 'log').catch(() => {});
    }
    return { summary, results, regressions, stillBroken, fixed, switchedOff };
  });
}
