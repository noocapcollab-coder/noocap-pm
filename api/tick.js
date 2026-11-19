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
  // ?filecontract=<gmail thread id>&deal=<deal id>: file a contract the inbox missed. Takes the newest brand email in the
  // thread with an agreement PDF and runs the normal contract step (CONTRACTS row, WhatsApp, fixed ack to the brand).
  // Never signs anything (Fotor x Duncan, Nov 20)
  if (req.query?.filecontract) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const { partsWithFiles, hydrateAttachments } = await import('../lib/gmailfiles.js');
      const r = await fetch(process.env.N8N_DRIVE_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hook-secret': process.env.PM_HOOK_SECRET || '' }, body: JSON.stringify({ method: 'GET', url: `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(String(req.query.filecontract))}?format=full` }) });
      const j = await r.json().catch(() => ({}));
      const msgs = ((j.data || j).messages || []).slice().reverse();
      const h = (m, n) => ((m.payload?.headers || []).find((x) => x.name.toLowerCase() === n) || {}).value || '';
      const m = msgs.find((x) => !/noocap/i.test(h(x, 'from')) && partsWithFiles(x.payload).some((p) => /agreement|contract/i.test(p.filename)));
      if (!m) return res.status(404).json({ error: 'no brand email with an agreement in that thread' });
      const files = partsWithFiles(m.payload).filter((p) => /\.(pdf|docx?)$/i.test(p.filename)).map((p) => ({ filename: p.filename, mimeType: p.mimeType, size: p.size }));
      const email = { gmailId: m.id, threadId: m.threadId, messageId: h(m, 'message-id'), from: h(m, 'from'), subject: h(m, 'subject'), date: h(m, 'date'), text: m.snippet || '', attachments: files };
      await hydrateAttachments(email);
      const { openDeals } = await import('../lib/briefs.js');
      const deal = req.query.deal ? (await openDeals({ withClosed: true })).find((d) => String(d.id).replace(/-/g, '') === String(req.query.deal).replace(/-/g, '')) : null;
      if (req.query.deal && !deal) return res.status(404).json({ error: 'deal not found' });
      const M = await import('../lib/inbox.js');
      const x = { from_role: 'brand', brand: deal?.brand, creator: deal?.creator, delivers: ['contract'], summary: [`${deal?.brand || 'The brand'} sent the contract (${files.map((f) => f.filename).join(', ')})`] };
      if (req.query.dry) {
        const { pdfText } = await import('../lib/pdftext.js');
        const text = await Promise.all(email.attachments.map((a) => (a.data && /pdf/i.test(`${a.mimeType} ${a.filename}`) ? pdfText(a.data, 12000).catch(() => '') : '')));
        return res.status(200).json({ from: email.from, date: email.date, files: files.map((f) => f.filename), hasData: email.attachments.map((a) => !!a.data), deal: deal ? `${deal.brand} × ${deal.creator}` : null, text });
      }
      const note = await M.contractToWhatsApp(email, x, deal);
      return res.status(200).json({ from: email.from, files: files.map((f) => f.filename), result: note });
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?scriptgates=<creator>: why each deal's script has or hasn't gone (read only)
  if (req.query?.scriptgates) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try { const H = await import('../lib/heartbeat.js'); return res.status(200).json(await H.scriptGates(String(req.query.scriptgates))); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?scriptdraft=<dealId>&cards=<cardId,cardId>: put the revised scripts of these cards into Approvals as ONE Script
  // email (waits for Harsh's Send, never sent here). For scripts sent before versions were tracked (Nov 20)
  if (req.query?.scriptdraft) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const { openDeals } = await import('../lib/briefs.js');
      const deal = (await openDeals({ withClosed: true })).find((d) => String(d.id).replace(/-/g, '') === String(req.query.scriptdraft).replace(/-/g, ''));
      if (!deal) return res.status(404).json({ error: 'deal not found' });
      const { notion, titleOf } = await import('../lib/notion.js');
      const cards = [];
      for (const id of String(req.query.cards || '').split(',').filter(Boolean)) { const pg = await notion('GET', `/pages/${id.trim()}`); cards.push({ url: pg.url, title: titleOf(pg) }); }
      if (!cards.length) return res.status(400).json({ error: 'cards needed' });
      const O = await import('../lib/outbox.js');
      const titles = cards.map((c) => c.title);
      const mail = await O.writeEmail({ kind: 'Script', deal, facts: { video_titles: titles, script_count: cards.length, revised: true, note: `${cards.length} revised script PDFs are attached, one per video (${titles.join(', ')}). Say the updated scripts are attached and ask them to approve or share feedback on each. Do not describe the scripts.` } });
      const r = await O.createDraft({ kind: 'Script', deal, subject: mail.subject, body: mail.body, attach: 'Script PDF', video: cards[0].url, context: `Script cards: ${cards.map((c) => c.url).join(' ')}`, why: `Revised scripts for ${titles.join(', ')} are back at Script Approval (Harsh, Nov 20). Waiting for your Send.`, notify: true, sameAs: cards.map((c) => c.url).join(' ') });
      return res.status(200).json({ deal: `${deal.brand} × ${deal.creator}`, titles, draft: r.id || r, created: r.created, body: mail.body });
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  // ?statusopts=1: each creator board's Status options with colour and group (read only), for adding a new status
  if (req.query?.statusopts) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const { BOARDS } = await import('../lib/tools.js'); const { notion } = await import('../lib/notion.js');
      const out = {};
      for (const b of BOARDS) {
        try {
          const ds = await notion('GET', `/data_sources/${b.ds}`);
          const st = Object.values(ds.properties || {}).find((p) => p.name === 'Status');
          if (!st) { out[b.creator] = 'no Status'; continue; }
          const groupOf = {}; for (const g of st.status?.groups || []) for (const id of g.option_ids || []) groupOf[id] = g.name;
          out[b.creator] = { ds: b.ds, type: st.type, options: (st.status?.options || st.select?.options || []).map((o) => ({ name: o.name, color: o.color, group: groupOf[o.id] || null })) };
        } catch (e) { out[b.creator] = 'error: ' + String(e.message).slice(0, 100); }
      }
      return res.status(200).json(out);
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
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
  // ?draftreply=<dealId> (POST {body}): put a reply Harsh asked Claude to write into Approvals for his Send, in the deal's
  // own thread with its CCs. Nothing is sent (Nov 19: brand emails left unanswered all week)
  // ?stripepaid=<days> (read only): every invoice in each creator's Stripe from the last N days, paid and still open,
  // so Harsh can see which payments really came in (Nov 19: Revenue rows sat under Awaiting payment after Stripe paid)
  // ?wanote=1 (POST {text}): send Harsh one WhatsApp message Claude wrote for him (Nov 19: payment confirmations to forward)
  if (req.query?.wanote) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text needed' });
    try { const W = await import('../lib/whatsapp.js'); return res.status(200).json(await W.sendContract({ text: text.slice(0, 3500), label: 'note' })); } catch (e) { return res.status(500).json({ error: String(e.message).slice(0, 200) }); }
  }
  // ?stripeacct=<creator> (read only): the creator's Stripe account, the bank it pays out to (Stripe shows last 4 only)
  // and the bank-transfer details on the newest open invoice (Nov 19: Harsh asked for Chris's Stripe bank details)
  if (req.query?.stripeacct) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const I = await import('../lib/invoicing.js');
      const acct = await I.creatorStripe(String(req.query.stripeacct));
      if (!acct) return res.status(404).json({ error: 'no Stripe connected' });
      const out = {};
      const safe = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'error: ' + String(e.message).slice(0, 140); } };
      await safe('account', async () => { const a = await I.stripe(acct.key, 'GET', '/account'); return { id: a.id, name: a.business_profile?.name || a.settings?.dashboard?.display_name || '', email: a.email || '', country: a.country, currency: a.default_currency, payouts: (a.external_accounts?.data || []).map((b) => ({ bank: b.bank_name, last4: b.last4, routing: b.routing_number, currency: b.currency, holder: b.account_holder_name, default: b.default_for_currency })) }; });
      await safe('balance', async () => { const b = await I.stripe(acct.key, 'GET', '/balance'); return { available: (b.available || []).map((x) => `${x.amount / 100} ${x.currency}`), pending: (b.pending || []).map((x) => `${x.amount / 100} ${x.currency}`) }; });
      await safe('openInvoice', async () => {
        const r = await I.stripe(acct.key, 'GET', '/invoices', { status: 'open', limit: 1 });
        const inv = (r.data || [])[0]; if (!inv) return null;
        const pay = { number: inv.number, customer: inv.customer_name, methods: inv.payment_settings?.payment_method_types || 'account default', page: inv.hosted_invoice_url };
        if (inv.customer) { try { const c = await I.stripe(acct.key, 'GET', `/customers/${inv.customer}/cash_balance`); pay.cashBalance = c.available || {}; } catch { /* bank transfers off */ } }
        return pay;
      });
      return res.status(200).json(out);
    } catch (e) { return res.status(500).json({ error: String(e.message).slice(0, 200) }); }
  }
  if (req.query?.stripepaid) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const I = await import('../lib/invoicing.js');
      const days = Math.min(Number(req.query.stripepaid) || 90, 365);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const out = {};
      for (const c of ['Duncan', 'Chris', 'Lindsay', 'Valeri', 'Brad', 'Emtech', 'David Iya', 'Nicole']) {
        const acct = await I.creatorStripe(c).catch(() => null);
        if (!acct) { out[c] = 'no Stripe connected'; continue; }
        try {
          const r = await I.stripe(acct.key, 'GET', '/invoices', { limit: 100, created: { gte: since } });
          out[c] = (r.data || []).filter((i) => i.status !== 'draft').map((i) => ({ number: i.number, status: i.status, customer: i.customer_name || i.customer_email || '', amount: (i.status === 'paid' ? i.amount_paid : i.amount_due) / 100, currency: i.currency, created: new Date(i.created * 1000).toISOString().slice(0, 10), paid: i.status_transitions?.paid_at ? new Date(i.status_transitions.paid_at * 1000).toISOString().slice(0, 10) : null, outside: !!i.paid_out_of_band, what: (i.lines?.data?.[0]?.description || '').slice(0, 80) }));
        } catch (e) { out[c] = 'error: ' + String(e.message).slice(0, 120); }
      }
      return res.status(200).json(out);
    } catch (e) { return res.status(500).json({ error: String(e.message).slice(0, 200) }); }
  }
  // ?paythanks=<dealId> (&dry=1 to only look): send the fixed payment thank-you in the brand's thread, only when Stripe
  // shows the deal paid (Nov 19: ElevenLabs x Duncan, finance said it paid and Stripe agreed)
  // ?markpaid=<dealId>: Harsh says the money arrived outside Stripe (Readdy x Lindsay, Nov 19). Marks the deal and its
  // Revenue row Paid, closes the open Stripe invoice as paid outside Stripe (stops its reminders) and thanks the brand
  if (req.query?.markpaid) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const { openDeals } = await import('../lib/briefs.js');
      const deal = (await openDeals({ withClosed: true })).find((d) => String(d.id).replace(/-/g, '') === String(req.query.markpaid).replace(/-/g, ''));
      if (!deal) return res.status(404).json({ error: 'deal not found' });
      const I = await import('../lib/invoicing.js');
      const { notion } = await import('../lib/notion.js');
      const out = { deal: `${deal.brand} × ${deal.creator}`, was: deal.stage };
      const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
      const na = I.paidNextAction(await I.creatorCut(deal.creator));
      await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Deal Stage': { select: { name: 'Paid' } }, 'Paid Date': { date: { start: today } }, 'Next Action': { rich_text: [{ type: 'text', text: { content: `Paid outside Stripe (Harsh confirmed ${today}). ${na}`.slice(0, 1900) } }] } } });
      out.stage = 'Paid';
      try { out.stripe = await I.closeStripePaidOutside(deal); } catch (e) { out.stripe = 'error: ' + String(e.message).slice(0, 120); }
      const M = await import('../lib/inbox.js');
      try { out.revenue = await M.markRevenuePaid(deal, { amount: deal.invoiceAmount || deal.finalRate, currency: 'usd', paid_date: today }); } catch (e) { out.revenue = 'error: ' + String(e.message).slice(0, 120); }
      try { out.thanks = await M.paymentThanks(deal); } catch (e) { out.thanks = 'error: ' + String(e.message).slice(0, 120); }
      return res.status(200).json(out);
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  if (req.query?.paythanks) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const { openDeals } = await import('../lib/briefs.js');
      const deal = (await openDeals({ withClosed: true })).find((d) => String(d.id).replace(/-/g, '') === String(req.query.paythanks).replace(/-/g, ''));
      if (!deal) return res.status(404).json({ error: 'deal not found' });
      const I = await import('../lib/invoicing.js');
      const st = await I.stripeState(deal).catch((e) => ({ known: false, error: e.message }));
      const look = { deal: `${deal.brand} × ${deal.creator}`, stage: deal.stage, thread: !!deal.threadId, to: deal.brandEmail, stripePaid: !!(st.known && st.allPaid) };
      if (req.query.dry || !look.stripePaid) return res.status(200).json({ ...look, sent: false });
      const { paymentThanks } = await import('../lib/inbox.js');
      return res.status(200).json({ ...look, result: await paymentThanks(deal) });
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
  if (req.query?.draftreply) {
    if (!hookAllowed(req)) return res.status(401).json({ error: 'hook secret needed' });
    try {
      const { openDeals } = await import('../lib/briefs.js');
      const { createDraft } = await import('../lib/outbox.js');
      const deal = (await openDeals({ withClosed: true })).find((d) => String(d.id).replace(/-/g, '') === String(req.query.draftreply).replace(/-/g, ''));
      if (!deal) return res.status(404).json({ error: 'deal not found' });
      const body = String(req.body?.body || '').trim();
      if (!body) return res.status(400).json({ error: 'body needed' });
      const r = await createDraft({ kind: 'Reply', deal, subject: `Re: ${deal.threadSubject || deal.brand}`, body, video: deal.linkedVideo, why: `Needs you: reply written by Claude for Harsh (unanswered brand email) · ${deal.brand} × ${deal.creator}` });
      return res.status(200).json({ created: !!r?.created, id: r?.id, reason: r?.reason });
    } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
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
