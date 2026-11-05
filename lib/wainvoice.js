// Raise an invoice from WhatsApp in a few taps (Harsh, Nov 5: "let's add something on WhatsApp so it's easier to raise
// invoices"). Type "invoice": pick the deal from a list, the PM fills in what it already knows (amount, who it's billed
// to, the creator's bank or PayPal details) and asks only for what is missing, one thing at a time, then makes the
// invoice as an email or as a PDF to upload. Plain code all the way: no AI is used until the invoice itself is made.
import { sendText, sendButtons, sendList } from './whatsapp.js';

const say = async (st, text, extra = {}) => { await sendText(st.person.number, text); st.messages.push({ role: 'assistant', content: text, meta: 'wa', at: new Date().toISOString(), ...extra }); };
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const usd = (n) => '$' + Number(n).toLocaleString('en-US');

export const isInvoiceCommand = (t) => /^\s*(raise\s+(an?\s+)?)?invoices?\s*\??\s*$/i.test(String(t || ''));
// "invoice semrush" or "invoice semrush 1500": straight to that deal, no list
export function quickInvoice(t) {
  const m = String(t || '').trim().match(/^invoice\s+(?!for\b)([a-z0-9][\w .&'-]*?)(?:\s+\$?([\d,]+(?:\.\d+)?))?\s*$/i);
  return m ? { brand: m[1].trim(), amount: m[2] ? Number(m[2].replace(/,/g, '')) : null } : null;
}
export const pendingInvoice = (st) => [...st.messages].reverse().slice(0, 20).find((x) => x.meta === 'invoice-setup' && !x.resolved && Date.now() - Date.parse(x.at) < 2 * 36e5);

// Everything that needs an invoice, the same list as the Invoices page and more (Harsh, Nov 5: the first version showed
// Brad's old cards and missed the rest): brand deals posted with no invoice; sponsor videos posted in the last 30 days
// with no invoice yet (the revenue rows the 9am money digest reads); and sponsor cards at To Post / Ready whose post date
// has come, with no deal (Semrush x Lindsay). Brad invoices by hand, so he is left out. Newest first, 9 to a page.
const BY_HAND = ['brad'];
export async function invoiceCandidates() {
  const { openDeals } = await import('./briefs.js');
  const { allVideos } = await import('./tools.js');
  const { moneyChase } = await import('./money.js');
  const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
  const from = new Date(Date.parse(today) - 30 * 864e5).toISOString().slice(0, 10);
  const [deals, all, mc, vids] = await Promise.all([openDeals(), openDeals({ withClosed: true }), moneyChase().catch(() => ({ needsInvoice: [] })), allVideos({ quick: true }).catch(() => ({ videos: [] }))]);
  const mine = (c) => !BY_HAND.includes(key(c));
  const seen = new Set();
  const pair = (brand, creator) => `${key(brand).replace(/(ai|app|hq|inc)$/, '')}|${key(creator)}`;
  const out = [];
  for (const d of deals) {
    if (d.stage !== 'Posted' || d.invoiceNumber || String(d.stripeInvoices || '').trim() || !mine(d.creator)) continue;
    seen.add(pair(d.brand, d.creator));
    out.push({ when: String(d.delivered || d.lastBrand || '').slice(0, 10), id: `invpick:d|${d.id}`, title: `${d.brand} x ${d.creator || '?'}`, description: `Deal posted · ${d.finalRate ? usd(d.finalRate) : 'amount not on file'}` });
  }
  // a brand already invoiced or paid on a deal is not offered again from its revenue row or card
  const done = new Set(all.filter((d) => ['Invoiced', 'Paid'].includes(d.stage) || d.invoiceNumber).map((d) => pair(d.brand, d.creator)));
  for (const it of mc.needsInvoice || []) {
    const k = pair(it.brand, it.creator);
    if (!mine(it.creator) || seen.has(k) || done.has(k)) continue;
    seen.add(k);
    out.push({ when: it.posted || '', id: `invpick:b|${it.brand}|${it.creator}|${it.amount || ''}`, title: `${it.brand} x ${it.creator}`, description: `Posted ${it.posted || ''}${it.amount ? ' · ' + usd(it.amount) : ' · amount not on file'}` });
  }
  const linked = new Set(all.map((d) => (String(d.linkedVideo || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase()).filter(Boolean));
  for (const v of vids.videos || []) {
    const n = parseInt(String(v.status || ''), 10);
    if (!v.sponsor || ![10, 11].includes(n) || !mine(v.creator) || !v.post_date || v.post_date > today || v.post_date < from) continue;
    if (linked.has((String(v.url || v.id).match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase())) continue;
    const brand = String(v.title || '').split(/\s+[-x×]\s+/)[0].trim();
    const k = pair(brand, v.creator);
    if (seen.has(k) || done.has(k)) continue;
    seen.add(k);
    out.push({ when: v.post_date, id: `invpick:c|${String(v.id).replace(/-/g, '')}`, title: `${brand} x ${v.creator}`, description: `${v.format ? v.format + ' · ' : ''}post date ${v.post_date}, card still at ${String(v.status).replace(/^\d+-\s*/, '')}` });
  }
  return out.sort((a, b) => String(b.when).localeCompare(String(a.when)));
}

export async function startInvoice(st, page = 0) {
  const rows = page ? (([...st.messages].reverse().find((m) => m.meta === 'invoice-list') || {}).rows || []) : await invoiceCandidates();
  if (!rows.length) { await say(st, 'Nothing is waiting to be invoiced right now. To bill something else, tell me "raise the <brand> invoice for <creator>".'); return; }
  if (!page) st.messages.push({ role: 'assistant', content: `(invoice list: ${rows.length})`, meta: 'invoice-list', rows: rows.map(({ id, title, description }) => ({ id, title, description })), at: new Date().toISOString() });
  const slice = rows.slice(page * 9, page * 9 + 9).map(({ id, title, description }) => ({ id, title, description }));
  if (rows.length > (page + 1) * 9) slice.push({ id: `invpage:${page + 1}`, title: 'More…', description: `${rows.length - (page + 1) * 9} more to invoice` });
  const head = page ? `🧾 Page ${page + 1}` : `🧾 *${rows.length} to invoice*\nPick one and I'll ask only for what's missing. Brad invoices by hand, so his aren't here.`;
  await sendList(st.person.number, head, 'Pick a deal', slice, 'Ready to invoice');
}

// What we already know for a deal, and what is still missing
async function fill(setup) {
  const { openDeals } = await import('./briefs.js');
  const I = await import('./invoicing.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => d.id.replace(/-/g, '') === String(setup.dealId).replace(/-/g, ''));
  if (!deal) throw new Error('that deal is gone');
  const cb = await I.creatorBilling(deal.creator).catch(() => ({ payment: '' }));
  setup.brand = deal.brand; setup.creator = deal.creator; setup.hasThread = !!(deal.threadId && deal.channel !== 'WhatsApp');
  if (!setup.amount && Number(deal.finalRate) > 0) setup.amount = Number(deal.finalRate);
  if (!setup.billTo && I.readBilling(deal.billing)) setup.billTo = deal.billing;
  if (!setup.payment && I.paymentDetails(deal, cb.payment)) setup.payment = '(on file)';
  // An email invoice needs only the amount (Stripe bills the brand on the thread and carries the pay link); a PDF to
  // upload also needs who it's billed to and the creator's bank or PayPal details printed on it
  setup.missing = !setup.amount ? 'amount' : setup.mode !== 'pdf' ? null : !setup.billTo ? 'billTo' : !setup.payment ? 'payment' : null;
  return setup;
}

const QUESTION = {
  amount: (s) => `What's the agreed amount for *${s.brand} x ${s.creator}*, in USD? Just the number.`,
  billTo: (s) => `Who is the invoice billed to? Send the company name and address (typed or a screenshot). If ${s.brand} itself is billed, say "${s.brand}" and its address.`,
  payment: (s) => `What are *${s.creator}'s* bank or PayPal details? Typed or a screenshot. I save them, so I won't ask again.`,
};

async function next(st, setup) {
  setup.at = new Date().toISOString(); // the setup stays open while you keep answering
  await fill(setup);
  if (setup.missing) { await say(st, QUESTION[setup.missing](setup)); return; }
  if (setup.mode === 'pdf') { await finishInvoice(st, 'pdf'); return; } // you already chose: no second confirmation
  const lines = [
    `🧾 *${setup.brand} x ${setup.creator}* · ${usd(setup.amount)}`,
    setup.hasThread ? 'Email it in the brand\'s thread, or make a PDF you upload yourself?' : 'No email thread on this one, so I\'ll make the PDF for you to upload.',
  ];
  const btns = setup.hasThread ? [{ id: 'invgo:email', title: '📧 Email it' }, { id: 'invgo:pdf', title: '📄 PDF to upload' }, { id: 'invgo:cancel', title: '✖️ Cancel' }] : [{ id: 'invgo:pdf', title: '📄 Make the PDF' }, { id: 'invgo:cancel', title: '✖️ Cancel' }];
  await sendButtons(st.person.number, lines.join('\n'), btns);
  st.messages.push({ role: 'assistant', content: lines.join('\n'), meta: 'wa', at: new Date().toISOString() });
}

// A row tapped in the pick-list
export async function pickInvoice(st, arg, amount = null) {
  const [kind, id] = String(arg || '').split('|');
  let dealId = id;
  if (kind === 'b') {
    const [, brand, creator, amount] = String(arg).split('|');
    const { openDeals } = await import('./briefs.js');
    const hit = (await openDeals({ withClosed: true })).filter((d) => d.stage !== 'Lost' && key(d.creator) === key(creator) && (key(d.brand).includes(key(brand)) || key(brand).includes(key(d.brand))));
    if (hit.length === 1) dealId = hit[0].id;
    else {
      const { dealFromCard } = await import('./ask.js');
      const made = await dealFromCard({ brand, creator, amount_usd: Number(amount) || undefined });
      if (made.error) { await say(st, `I couldn't open a deal for ${brand} x ${creator}: ${made.error}`); return; }
      dealId = made.id;
    }
  }
  if (kind === 'c') {
    const { allVideos } = await import('./tools.js');
    const { videos } = await allVideos({ quick: true });
    const v = videos.find((x) => String(x.id).replace(/-/g, '') === id);
    if (!v) { await say(st, 'I could not find that card any more.'); return; }
    const { dealFromCard } = await import('./ask.js');
    const brand = String(v.title || '').split(/\s+[-x×]\s+/)[0].trim();
    const made = await dealFromCard({ brand, creator: v.creator });
    if (made.error) { await say(st, `I couldn't open a deal for it: ${made.error}`); return; }
    dealId = made.id;
  }
  for (const m of st.messages) if (m.meta === 'invoice-setup' && !m.resolved) m.resolved = 'replaced';
  const setup = { role: 'assistant', content: '(invoice setup)', meta: 'invoice-setup', at: new Date().toISOString(), dealId, ...(Number(amount) > 0 ? { amount: Number(amount) } : {}) };
  st.messages.push(setup);
  await next(st, setup);
}

// Free text while an invoice is being set up: it answers the question we asked (screenshot text counts too)
export async function answerInvoice(st, setup, text) {
  const t = String(text || '').replace(/^\(sent a screenshot; the text in it reads:\)\s*/i, '').replace(/\(sent a screenshot; the text in it reads:\)\s*/i, '\n').trim();
  if (/^(cancel|stop|leave it|no)\.?$/i.test(t)) { setup.resolved = 'cancelled'; await say(st, 'OK, no invoice made.'); return; }
  if (setup.missing === 'amount') {
    const n = Number((t.replace(/,/g, '').match(/\d+(\.\d+)?/) || [])[0]);
    if (!(n > 0)) { await say(st, 'I need just the amount in USD, like 1500.'); return; }
    setup.amount = n;
  } else if (setup.missing === 'billTo') {
    setup.billTo = /company\s*:/i.test(t) ? t : (() => { const parts = t.split(/\n|,\s*/).map((x) => x.trim()).filter(Boolean); return `Company: ${parts[0]} | Address: ${parts.slice(1).join(', ')}`; })();
  } else if (setup.missing === 'payment') {
    setup.payment = t;
  }
  await next(st, setup);
}

// The final button
export async function finishInvoice(st, choice) {
  const setup = pendingInvoice(st);
  if (!setup) { await say(st, 'That invoice setup has expired. Type "invoice" to start again.'); return; }
  if (choice === 'cancel') { setup.resolved = 'cancelled'; await say(st, 'OK, no invoice made.'); return; }
  if (choice === 'pdf' && setup.mode !== 'pdf') { setup.mode = 'pdf'; await fill(setup); if (setup.missing) { setup.at = new Date().toISOString(); await say(st, QUESTION[setup.missing](setup)); return; } }
  setup.resolved = 'done';
  const { invoiceFromChat } = await import('./ask.js');
  const r = await invoiceFromChat({ deal_id: setup.dealId, amount_usd: setup.amount, bill_to: choice === 'pdf' ? setup.billTo : '', payment_details: setup.payment && setup.payment !== '(on file)' ? setup.payment : '', upload_to_platform: choice === 'pdf' }, { notify: false }).catch((e) => ({ error: e.message }));
  if (r.error || r.need) { setup.resolved = null; await say(st, `I couldn't make it: ${r.error || r.need}`); return; }
  if (choice === 'pdf') await say(st, r.pdf_sent_on_whatsapp ? `✅ Invoice ${r.invoice} (${usd(r.amount)}) is above. Upload it where the brand asked, then tell me "uploaded ${setup.brand}" and I'll mark it invoiced.` : `✅ Invoice ${r.invoice} is made in ${setup.creator}'s Stripe, but the PDF didn't come through here. Open it in Stripe to download it.`);
  else await showEmail(st, r.draft, setup);
}

// "uploaded Semrush": the PDF went up on the brand's platform, so the deal is invoiced from today and the chase starts
export async function markUploaded(st, brandText) {
  const { openDeals } = await import('./briefs.js');
  const { notion } = await import('./notion.js');
  const b = key(brandText);
  const hits = (await openDeals()).filter((d) => b.length >= 3 && key(d.brand).includes(b) && /^Upload invoice/i.test(d.nextAction || ''));
  if (hits.length !== 1) { await say(st, hits.length ? `More than one deal matches: ${hits.map((d) => `${d.brand} x ${d.creator}`).join(', ')}. Say the brand and creator.` : `I don't have an invoice waiting to be uploaded for "${brandText}".`); return; }
  const d = hits[0];
  const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
  const { DUE_DAYS } = await import('./invoicing.js');
  const due = new Date(Date.parse(today) + (DUE_DAYS || 3) * 864e5).toISOString().slice(0, 10);
  await notion('PATCH', `/pages/${d.id}`, { properties: {
    'Deal Stage': { select: { name: 'Invoiced' } },
    'Invoice Sent Date': { date: { start: today } },
    'Invoice Due Date': { date: { start: due } },
    'Next Action': { rich_text: [{ type: 'text', text: { content: `Waiting for payment (invoice ${d.invoiceNumber || ''} uploaded ${today})` } }] },
  } });
  await say(st, `✅ ${d.brand} x ${d.creator} is marked invoiced from today. I'll keep an eye on the payment.`);
}
export const uploadedCommand = (t) => (String(t || '').match(/^\s*uploaded\s+(?:the\s+)?(.+?)(?:\s+invoice)?\s*\.?\s*$/i) || [])[1] || null;

// The invoice email exactly as it will go, with Send / Edit / Reject and the invoice PDF under it (Harsh, Nov 5: "when I
// say email it, it should immediately show me the email"). Swipe-reply to the card to change the wording.
async function showEmail(st, draftId, setup) {
  if (!draftId) { await say(st, `The invoice for ${setup.brand} x ${setup.creator} is made, but I couldn't find its email. It's in Approvals.`); return; }
  const W = await import('./whatsapp.js');
  const { readDraftById } = await import('./outbox.js');
  const d = await readDraftById(draftId).catch(() => null);
  if (!d) { await say(st, 'The invoice email is in Approvals.'); return; }
  d.brand = d.brand || setup.brand; d.creator = d.creator || setup.creator;
  const r = await W.sendButtons(st.person.number, W.draftCard(d), W.draftButtons(d.id));
  st.messages.push({ role: 'assistant', content: W.draftCard(d), meta: 'draft', draft: d.id, wid: W.sentId(r), at: new Date().toISOString() });
  await W.sendDraftAttachment(st.person.number, d.id).catch(() => false);
}

// "invoice semrush 1500": find the one thing to bill and go straight to it
export async function quickStart(st, q) {
  const b = key(q.brand);
  const rows = (await invoiceCandidates()).filter((r) => key(r.title.split(' x ')[0]).includes(b) || b.includes(key(r.title.split(' x ')[0])));
  if (rows.length === 1) { await pickInvoice(st, rows[0].id.slice('invpick:'.length), q.amount); return; }
  if (rows.length > 1) { await sendList(st.person.number, `More than one matches "${q.brand}". Which one?`, 'Pick a deal', rows.slice(0, 10).map(({ id, title, description }) => ({ id, title, description })), 'Ready to invoice'); return; }
  const { openDeals } = await import('./briefs.js');
  const hit = (await openDeals()).filter((d) => key(d.brand).includes(b));
  if (hit.length === 1) { await pickInvoice(st, `d|${hit[0].id}`, q.amount); return; }
  await say(st, `I can't find anything to invoice for "${q.brand}". Type "invoice" to see the list.`);
}
