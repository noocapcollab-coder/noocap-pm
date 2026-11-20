import { anthropicPaused as aiPaused, PAUSED_MSG } from './pause.js';
// Minimal Claude API call shared by background jobs.
export const HAIKU = process.env.PM_MODEL_FAST || 'claude-haiku-4-5-20251001';
export const PRICES = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
};

// Anthropic first. If Anthropic is out (spend limit, no credit, overloaded or down) and GEMINI_API_KEY is set, the
// same request goes to Gemini (lib/gemini.js) and comes back in Anthropic's shape, so no caller has to change.
const FALLBACK_ON = /usage limit|credit balance|overloaded|Claude (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT/i;
// Once every 6 hours across ALL copies of the PM: the in-memory flag alone reset on every Vercel instance (Harsh, Nov 20),
// and a plain "check the log, then post" still let copies that checked at the same moment all post. claimOnce in
// lib/briefs.js lets exactly one copy win.
const NOTICE_EVENT = 'Claude unavailable, running on Gemini';
let fallbackNoticeSent = false;
async function fallbackNotice(err) {
  if (fallbackNoticeSent) return;
  fallbackNoticeSent = true;
  try {
    const { discord, claimOnce } = await import('./briefs.js');
    if (!(await claimOnce(NOTICE_EVENT, 6, String(err.message || err).slice(0, 300)))) return;
    await discord(`ℹ️ **Claude API unavailable, the PM is running on Gemini**\nAnthropic said: ${String(err.message || err).replace(/\s+/g, ' ').slice(0, 160)}\nBrand emails, briefs and drafts keep working on Google Gemini (free tier) until Claude is back. This notice repeats at most every 6 hours.`, 'pm');
  } catch { /* best effort */ }
}

// Raw call: Anthropic Messages body in, Anthropic-shaped response out. Does not track spend (callers do).
export async function callModel(body) {
  const G = await import('./gemini.js');
  if (G.geminiFirst()) return G.gemini(body);
  try {
    if (aiPaused()) throw new Error(PAUSED_MSG());
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {}),
      },
      body: JSON.stringify(body, (k, v) => (k === '_gsig' ? undefined : v)), // Gemini-only field
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  } catch (e) {
    if (!G.hasGemini() || !(FALLBACK_ON.test(String(e.message)) || aiPaused())) throw e;
    fallbackNotice(e);
    // Keep Claude's reason when Gemini fails too, so the run shows why Claude was out and an Anthropic spend limit
    // still raises the spend-limit alert (rule 66). Bug hunter, Nov 20: runs only said "Gemini 429 ... quota".
    // Claude's reason goes FIRST: api/inbox.js and api/leads.js cut errors to 300 characters, and Gemini's 429 body alone
    // is longer, so a reason appended after it never reached spendLimitAlert (Bug hunter, Nov 20 04:54-07:12 UTC).
    try { return await G.gemini(body); } catch (g) {
      throw new Error(`${String(e.message || e).replace(/\s+/g, ' ').slice(0, 200)}; Gemini fallback failed too: ${String(g.message || g)}`);
    }
  }
}

// body._job names the job for the AI SPEND breakdown (inbox, memory, drafts...). It is not sent to the API.
export async function claude({ _job = 'other', ...body }) {
  const json = await callModel(body);
  const { trackSpend } = await import('./aispend.js');
  trackSpend(json.provider === 'gemini' ? json.model : body.model, json.usage, json.provider === 'gemini' ? `${_job}-gemini` : _job);
  return json;
}

export function costOf(usage, price = PRICES.haiku) {
  const u = usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  return Math.round(((input * price.input + (u.output_tokens || 0) * price.output) / 1e6) * 10000) / 10000;
}
