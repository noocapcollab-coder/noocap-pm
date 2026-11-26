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
import { checkDraft } from './outbox.js';
import { liveLinkOwed, brandWaitingOnUs } from './heartbeat.js';
import { latestPart } from './briefs.js';

export const TB_DS = process.env.TEST_BANK_DS || 'f525b932-565c-40b3-83bd-5bea95a9e16f';
const LESSONS_DS = process.env.LESSONS_DS || '1e7ad6d4-df5d-4c01-84aa-59cb1d2e86d8';
const SOURCES = ['Built in', 'Draft rejected', 'Draft edit', 'Harsh correction', 'System check', 'Claude'];
// Harsh, Nov 21 ("we can't afford this"): the bank ran 19 times in a day, one run per commit, ~1,500 Gemini calls a day
// on testing alone, more than the real email work. Now a commit only triggers a run when it changed how emails are read
// or written (EMAIL_FILES), and runs batch up: at most one every 3 hours for commits, 6 hours for new lessons.
export const GATE_GAP_MIN = { commit: 180, lesson: 360 };
export const EMAIL_FILES = /^(lib\/(inbox|outbox|claude|gemini|lessons|memory|replytemplates|evals|testbank|verify|wiki|briefs|leads)\.js|prompts\/)/;
// Did the commits between two deploys touch the email reader or writer? true / false / null (couldn't tell)
const compared = new Map();
export async function touchesEmail(base, head) {
  if (!base || !head || base === head) return null;
  const k = `${base}...${head}`;
  if (compared.has(k)) return compared.get(k);
  try {
    const r = await fetch(`https://api.github.com/repos/noocapcollab-coder/noocap-pm/compare/${k}`, { headers: { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const d = await r.json();
    const hit = (d.files || []).some((f) => EMAIL_FILES.test(f.filename || ''));
    // GitHub lists at most 300 files: a huge range counts as touching email, to be safe
    const out = hit || (d.files || []).length >= 300;
    compared.set(k, out);
    return out;
  } catch { return null; }
}
// Stop starting cases after BUDGET_MS, and give up on one case after CASE_MS, so the last batch plus writing every
// result back to Notion (about 1 s a case) always ends inside the 300 s function limit. With 230 s and no cap per case,
// the run at 16:56 UTC on Nov 19 was killed at 300 s (Vercel timeout on /api/daily): its PM RUNS row stayed "Running"
// and no result was written, so a regression from that commit could not be seen (bug hunter).
export const BUDGET_MS = 170 * 1000;
export const CASE_MS = 55 * 1000;
export const FN_LIMIT_MS = 300 * 1000;
// A case that takes longer than ms counts as "could not run" (not judged), so one slow model call can't sink the run. Pure.
export function withCaseTimeout(p, ms = CASE_MS) {
  let t;
  const cap = new Promise((ok) => { t = setTimeout(() => ok({ fails: [`could not run: timed out after ${Math.round(ms / 1000)} s`], error: true }), ms); });
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), cap]);
}
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
  readerStageFixes(x, c.deal, I);
  return { fails: judge(c, x), got: x.event };
}

// The corrections handleInboxEmail makes to the reader's event from the deal's stage. runReader called readEmail alone,
// so a case fixed in handleInboxEmail kept failing. Bug hunter Nov 23: aiinspo-duncan-script-notes-called-video-draft-
// nov23 stayed "not fixed yet" at 07:07 UTC though 2c8c0bd (04:08 UTC) turns those notes into script_changes in
// production. A bank deal has no edit rows, so a cut counts as sent only when the case says so (deal.cutSent).
// Bug hunter Nov 25: a money stage (Invoiced, Paid) from the reader is never written in production (aiStage drops it;
// Paid only comes from a payment_confirmed event with proof), so kylon-publish-chase was reported BROKEN after 34fd4ee
// for "wanted to set the stage to Paid", a stage the PM cannot set. The bank now judges the stage production would use.
export function readerStageFixes(x, deal = {}, I) {
  if (I.scriptNotesNotCut(x, deal?.stage) && !deal?.cutSent) x.event = 'script_changes';
  if (x && x.deal_stage) x.deal_stage = I.aiStage(x.deal_stage);
  return x;
}

// Issues checkDraft finds in a writer case's draft (filler, placeholder, made-up code). In production such a draft is
// held in Approvals for Harsh and never sends, so the test bank scores it as held instead of as a repeated mistake.
// System check, Nov 22: capcut-chris-publish-asap-nov19 was reported BROKEN after b429dc7 (inbox card moves) and
// 6fe31ef (Drive folders), neither of which touches the writer; the failing draft "We are getting the video posted
// right now." is caught by FILLER and would have been held, but runWriter scored the bare body. Pure.
export function heldByGuards(body, creator = '') {
  return checkDraft({ body: String(body || ''), creator: creator || '' }).issues;
}

// A writer case whose email the heartbeat would never draft for. The bank calls writeEmail directly, so it skipped the
// heartbeat's own gates and scored drafts production never makes. Bug hunter Nov 23: gamut-lindsay-chase-without-live-
// link-nov20 was reported "1 broken by this change" in the Nov 22 nightly run though liveLinkOwed (98b4057) stops that
// payment chase before it is written; a false regression switches the newest lesson off or marks a commit for undoing.
// The brand's newest email stands in for the Next Action / OPEN NOW the reader writes from it. Pure.
export function heartbeatSkip(c = {}) {
  const kind = c.expect?.kind || 'Reply';
  const deal = { ...(c.deal || {}), nextAction: [c.deal?.nextAction, String(c.email?.text || '').replace(/\s+/g, ' ')].filter(Boolean).join(' ') };
  if (liveLinkOwed(deal, kind)) return 'no payment chase while the live link the brand asked for is unsent (liveLinkOwed)';
  // The case's email is the brand's newest message and still unanswered (runWriter tells the writer to answer it), so a
  // billing-details ask is skipped like brandWaitingOnUs does in draft(). A payment chase is never held (Harsh, Nov 23),
  // so it stays scored. Bug hunter Nov 25: dreamina-chris-billing-over-hashtags-nov20 was reported BROKEN at 12:07 and
  // 15:16 UTC with a billing reminder production would not have written over Jenny's hashtag question.
  if (kind !== 'Payment chase') {
    const timed = { lastBrand: c.deal?.lastBrand || new Date().toISOString(), lastOur: c.deal?.lastOur || '' };
    if (brandWaitingOnUs(timed, kind)) return "no billing-details ask while the brand's latest email is waiting for our answer (brandWaitingOnUs)";
  }
  return '';
}

// What the writer is given as the brand's email in a Writer case. Production writes from the deal's transcript, where
// every message is stored without the history quoted under it (memory.js), so the bank does the same: the newest part
// is the message to answer, and anything quoted under it is shown apart as earlier history. System check Nov 26 night:
// capcut-brad-answer-newest-nov19 was reported as a regression after cafe617 and again after 1a2ecbf (neither touches the
// writer) because the case's raw Zoho text ("---- On Tue … wrote ---") was handed over whole, so the writer answered
// Alisa's quoted Nov 17 question, which production never sees as the latest message. Pure.
export function writerMemory(email = {}) {
  const text = String(email.text || '');
  const latest = latestPart(text).trim();
  const quoted = text.slice(latestPart(text).length).trim();
  return `The brand's latest message (answer this one, and only this one):\nFrom: ${email.from || ''}\nSubject: ${email.subject || ''}\n${latest}`
    + (quoted ? `\n\nEarlier in the thread, quoted under their message (already handled, never answer it again):\n${quoted.slice(0, 1500)}` : '');
}

async function runWriter(c) {
  const { writeEmail } = await import('./outbox.js');
  const { claude, HAIKU } = await import('./claude.js');
  const e = c.expect || {};
  const skip = heartbeatSkip(c);
  if (skip) return { fails: [], got: `not drafted by the heartbeat: ${skip}` };
  const deal = { ...c.deal, memory: writerMemory(c.email) };
  const mail = await writeEmail({ kind: e.kind || 'Reply', deal, facts: {} });
  const body = String(mail.body || '').replace(/<br\s*\/?>/g, '\n').trim();
  if (!body) return { fails: ['wrote nothing'], got: '' };
  // A draft the outbox guards would hold for Harsh never reaches the brand, so it cannot repeat the mistake
  const held = heldByGuards(body, c.deal?.creator);
  if (held.length) return { fails: [], got: `held for Harsh (${held[0].slice(0, 80)}): ${body}` };
  const l = e.lesson || {};
  const out = await claude({
    _job: 'test-bank', model: HAIKU, max_tokens: 300,
    system: 'You check one email draft against one lesson an AI project manager learned from a past mistake. Say repeats_mistake true only when the new draft clearly does what the lesson says never to do, or clearly fails to do what it says to do. Missing facts the writer was never given (rates, dates, links) are not a mistake. Judge only this lesson.',
    tools: [VERDICT], tool_choice: { type: 'tool', name: 'verdict' },
    messages: [{ role: 'user', content: `LESSON: ${l.lesson || ''}\nDo: ${l.do || ''}\nNever: ${l.never || ''}\n\nTHE BRAND'S EMAIL:\n${String(c.email.text).slice(0, 2500)}\n\nTHE OLD DRAFT THAT WAS REJECTED FOR THIS:\n${String(e.bad || '').slice(0, 1500)}\n${e.good ? `\nWHAT HARSH SENT INSTEAD:\n${String(e.good).slice(0, 1500)}\n` : ''}\nTHE NEW DRAFT TO CHECK:\n${body.slice(0, 2500)}` }],
  });
  const v = (out.content || []).find((b) => b.type === 'tool_use')?.input || {};
  return { fails: v.repeats_mistake ? [`repeats the mistake: ${String(v.reason || l.lesson).slice(0, 200)}`] : [], got: body.slice(0, 600) };
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

// A case that passed before and fails now is run once more before it counts as a regression; a pass the second time
// means the free-tier writer was just noisy. System check, Nov 21: three commits in a row were reported BROKEN (6b97eaf,
// e681588, 73c992c) on a different set of writer cases each time, though none of them touched the writer (a billing
// guard, a filler regex, the heartbeat clock), and a false regression after a lesson switches a good lesson off.
// rerun(case) -> result. Returns results with confirmed fails kept and noisy ones replaced by the passing rerun.
export async function confirmRegressions(cases, results, rerun, { deadline = Infinity } = {}) {
  const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
  const suspects = results.filter((r) => !r.error && r.fails?.length && byId[r.id]?.everPassed);
  if (!suspects.length || Date.now() > deadline) return results;
  const again = Object.fromEntries(await Promise.all(suspects.map(async (r) => [r.id, await Promise.resolve(rerun(byId[r.id])).catch(() => ({ error: true, fails: ['could not run'] }))])));
  return results.map((r) => {
    const a = again[r.id];
    if (!a || a.error || a.fails?.length) return r; // failed twice (or the rerun could not run): keep the fail
    return { ...r, ...a, fails: [], flaky: r.fails };
  });
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
export function gateReason({ last, commit, lessonAt, now = Date.now(), emailChange = true }) {
  const mins = last ? (now - Date.parse(last.at)) / 60000 : Infinity;
  // No gate run yet for this commit (older nightly runs did not record one) counts as a new commit. Only commits that
  // changed the email reader or writer count; when GitHub couldn't say (null), it waits 6 hours instead of 3.
  const commitGap = emailChange === null ? GATE_GAP_MIN.lesson : GATE_GAP_MIN.commit;
  if (commit && (!last || commit !== last.commit) && emailChange !== false && mins >= commitGap) return 'commit';
  if (lessonAt && (!last || !last.lessonAt || Date.parse(lessonAt) > Date.parse(last.lessonAt)) && mins >= GATE_GAP_MIN.lesson) return 'lesson';
  return null;
}

export async function gateDue() {
  const [last, lessonAt] = await Promise.all([lastGate(), newestLesson()]);
  const commit = commitNow();
  const emailChange = last?.commit && commit && last.commit !== commit ? await touchesEmail(last.commit, commit) : true;
  return { reason: gateReason({ last, commit, lessonAt, emailChange }), last, lessonAt };
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

// What a run leaves in the case's Last Note. A failing writer case keeps the draft that failed, so whoever looks into
// it can see the exact words that slipped past the guards; without it every fix to the FILLER guard was a guess
// (capcut-chris-publish-asap-nov19 failed again at 19:30 UTC on Nov 21 with only 'promises to post right away'; bug hunter).
export function resultNote(r) {
  const got = String(r?.got || '').replace(/\s+/g, ' ').trim();
  if (!r?.fails?.length) return `ok (${got.slice(0, 120)})`;
  return `${r.fails.join('; ')}${got ? ` · draft: "${got.slice(0, 600)}"` : ''}`.slice(0, 1900);
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
      results.push(...await Promise.all(cases.slice(i, i + 5).map(async (c) => ({ id: c.id, kind: c.kind, why: c.why, ...(await withCaseTimeout(runCase(c))) }))));
    }
    // Re-run would-be regressions once (only while there is still room before the function limit)
    const checked = await confirmRegressions(cases, results, (c) => withCaseTimeout(runCase(c)), { deadline: started + BUDGET_MS + 15000 });
    results.splice(0, results.length, ...checked);
    const { regressions, stillBroken, fixed } = compare(cases, results);
    // Write each result back to its row (one at a time, gentle on Notion)
    const today = new Date().toISOString();
    for (const r of results) {
      if (r.error) continue;
      const c = cases.find((x) => x.id === r.id);
      const pass = !r.fails.length;
      await notion('PATCH', `/pages/${c.page}`, { properties: { 'Last Result': { select: { name: pass ? 'Pass' : 'Fail' } }, 'Last Run': { date: { start: today } }, 'Last Note': { rich_text: rt(resultNote(r)) }, ...(pass ? { 'Ever Passed': { checkbox: true } } : {}) } }).catch(() => {});
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
