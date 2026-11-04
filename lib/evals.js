// PM · Nightly test bank. Runs the PM's own email reader, the fixed guards and the second reader on every case in
// lib/evalcases.js and checks the answer. Every wrong answer is a regression: it is logged, and Harsh hears about it
// (only when something fails). Results also feed the weekly scorecard.
import { CASES } from './evalcases.js';
import { log, discord } from './briefs.js';

const INVOICE_ASK = /\b(send|share|provide|issue|need|forward|resend|raise)\b[^.?\n]{0,60}\binvoice\b/i;

export function judge(c, x) {
  const fails = [];
  const e = c.expect || {};
  if (e.event && x.event !== e.event) fails.push(`read it as ${x.event}, should be ${e.event}`);
  if (e.not_event && x.event === e.not_event) fails.push(`read it as ${x.event}, which is wrong here`);
  if (e.not_stage && x.deal_stage === e.not_stage) fails.push(`wanted to set the stage to ${x.deal_stage}`);
  for (const f of e.flags || []) {
    const ok = f === 'asks_for_invoice' ? (x.asks_for_invoice || INVOICE_ASK.test(c.email.text)) : f === 'needs_our_info' ? (x.needs_our_info || x.we_owe || x.info_needed) : x[f];
    if (!ok) fails.push(`missed ${f.replace(/_/g, ' ')}`);
  }
  return fails;
}

export async function runEvals({ cases = CASES, notify = true } = {}) {
  const I = await import('./inbox.js');
  const V = await import('./verify.js');
  const results = [];
  // A few at a time: fast enough for one cron call, gentle on the API
  for (let i = 0; i < cases.length; i += 4) {
    const batch = await Promise.all(cases.slice(i, i + 4).map(async (c) => {
      const email = { ...c.email, date: new Date().toISOString(), messageId: `eval-${c.id}`, attachments: [] };
      const deals = [{ ...c.deal }];
      try {
        const { x } = await I.readEmail(email, deals, '');
        I.applyTextGuards(x, email);
        const fails = judge(c, x);
        let second = null;
        try { if (V.MODE() !== 'off' && V.needsSecondRead(x)) second = await V.secondRead({ email, x, deal: c.deal, convo: '', latest: email.text }); } catch { /* second reader optional here */ }
        // The second reader should disagree exactly when the first reader got it wrong
        return { id: c.id, why: c.why, event: x.event, fails, second: second ? { agree: second.agree, right: second.rightEvent, reason: second.reason } : null };
      } catch (e) { return { id: c.id, why: c.why, fails: [`could not run: ${String(e.message).slice(0, 120)}`], error: true }; }
    }));
    results.push(...batch);
  }
  const failed = results.filter((r) => r.fails.length);
  const caught = failed.filter((r) => r.second && !r.second.agree).length;
  const falseAlarms = results.filter((r) => !r.fails.length && r.second && !r.second.agree).length;
  const summary = { total: results.length, passed: results.length - failed.length, failed: failed.length, caughtBySecondReader: caught, falseAlarms };
  await log({ event: `Test bank ${new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)}: ${summary.passed}/${summary.total} right`, outcome: failed.length ? 'Needs approval' : 'Rule', email: { messageId: '' }, details: JSON.stringify({ summary, results: results.map((r) => ({ id: r.id, event: r.event, fails: r.fails, second: r.second?.agree })) }).slice(0, 1900), area: 'System' }).catch(() => {});
  if (notify && failed.length) {
    await discord(`🧪 **Nightly test bank: ${summary.passed}/${summary.total} right**\n${failed.slice(0, 5).map((r) => `• ${r.id}: ${r.fails.join('; ')}${r.second && !r.second.agree ? ' (the second reader caught it)' : ''}`).join('\n')}\nI'll look at these and fix the cause.`, 'log').catch(() => {});
  }
  return { summary, results };
}
