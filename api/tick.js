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
  // ?dedupeimages=<intake row id>: delete repeated PM image posts in that editor thread, keep the newest. Hook only.
  if (req.query?.dedupeimages) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const E = await import('../lib/editorthreads.js'); const { findIntakeRowByBrand } = await import('../lib/intake.js'); const row = await findIntakeRowByBrand(String(req.query.dedupeimages), req.query.creator); if (!row) return res.status(404).json({ error: 'no row' }); return res.status(200).json(await E.dedupeEditorImages(row.id)); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?editorimage=1&brand=..&creator=..: the last WhatsApp image goes to that video's editor. Hook only.
  if (req.query?.editorimage) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const I = await import('../lib/inbox.js'); return res.status(200).json(await I.resendEditorImage({ brand: req.query.brand, creator: req.query.creator, dry: !!req.query.dry })); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?drivecheck=1: which cards the Drive folders step would work on next, in order (read only). Hook only.
  if (req.query?.drivecheck) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const D = await import('../lib/drive.js'); const errors = []; const c = await D.cardsNeedingFolders(errors); return res.status(200).json({ errors, cards: c.map((x) => ({ creator: x.creator, title: x.title, rawOnly: !!x.rawOnly })) }); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?bankcheck=1: is bank transfer switched on in each creator's Stripe (read only). Hook only.
  if (req.query?.bankcheck) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const I = await import('../lib/invoicing.js'); return res.status(200).json(await I.bankTransferReport()); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?unanswered=1: deals whose newest email is from the brand (read only). Hook only.
  if (req.query?.unanswered) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const U = await import('../lib/unanswered.js'); return res.status(200).json(await U.unanswered({ days: Number(req.query.days) || 10 })); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?contractping=<CONTRACTS row id>: send that contract to WhatsApp and #pm-alerts again (a row added by hand). Hook only.
  if (req.query?.contractping) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const T = await import('../lib/contracttrack.js'); return res.status(200).json(await T.announceContract(String(req.query.contractping).replace(/[^0-9a-f-]/gi, ''))); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?sendoutbox=<PM OUTBOX page id>: send a draft Harsh told Claude to send ("send it directly", Nov 15), the same as
  // pressing Send in Approvals. Hook secret only, never the cron.
  if (req.query?.sendoutbox) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const { approveAndSend } = await import('../lib/outbox.js'); return res.status(200).json(await approveAndSend(String(req.query.sendoutbox), {})); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?cleancard=<card id>[&dry=1]: show only the approved script on a video card, the rest kept in Card history (Nov 16)
  // ?sendtemplate=<dealId>&key=video_eta[&from=Name <email>]: send one fixed reply into a deal's thread (Nov 17)
  if (req.query?.sendtemplate) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const R = await import('../lib/replytemplates.js'); return res.status(200).json(await R.sendTemplateToDeal(String(req.query.sendtemplate), String(req.query.key || ''), { from: String(req.query.from || '') })); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?raisedraft=<dealId>: draft the invoice due now (upfront share first) in the creator's Stripe and put its email in
  // Approvals, nothing sent (Nov 17: Harsh sees every invoice before it goes)
  if (req.query?.raisedraft) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const I = await import('../lib/invoicing.js');
      const { openDeals } = await import('../lib/briefs.js');
      const deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(req.query.raisedraft).replace(/-/g, ''));
      if (!deal) return res.status(404).json({ error: 'deal not found' });
      const now = I.dueNow(deal);
      // &due=YYYY-MM-DD: the date the brand asked the invoice to be due (ElevenLabs, Nov 17: Net 1, due Nov 18)
      const dueDays = req.query.due ? Math.max(1, Math.ceil((Date.parse(String(req.query.due)) - Date.now()) / 864e5)) : 0;
      return res.status(200).json({ due: now, ...(await I.raiseInvoiceNow(deal.id, now.amount, { notify: false, part: now.part, pct: now.pct, dueDays })) });
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?rejectoutbox=<PM OUTBOX page id>: reject a draft Harsh told Claude to drop (an invoice draft also leaves Stripe)
  if (req.query?.rejectoutbox) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const { rejectDraft } = await import('../lib/outbox.js'); await rejectDraft(String(req.query.rejectoutbox)); return res.status(200).json({ ok: true }); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  if (req.query?.cleancard) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const C = await import('../lib/cardclean.js'); return res.status(200).json(await C.cleanCardToApprovedScript(String(req.query.cleancard).replace(/-/g, ''), { dryRun: req.query.dry === '1' })); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?paytest=Chris: dry run of the invoice payment flow for one creator (Nov 16). Reads only: nothing is drafted or sent.
  if (req.query?.paytest) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const G = await import('../lib/invoiceguard.js');
      const I = await import('../lib/invoicing.js');
      const { openDeals } = await import('../lib/briefs.js');
      const creator = String(req.query.paytest);
      const real = await G.verifiedRow(creator);
      const row = await G.verifiedRow(creator, { raw: true }); // preview even before Verified is ticked; nothing is sent
      const deals = (await openDeals({ withClosed: true })).filter((d) => d.creator === creator && ['Posted', 'Invoiced'].includes(d.stage));
      const deal = deals[0] || { creator, brand: 'Test brand', finalRate: 1000, invoiceNumber: 'INV-TEST' };
      const samples = { bank: 'Our finance team only pays by bank transfer, can you share the bank details?', paypal: "We can't pay through Stripe, do you have PayPal?", none: 'Thanks, we will pay this week.' };
      const asks = Object.fromEntries(Object.entries(samples).map(([k, t]) => [k, G.asksOtherPayment(t)]));
      const email = (want) => { if (!row) return null; const pk = G.pickDetails(row, want); return G.paymentDetailsEmail({ name: 'Sophie', creator, amount: deal.invoiceAmount || deal.finalRate, number: String(deal.invoiceNumber || '').split(/,\s*/).pop() || '', details: pk.details, want: pk.sent, asked: want, instead: pk.instead }); };
      const guard = deals[0] ? (await G.checkInvoice(deals[0], { amount: Number(deal.invoiceAmount || deal.finalRate) || undefined })).problems : [];
      return res.status(200).json({
        creator, verified: !!real && !real.unverified, row_url: row?.url, note: real && !real.unverified ? 'live' : 'preview only: Verified is not ticked, so the real flow would ping Harsh instead of drafting',
        detection: asks,
        bank_reply: email('Bank transfer'), paypal_reply: email('PayPal'),
        invoice_footer_stripe: await I.invoiceText({ creator }), invoice_footer_platform_pdf: await I.invoiceText({ creator }, { withPayment: true }),
        stray_check_on_bank_reply: email('Bank transfer') ? G.strayPaymentDetails(email('Bank transfer'), G.paymentText(row)) : null,
        deal_checked: deals[0] ? `${deals[0].brand} × ${creator} (${deals[0].stage})` : null,
        guard: guard.map((g) => `${g.ok ? 'OK' : g.block ? 'STOP' : 'WARN'} ${g.t}`),
      });
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
