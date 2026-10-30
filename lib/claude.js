import { aiPaused, PAUSED_MSG } from './pause.js';
// Minimal Claude API call shared by background jobs.
export const HAIKU = process.env.PM_MODEL_FAST || 'claude-haiku-4-5-20251001';
export const PRICES = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
};

// body._job names the job for the AI SPEND breakdown (inbox, memory, drafts...). It is not sent to the API.
export async function claude({ _job = 'other', ...body }) {
  if (aiPaused()) throw new Error(PAUSED_MSG());
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const { trackSpend } = await import('./aispend.js');
  trackSpend(body.model, json.usage, _job);
  return json;
}

export function costOf(usage, price = PRICES.haiku) {
  const u = usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  return Math.round(((input * price.input + (u.output_tokens || 0) * price.output) / 1e6) * 10000) / 10000;
}
