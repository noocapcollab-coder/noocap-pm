// Tools & spend: reads the TOOLS & SPEND Notion database and turns it into monthly USD totals for HQ
import { queryAll, flatten } from './notion.js';

export const SPEND_DS = process.env.TOOLS_SPEND_DS || 'aac1e42b-656e-4ff5-acfa-85dfb7bef926';
export const SPEND_URL = 'https://app.notion.com/p/fe06dbe220764f73be3529e657474809';
const INR_PER_USD = () => Number(process.env.USD_INR) || 84;

// What one tool costs per month in USD. Yearly is spread over 12 months, one-off and stopped tools count as 0.
export function monthlyUSD(t, rate = INR_PER_USD()) {
  const cost = Number(t.Cost) || 0;
  if (!cost) return 0;
  if (t.Status === 'Cancelled' || t.Status === 'Paused') return 0;
  if (t.Billing === 'One-off') return 0;
  const usd = t.Currency === 'INR' ? cost / rate : cost;
  return t.Billing === 'Yearly' ? usd / 12 : usd;
}

const r2 = (n) => Math.round(n * 100) / 100;

export function summarize(rows, today = new Date().toISOString().slice(0, 10), rate = INR_PER_USD()) {
  const soon = new Date(Date.parse(today + 'T00:00:00Z') + 14 * 864e5).toISOString().slice(0, 10);
  const tools = rows.map((t) => ({
    id: t._id, url: t._url, name: t.Tool || 'Untitled', category: t.Category || 'Other', paidFor: t['Paid For'] || 'NOOCAP',
    plan: t.Plan || '', billing: t.Billing || '', cost: t.Cost ?? null, currency: t.Currency || 'USD',
    renewal: t['Next Renewal'] || null, status: t.Status || 'Active', paidWith: t['Paid With'] || '', notes: t.Notes || '',
    account: t.Account || '', monthly: r2(monthlyUSD(t, rate)),
  })).sort((a, z) => z.monthly - a.monthly || a.name.localeCompare(z.name));
  const live = tools.filter((t) => t.status === 'Active' || t.status === 'Trial');
  const by = (k) => { const o = {}; for (const t of live) if (t.monthly) o[t[k]] = r2((o[t[k]] || 0) + t.monthly); return Object.entries(o).sort((a, z) => z[1] - a[1]).map(([name, monthly]) => ({ name, monthly })); };
  const monthly = r2(live.reduce((s, t) => s + t.monthly, 0));
  return {
    today, rate, notion: SPEND_URL, tools, monthly, yearly: r2(monthly * 12),
    active: live.length, noCost: live.filter((t) => t.cost == null).length,
    byCategory: by('category'), byClient: by('paidFor'),
    renewing: live.filter((t) => t.renewal && t.renewal >= today && t.renewal <= soon).sort((a, z) => a.renewal.localeCompare(z.renewal)),
  };
}

// This month's Anthropic API usage from AI SPEND (written by the PM on every AI call)
export async function aiUsage({ fresh = false } = {}) {
  const { AI_SPEND_DS, budget, readJobs } = await import('./aispend.js');
  const month = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 7);
  const rows = (await queryAll(AI_SPEND_DS, { property: 'Month', title: { equals: month } }, { useCache: !fresh }).catch(() => [])).map(flatten);
  const r = rows[0] || {};
  const jobs = Object.entries(readJobs(r['By Job'])).sort((a, z) => z[1] - a[1]).map(([name, usd]) => ({ name, usd: r2(usd) }));
  return { month, spent: r2(Number(r['Spent USD'] || 0)), calls: Number(r.Calls || 0), budget: Number(r['Budget USD']) || budget(), jobs };
}

export async function spendData({ fresh = false } = {}) {
  const [rows, ai] = await Promise.all([queryAll(SPEND_DS, null, { useCache: !fresh }), aiUsage({ fresh }).catch(() => null)]);
  return { generated_at: new Date().toISOString(), ...summarize(rows.map(flatten)), ai };
}
