// PM · Deal memory. Every brand deal keeps a short running record of the whole conversation in its "Deal Memory"
// field: what was agreed, what has happened, and who owes the next move. It is updated on every email in the thread,
// ours and the brand's, and every draft and every email the PM reads is judged against it. Before this, the PM read
// each email on its own, which is how it lost track of things (OiiOii "not replied", Gamut, Kylon's billing details).
import { notion, plain } from './notion.js';
import { DS } from './tools.js';
import { claude, HAIKU } from './claude.js';

export const MEMORY_PROP = 'Deal Memory';
const MAX = 1800;
const LOG_DS = '4215bfda-0191-4e77-a40b-4c2d8b6e0d70';

// The field is created on the Deals database the first time it's needed
let ready = false;
async function ensureProp() {
  if (ready) return;
  const ds = await notion('GET', `/data_sources/${DS.deals}`);
  if (!ds.properties?.[MEMORY_PROP]) await notion('PATCH', `/data_sources/${DS.deals}`, { properties: { [MEMORY_PROP]: { rich_text: {} } } });
  ready = true;
}

const chunks = (s) => { const out = []; for (let i = 0; i < s.length; i += 1900) out.push({ type: 'text', text: { content: s.slice(i, i + 1900) } }); return out; };
const day = (t) => new Date((Number.isFinite(Date.parse(t)) ? Date.parse(t) : Date.now()) + 5.5 * 36e5).toISOString().slice(0, 10);

const RULES = `Keep a short running record of one brand deal for NOOCAP Media (an agency making sponsored videos for creators), so anyone can pick it up cold. Use exactly these four headings:
AGREED: rate, deliverables, usage rights, payment terms and any agreed dates. Only what both sides have confirmed.
HISTORY: one line per meaningful event, oldest first, each starting with its date (YYYY-MM-DD) and who acted (us / brand / creator). Keep at most 10 lines; merge or drop trivial ones (thank-yous, scheduling chatter).
BILLING: whether the brand has given billing details (company, invoice email, address) and invoice status. Write "not yet" if unknown.
OPEN NOW: what is pending after the latest message, and say plainly who owes the next move: "We owe:" or "Waiting on brand:". If nothing is pending, say so.
Rules: only facts stated in the emails or deal fields, never guesses. Keep it under ${MAX} characters. Plain text, no markdown, no em dashes.`;

function dealFacts(deal) {
  return [`Deal: ${deal.brand} x ${deal.creator || '?'}`, `Stage: ${deal.stage || '?'}`, deal.finalRate ? `Rate: ${deal.finalRate}` : '',
    deal.deliverables ? `Deliverables: ${deal.deliverables}` : '', deal.paymentTerms ? `Payment terms: ${deal.paymentTerms}` : '',
    deal.billing ? 'Billing details: on file' : '', deal.nextAction ? `Next Action field: ${deal.nextAction}` : ''].filter(Boolean).join('\n');
}

async function save(deal, memory) {
  await ensureProp();
  await notion('PATCH', `/pages/${deal.id}`, { properties: { [MEMORY_PROP]: { rich_text: chunks(memory) } } });
  deal.memory = memory;
}

// One email (ours, the brand's or the creator's team's) folded into the deal's record
export async function rememberEmail(deal, { who, date, subject, text }) {
  if (!deal?.id || !String(text || '').trim()) return null;
  const out = await claude({
    model: HAIKU,
    max_tokens: 900,
    system: RULES,
    messages: [{ role: 'user', content: `${dealFacts(deal)}\n\nRecord so far:\n${deal.memory || '(empty, start one)'}\n\nNew email (${day(date)}, from ${who})\nSubject: ${subject || ''}\n${String(text).slice(0, 6000)}\n\nReturn the full updated record only.` }],
  });
  const memory = (out.content || []).map((c) => c.text || '').join('').trim().replace(/[—–]/g, ',').slice(0, MAX);
  if (memory.length > 40) await save(deal, memory);
  return memory;
}

// A deal that has no record yet gets one built from what the PM has already logged about it
export async function seedFromLog(deal) {
  const r = await notion('POST', `/data_sources/${LOG_DS}/query`, { page_size: 40, filter: { property: 'Deal', relation: { contains: deal.id } }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
  const lines = (r.results || []).map((p) => {
    const t = Object.values(p.properties || {}).find((x) => x.type === 'title');
    return `${day(p.created_time)} ${plain(t) || ''} :: ${(plain(p.properties?.Details) || '').slice(0, 400)}`;
  }).filter((l) => l.length > 14);
  const out = await claude({
    model: HAIKU,
    max_tokens: 900,
    system: RULES,
    messages: [{ role: 'user', content: `${dealFacts(deal)}\n\nThe PM's log of this deal so far (oldest first):\n${lines.join('\n').slice(0, 9000) || '(no log entries)'}\n\nWrite the record. The log only has short notes, so when something is not in it write "not known yet" instead of guessing, and in OPEN NOW only name a next move the log clearly shows; otherwise write "not known yet, fills in from the next email". Return the record only.` }],
  });
  const memory = (out.content || []).map((c) => c.text || '').join('').trim().replace(/[—–]/g, ',').slice(0, MAX);
  if (memory.length > 40) await save(deal, memory);
  return memory;
}

// Heartbeat helper: a few open deals without a record get one each run, so every live deal has one within a day
export async function seedMissing(deals, limit = 3) {
  const todo = deals.filter((d) => !d.memory && !['Paid', 'Lost'].includes(d.stage)).slice(0, limit);
  let done = 0;
  for (const d of todo) { try { if (await seedFromLog(d)) done++; } catch { /* next run */ } }
  return { done, left: deals.filter((d) => !d.memory && !['Paid', 'Lost'].includes(d.stage)).length - done };
}
