// POST /api/inbox — n8n "PM · Inbox" sends each noocapcollab email here.
// Header: x-hook-secret. Body: one email or { emails: [...] }
// n8n labels an email PM-seen unless the action is 'error', so errors are retried on the next sweep.
// After 3 failed tries the PM gives up, tells Harsh on Discord, and returns 'gave_up' so the retries stop.
import { handleInboxEmail } from '../lib/inbox.js';
import { hookAllowed, HOOK_ERROR } from '../lib/hook.js';
import { notion } from '../lib/notion.js';
import { DS } from '../lib/tools.js';
import { discord } from '../lib/briefs.js';
import { startRun, emailSummary } from '../lib/runs.js';

const MAX_TRIES = 3;
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];

async function recordError(email, err) {
  const id = String(email.messageId || '').slice(0, 1900);
  let tries = 0;
  try {
    if (id) {
      const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 10, filter: { and: [{ property: 'Message ID', rich_text: { equals: id } }, { property: 'Area', select: { equals: 'System' } }] } });
      tries = (r.results || []).length;
    }
    await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.agentLog }, properties: {
      Event: { title: rt(`Inbox error: ${email.subject || '(no subject)'}`.slice(0, 120)) },
      Time: { date: { start: new Date().toISOString() } }, Area: { select: { name: 'System' } },
      Outcome: { select: { name: 'Error' } }, Source: { select: { name: 'noocapcollab' } }, Model: { select: { name: 'None' } },
      Details: { rich_text: rt(`From ${email.from || '?'}\n${err}`) }, 'Message ID': { rich_text: rt(id) },
    } });
  } catch { /* logging is best effort */ }
  tries += 1;
  if (tries >= MAX_TRIES) {
    await discord(`⚠️ **I couldn't process an email after ${tries} tries**\n**${email.subject || '(no subject)'}** from ${email.from || '?'}\nError: ${String(err).slice(0, 300)}\nPlease handle this one by hand.`, 'pm').catch(() => {});
    return 'gave_up';
  }
  return 'error';
}

// n8n can hand the PM the same email twice a few seconds apart (two sweeps overlapping before the PM-seen label
// lands). Each run claims the email first; a second run that finds a fresh claim from someone else skips it.
const CLAIM_TTL = 5 * 60e3;
async function claims(id) {
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 10, filter: { and: [{ property: 'Message ID', rich_text: { equals: id } }, { property: 'Event', title: { starts_with: 'Claim:' } }] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
  return (r.results || []).filter((p) => !p.in_trash && Date.now() - Date.parse(p.created_time) < CLAIM_TTL);
}
async function claim(email) {
  const id = String(email.messageId || '').slice(0, 1900);
  if (!id) return { ok: true };
  try {
    if ((await claims(id)).length) return { ok: false };
    const mine = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.agentLog }, properties: {
      Event: { title: rt(`Claim: ${email.subject || '(no subject)'}`.slice(0, 120)) }, Time: { date: { start: new Date().toISOString() } },
      Area: { select: { name: 'System' } }, Outcome: { select: { name: 'Rule' } }, Source: { select: { name: 'noocapcollab' } }, 'Message ID': { rich_text: rt(id) },
    } });
    // Two runs that claimed at the same moment: the earliest claim wins, the other steps back
    await new Promise((r) => setTimeout(r, 1500));
    const all = await claims(id);
    const first = all.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time) || String(a.id).localeCompare(String(b.id)))[0];
    if (first && first.id !== mine.id) { await notion('PATCH', `/pages/${mine.id}`, { in_trash: true }).catch(() => {}); return { ok: false }; }
    return { ok: true, id: mine.id };
  } catch {
    return { ok: true }; // never block an email because the claim couldn't be written
  }
}
const release = (c) => (c && c.id ? notion('PATCH', `/pages/${c.id}`, { in_trash: true }).catch(() => {}) : null);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const emails = Array.isArray(body.emails) ? body.emails : [body];
  const results = [];
  const batch = emails.slice(0, 20);
  const run = await startRun('Inbox', batch.length === 1 ? (batch[0].subject || '(no subject)') + (batch[0].from ? ' · ' + String(batch[0].from).replace(/<.*>/, '').trim() : '') : `${batch.length} emails`);
  for (const email of batch) {
    const c = await claim(email);
    if (!c.ok) { results.push({ subject: email.subject, action: 'skipped', why: 'already being handled' }); continue; }
    try {
      results.push({ subject: email.subject, ...(await handleInboxEmail(email)) });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      results.push({ subject: email.subject, action: await recordError(email, msg), error: msg });
    }
    await release(c);
    run.mark(String(email.subject || '(no subject)').slice(0, 60));
  }
  await run.finish(emailSummary(results));
  return res.status(200).json({ results });
}
