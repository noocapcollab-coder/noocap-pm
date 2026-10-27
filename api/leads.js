// POST /api/leads — n8n "PM · Leads" sends each email from a creator's own collab inbox here (watch-only).
// Header: x-hook-secret. Body: one email or { emails: [...] }
// n8n labels an email PM-seen unless the action is 'error', so errors are retried on the next sweep.
// After 3 failed tries the PM gives up, tells Harsh on Discord, and returns 'gave_up' so the retries stop.
import { handleLeadEmail, labelPlan } from '../lib/leads.js';
import { hookAllowed, HOOK_ERROR, cronAllowed } from '../lib/hook.js';
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
      Event: { title: rt(`Leads error: ${email.subject || '(no subject)'}`.slice(0, 120)) },
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

export default async function handler(req, res) {
  if (!['POST', 'GET'].includes(req.method)) return res.status(405).json({ error: 'GET or POST' });
  // Vercel Cron (every 5 minutes) polls the creator inboxes; it calls this with no query, so that means poll
  const cron = cronAllowed(req);
  if (cron && req.method === 'GET') req.query = { ...(req.query || {}), poll: '1' };
  if (!cron && !hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  // GET /api/leads?labels=1&days=30 -> which Gmail label each lead thread should carry (n8n "PM · Label sync")
  // GET /api/leads?poll=1 -> read the creator inboxes the PM reaches itself over IMAP (Lindsay's), every few minutes
  // AI paused: don't open the inboxes at all, so every email waits untouched until the pause ends
  const { aiPaused, PAUSED_MSG } = await import('../lib/pause.js');
  if (aiPaused() && req.method === 'GET' && req.query?.poll) return res.status(200).json({ paused: PAUSED_MSG() });
  if (req.method === 'GET' && req.query?.poll) {
    const { pollMailboxes } = await import('../lib/mailbox.js');
    const results = await pollMailboxes({ handle: async (email) => { try { return await handleLeadEmail(email); } catch (e) { const msg = String(e.message || e).slice(0, 300); return { action: await recordError(email, msg), error: msg }; } } });
    if (results.length) { const run = await startRun('Leads', `${results.length} email${results.length > 1 ? 's' : ''} from creator inboxes`); results.forEach((r) => run.mark(String(r.subject || r.error || '').slice(0, 60))); await run.finish(emailSummary(results)); }
    return res.status(200).json({ results });
  }
  if (req.method === 'GET') return res.status(200).json(await labelPlan({ days: Math.min(90, Number(req.query?.days) || 30) }));
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const emails = Array.isArray(body.emails) ? body.emails : [body];
  if (aiPaused()) return res.status(200).json({ results: emails.map((e) => ({ subject: e.subject, action: 'error', why: PAUSED_MSG() })) });
  const results = [];
  const batch = emails.slice(0, 20);
  const run = await startRun('Leads', batch.length === 1 ? (batch[0].subject || '(no subject)') + (batch[0].from ? ' · ' + String(batch[0].from).replace(/<.*>/, '').trim() : '') : `${batch.length} emails`);
  for (const email of batch) {
    try {
      results.push({ subject: email.subject, ...(await handleLeadEmail(email)) });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      results.push({ subject: email.subject, action: await recordError(email, msg), error: msg });
    }
    run.mark(String(email.subject || '(no subject)').slice(0, 60));
  }
  await run.finish(emailSummary(results));
  return res.status(200).json({ results });
}
