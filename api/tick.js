// POST /api/tick — n8n "PM · Heartbeat" calls this every 30 minutes.
// Add ?brief=now to force the morning brief (for testing).
import { runHeartbeat } from '../lib/heartbeat.js';
import { hookAllowed, cronAllowed, HOOK_ERROR } from '../lib/hook.js';
import { withRun, heartbeatSummary, pruneRuns } from '../lib/runs.js';

// A network call that never answers would hang the whole tick until Vercel kills it (and the run row stays
// "Running"). Give every call in this function 60s unless it sets its own limit.
if (!globalThis.fetch.__capped) {
  const raw = globalThis.fetch;
  const capped = (url, opts = {}) => raw(url, opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(60000) });
  capped.__capped = true;
  globalThis.fetch = capped;
}
const HARD_STOP_MS = 250 * 1000;

export default async function handler(req, res) {
  const fromCron = cronAllowed(req);
  if (!fromCron && !hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
  // ?cuts=now: n8n saw a row switched to "Send to Brand" in EDIT TRACKER. Send just that (fast), not the whole heartbeat.
  if (req.query?.cuts === 'now') {
    if (!hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
    try {
      const { sendCutsToBrands } = await import('../lib/brandsend.js');
      const id = String(req.query.id || req.body?.id || '').replace(/[^0-9a-f]/gi, '');
      return res.status(200).json(await sendCutsToBrands({ rowId: id.length === 32 ? id : undefined }));
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?ytcheck=Lindsay: can the PM read this creator's YouTube Shorts, and which way (API key, feed or page)?
  if (req.query?.ytcheck) {
    try {
      const P = await import('../lib/postedlinks.js');
      const where = P.POSTED_LINK_CREATORS[String(req.query.ytcheck)];
      if (!where?.youtubeChannel) return res.status(400).json({ error: 'no YouTube channel for that creator' });
      const out = {};
      if (process.env.YOUTUBE_API_KEY) { try { const l = await P.youtubeApiPosts(where.youtubeChannel, process.env.YOUTUBE_API_KEY); out.api = { ok: true, count: l.length, latest: l.slice(0, 3).map((x) => ({ url: x.url, at: x.at, title: x.text.slice(0, 60) })) }; } catch (e) { out.api = { ok: false, error: e.message }; } } else out.api = { ok: false, error: 'YOUTUBE_API_KEY not set' };
      try { const all = await P.youtubePosts(where.youtubeChannel); out.used = all.length; if (req.query.brand) out.match = P.matchPosts(all, { brand: String(req.query.brand), postDate: String(req.query.date || '') }).map((x) => x.url); } catch (e) { out.chain_error = e.message; }
      return res.status(200).json(out);
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?wiki=now: build a batch of brand wiki pages right away
  if (req.query?.wiki === 'now') {
    if (!hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
    try { const { updateWiki } = await import('../lib/wiki.js'); const { openDeals } = await import('../lib/briefs.js'); return res.status(200).json(await updateWiki(await openDeals({ withClosed: true }), { limit: Number(req.query.n) || 15 })); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?chase=now: run the brief chases (contract/brief follow-ups after a handover) right away
  if (req.query?.chase === 'now') {
    if (!hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
    try { const { briefChases } = await import('../lib/leads.js'); return res.status(200).json({ chases: await briefChases() }); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?briefs=now: send briefs pasted on waiting cards to the script writer right away (not the whole heartbeat)
  if (req.query?.briefs === 'now') {
    if (!hookAllowed(req)) return res.status(401).json({ error: HOOK_ERROR });
    try { const { briefsAddedToWaitingCards } = await import('../lib/briefs.js'); return res.status(200).json({ sent: await briefsAddedToWaitingCards() }); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // Once Vercel runs the heartbeat (HEARTBEAT_SOURCE=vercel), the old n8n timer is ignored so it never runs twice.
  // A manual call with ?brief=now still works.
  if (!fromCron && process.env.HEARTBEAT_SOURCE === 'vercel' && req.query?.brief !== 'now') return res.status(200).json({ skipped: 'heartbeat runs from Vercel now' });
  try {
    const report = await withRun('Heartbeat', `Heartbeat ${new Date(Date.now() + 5.5 * 36e5).toISOString().slice(11, 16)} IST`, () => {
      // If something still hangs, stop at 250s and finish the run with what got done and where it stuck
      const report = { drafts: [], handed_to_harsh: [], brief: null, errors: [], steps: [] };
      return Promise.race([
        runHeartbeat({ force: req.query?.brief === 'now', report }),
        new Promise((done) => setTimeout(() => { report.errors.push(`Stopped after ${HARD_STOP_MS / 1000}s, stuck on: ${report.now || 'reading brand deals'}`); done(report); }, HARD_STOP_MS)),
      ]);
    }, { summarize: heartbeatSummary, trigger: fromCron ? 'Vercel' : 'n8n' });
    await pruneRuns().catch(() => 0);
    return res.status(200).json(report);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
