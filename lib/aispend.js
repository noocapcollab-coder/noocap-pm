// What the PM spends on the Anthropic API, month by month, in the AI SPEND Notion database. Every AI call adds its
// cost (worked out from the token counts the API sends back) to this month's row, and when the month passes 75% and
// then 95% of the budget, Harsh and Pratham get a WhatsApp/Discord alert. Before this, credits ran out with no warning.
import { notion, plain } from './notion.js';

export const AI_SPEND_DS = process.env.AI_SPEND_DS || '548e63dd-3868-4bc3-a319-9e64af0d5c64';
export const budget = () => Number(process.env.AI_MONTHLY_BUDGET) || 20;
// USD per million tokens
const PRICE = { haiku: { in: 1, out: 5 }, sonnet: { in: 3, out: 15 }, opus: { in: 15, out: 75 } };

export function callCost(model, usage = {}) {
  const p = /opus/i.test(model) ? PRICE.opus : /sonnet/i.test(model) ? PRICE.sonnet : PRICE.haiku;
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * p.in + (usage.output_tokens || 0) * p.out) / 1e6;
}
const monthKey = (now = Date.now()) => new Date(now + 5.5 * 36e5).toISOString().slice(0, 7);
// The alert levels crossed by going from `before` to `after` dollars, that haven't been sent yet this month
export function crossed(before, after, limit, sent = '') {
  return [75, 95].filter((pct) => before < limit * pct / 100 && after >= limit * pct / 100 && !String(sent).includes(`${pct}%`));
}
// "inbox 0.42 · drafts 0.10" <-> { inbox: 0.42, drafts: 0.10 }
export const readJobs = (s) => Object.fromEntries(String(s || '').split('·').map((x) => x.trim().split(/\s+/)).filter((a) => a.length === 2 && Number.isFinite(Number(a[1]))).map(([k, v]) => [k, Number(v)]));
export const writeJobs = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' · ');

// Calls that finish at the same moment are added together, so one Notion write covers many AI calls
let pending = { usd: 0, calls: 0, jobs: {} };
let flushing = null;
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];

async function flush() {
  const add = pending; pending = { usd: 0, calls: 0, jobs: {} };
  if (!add.calls) return;
  const month = monthKey();
  const r = await notion('POST', `/data_sources/${AI_SPEND_DS}/query`, { page_size: 1, filter: { property: 'Month', title: { equals: month } } });
  const row = (r.results || [])[0];
  const before = Number(plain(row?.properties?.['Spent USD']) || 0);
  const after = before + add.usd;
  const jobs = readJobs(plain(row?.properties?.['By Job']));
  for (const [k, v] of Object.entries(add.jobs)) jobs[k] = (jobs[k] || 0) + v;
  const limit = budget();
  const sentBefore = plain(row?.properties?.Alerted) || '';
  const alerts = crossed(before, after, limit, sentBefore);
  const props = {
    'Spent USD': { number: Math.round(after * 1000) / 1000 }, Calls: { number: Number(plain(row?.properties?.Calls) || 0) + add.calls },
    'Budget USD': { number: limit }, 'By Job': { rich_text: rt(writeJobs(jobs)) },
    ...(alerts.length ? { Alerted: { rich_text: rt([sentBefore, ...alerts.map((a) => `${a}%`)].filter(Boolean).join(', ')) } } : {}),
  };
  if (row) await notion('PATCH', `/pages/${row.id}`, { properties: props });
  else await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: AI_SPEND_DS }, properties: { Month: { title: rt(month) }, ...props } });
  if (alerts.length) {
    const top = Object.entries(jobs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ');
    const { discord } = await import('./briefs.js');
    await discord(`💳 **AI spend at ${alerts[alerts.length - 1]}% of this month's budget**\n• $${after.toFixed(2)} of $${limit} used so far in ${month}. Biggest jobs: ${top}\n• Top up the Anthropic credits or raise the limit before it runs out, or the PM stops reading emails`, 'pm').catch(() => {});
  }
}

// Add one AI call. Never throws and never slows the caller down: the Notion write happens after the response.
export function trackSpend(model, usage, job = 'other') {
  try {
    const usd = callCost(model, usage);
    pending.usd += usd; pending.calls += 1; pending.jobs[job] = (pending.jobs[job] || 0) + usd;
    const run = async () => { await new Promise((r) => setTimeout(r, 300)); while (flushing) await flushing; flushing = flush().catch((e) => console.error('AI spend', e.message)).finally(() => { flushing = null; }); await flushing; };
    const p = run();
    import('@vercel/functions').then((f) => f.waitUntil?.(p)).catch(() => {});
  } catch { /* tracking is best effort */ }
}
