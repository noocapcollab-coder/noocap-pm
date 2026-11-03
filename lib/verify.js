// PM · Second reader. Before the PM acts on a brand email (moves a stage, marks paid, moves a card, pings the script
// writer or an editor) or puts a brand email in Approvals, a second AI pass rereads the same email with the deal's full
// conversation and NOOCAP's rulebook, and checks the first reader's decision. It does not redo the work: it only says
// whether the decision is right. When it disagrees, the PM does nothing on its own and asks Harsh instead.
//
// MODE: 'shadow' logs every verdict to the Agent Log and changes nothing (the dry run), 'on' enforces it.
// SECOND_READ in Vercel overrides the default (shadow | on | off).
import { claude, HAIKU, costOf } from './claude.js';

export const MODE = () => String(process.env.SECOND_READ || DEFAULT_MODE).toLowerCase();
export const DEFAULT_MODE = 'shadow';

// Every mistake Harsh has pointed out, as rules the second reader checks against (mirror of the Claude Project doc
// claude/harsh-corrections.md; keep the two in step)
export const RULES = `NOOCAP rulebook (each line is a mistake that already happened once):
- "Invoice received", "in our payment queue", "scheduled", "will be paid on <date>", "approved for payment" means NOT paid. Only money actually sent, a receipt, a transfer reference, or Stripe showing it paid counts as payment_confirmed.
- "We've paid" with no receipt or reference is a claim: not proof.
- A brand APPROVING the script, even "with feedback" or with their own edited/validated version, and a platform "Next Step: Draft video / waiting on creator submission", is script_approved, never script_changes and never a brief.
- Notes on a script go to the script writer (script_changes); notes on a video/cut go to the editor (video_feedback); neither is a plain reply.
- A brief for the NEXT reel or a second collaboration is a new video, not an update of the finished one.
- A new brand inside an agency thread is a different deal (CapCut is not Zeely).
- Amounts and rates come from what both sides agreed in the thread; a deal for several reels has one total.
- A reply must go to the brand contact of THIS deal and thread, never to another brand's address.
- An email must answer the brand's LATEST message, not an older one.
- No filler promises ("shortly", "within a few hours", "we'll send it today"), no placeholders like [DATE] or [name], no invented dates, prices, links or facts.
- Never mention a price, rate, fee or payment in anything for the script writer or editors.
- When the brand asks for something only NOOCAP has (ad codes, account email, contract, files), that is a question for Harsh, not a promise email.`;

const EVENTS = ['brief', 'price_agreed', 'script_approved', 'script_changes', 'video_feedback', 'invoice_from_creator', 'payment_confirmed', 'brand_reply', 'not_relevant'];

const VERDICT = {
  name: 'verdict',
  description: 'Your check of the first reader\'s decision.',
  input_schema: {
    type: 'object',
    properties: {
      agree: { type: 'boolean', description: 'True if the first reader\'s decision is right and acting on it is safe' },
      right_event: { type: 'string', enum: EVENTS, description: 'What the email really is' },
      wrong_deal: { type: 'boolean', description: 'True if the email belongs to a different deal/brand than the one picked' },
      reason: { type: 'string', description: 'One plain sentence: why you agree, or exactly what is wrong' },
    },
    required: ['agree', 'right_event', 'reason'],
  },
};

const DRAFT_VERDICT = {
  name: 'draft_verdict',
  description: 'Your check of the drafted email.',
  input_schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'True if this email is right to send as it is' },
      problems: { type: 'array', items: { type: 'string' }, description: 'Each concrete problem, one short line each (wrong person, answers an old message, invented fact, promise, placeholder, repeats something already sent, contradicts the conversation)' },
    },
    required: ['ok', 'problems'],
  },
};

// Which first-reader decisions are worth a second look (the ones that change something or reach a person)
export function needsSecondRead(x = {}) {
  if (!x || x.event === 'not_relevant') return false;
  if (x.event !== 'brand_reply') return true;
  return !!(x.needs_reply || x.asks_for_invoice || x.needs_our_info || x.we_owe || String(x.feedback || '').trim());
}

// The first reader's decision, in a few lines the second reader can check
export function decisionText(x = {}, deal = {}) {
  const pick = ['event', 'deal_stage', 'amount', 'currency', 'paid_date', 'needs_reply', 'asks_for_invoice', 'needs_our_info', 'info_needed', 'we_owe', 'is_update', 'new_video', 'video_approved'];
  const lines = pick.filter((k) => x[k] !== undefined && x[k] !== null && x[k] !== '').map((k) => `${k}: ${typeof x[k] === 'object' ? JSON.stringify(x[k]) : x[k]}`);
  if (x.feedback) lines.push(`feedback: ${String(x.feedback).slice(0, 600)}`);
  if (x.approved_script) lines.push(`approved_script: ${String(x.approved_script).slice(0, 400)}`);
  if (x.summary?.length) lines.push(`summary: ${x.summary.slice(0, 4).join(' | ')}`);
  return `Deal picked: ${deal.brand || '?'} x ${deal.creator || '?'} (stage ${deal.stage || '?'}${deal.finalRate ? `, rate ${deal.finalRate}` : ''})\n${lines.join('\n')}`;
}

export async function secondRead({ email, x, deal, convo = '', latest = '' }) {
  const lessons = await (await import('./lessons.js')).lessonsFor(`${email.subject || ''}\n${latest || email.text || ''}\n${x.event}`).catch(() => '');
  const out = await claude({
    _job: 'second-read',
    model: HAIKU,
    max_tokens: 400,
    system: `You are the second reader for NOOCAP Media's project manager (an agency that runs sponsored-video deals for creators). Another AI already read a brand email and decided what it means. Your only job is to check that decision against the email, the deal's full conversation and the rulebook. Be strict: if the decision would make the PM do something wrong (mark paid, move a stage or card, ping the wrong person, answer the wrong thing), disagree and say exactly why. If it is right, agree.\n\n${RULES}${lessons ? '\n\n' + lessons : ''}`,
    tools: [VERDICT],
    tool_choice: { type: 'tool', name: 'verdict' },
    messages: [{ role: 'user', content: `${convo ? `Full earlier conversation in this deal (oldest first):\n${convo.slice(-12000)}\n\n` : ''}New email\nFrom: ${email.from || ''}\nDate: ${email.date || ''}\nSubject: ${email.subject || ''}\nLatest message:\n${String(latest || email.text || '').slice(0, 5000)}\n\nFirst reader's decision:\n${decisionText(x, deal)}` }],
  });
  const v = (out.content || []).find((c) => c.type === 'tool_use')?.input || {};
  return { agree: v.agree !== false, rightEvent: v.right_event || x.event, wrongDeal: !!v.wrong_deal, reason: String(v.reason || '').slice(0, 400), cost: costOf(out.usage) };
}

export async function checkDraftWithReader({ kind, deal = {}, to, body, why, convo = '' }) {
  const lessons = await (await import('./lessons.js')).lessonsFor(`${kind} ${why || ''}\n${body || ''}`, { areas: ['Emails'] }).catch(() => '');
  const out = await claude({
    _job: 'second-read',
    model: HAIKU,
    max_tokens: 300,
    system: `You check emails NOOCAP Media is about to send to brand partners, before a person approves them. Say ok only if the email is right to send as it is. Check: it is addressed to the brand contact of THIS deal (not another brand), it answers the brand's latest message, every fact, date, amount, code and link in it is in the conversation or the deal facts, it promises nothing vague, it has no placeholders, and it does not repeat or contradict what was already sent. Only list real problems.\n\n${RULES}${lessons ? '\n\n' + lessons : ''}`,
    tools: [DRAFT_VERDICT],
    tool_choice: { type: 'tool', name: 'draft_verdict' },
    messages: [{ role: 'user', content: `Deal: ${deal.brand || '?'} x ${deal.creator || '?'} (stage ${deal.stage || '?'}${deal.finalRate ? `, rate ${deal.finalRate}` : ''}, brand contact ${deal.brandEmail || '?'})\n${convo ? `Full conversation (oldest first):\n${convo.slice(-10000)}\n\n` : ''}Email kind: ${kind}\nWhy it was drafted: ${why || ''}\nTo: ${to || ''}\nBody:\n${String(body || '').replace(/<br\s*\/?>/g, '\n').slice(0, 3000)}` }],
  });
  const v = (out.content || []).find((c) => c.type === 'tool_use')?.input || {};
  return { ok: v.ok !== false, problems: (v.problems || []).map(String).filter(Boolean).slice(0, 4), cost: costOf(out.usage) };
}
