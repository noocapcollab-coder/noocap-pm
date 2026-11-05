// Raise an invoice from WhatsApp in a few taps (Harsh, Nov 5: "let's add something on WhatsApp so it's easier to raise
// invoices"). Type "invoice": pick the deal from a list, the PM fills in what it already knows (amount, who it's billed
// to, the creator's bank or PayPal details) and asks only for what is missing, one thing at a time, then makes the
// invoice as an email or as a PDF to upload. Plain code all the way: no AI is used until the invoice itself is made.
import { sendText, sendButtons, sendList } from './whatsapp.js';

const say = async (st, text, extra = {}) => { await sendText(st.person.number, text); st.messages.push({ role: 'assistant', content: text, meta: 'wa', at: new Date().toISOString(), ...extra }); };
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const usd = (n) => '$' + Number(n).toLocaleString('en-US');

export const isInvoiceCommand = (t) => /^\s*(raise\s+(an?\s+)?)?invoices?\s*\??\s*$/i.test(String(t || ''));
export const pendingInvoice = (st) => [...st.messages].reverse().slice(0, 20).find((x) => x.meta === 'invoice-setup' && !x.resolved && Date.now() - Date.parse(x.at) < 2 * 36e5);

// Deals ready to bill: posted with no invoice yet, and sponsor cards that are posted or about to post with no deal at all
export async function invoiceCandidates() {
  const { openDeals } = await import('./briefs.js');
  const { allVideos } = await import('./tools.js');
  const deals = await openDeals();
  const out = [];
  for (const d of deals) {
    if (d.stage !== 'Posted' || d.invoiceNumber || String(d.stripeInvoices || '').trim()) continue;
    out.push({ id: `invpick:d|${d.id}`, title: `${d.brand} x ${d.creator || '?'}`, description: `Posted · ${d.finalRate ? usd(d.finalRate) : 'amount not on file'}` });
  }
  const linked = new Set(deals.map((d) => (String(d.linkedVideo || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase()).filter(Boolean));
  const { videos } = await allVideos({ quick: true }).catch(() => ({ videos: [] }));
  for (const v of videos) {
    const n = parseInt(String(v.status || ''), 10);
    if (!v.sponsor || n < 10 || n > 12) continue;
    if (linked.has((String(v.url || v.id).match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase())) continue;
    out.push({ id: `invpick:c|${String(v.id).replace(/-/g, '')}`, title: `${v.title} (${v.creator})`, description: `Card at ${v.status}, no deal yet` });
  }
  return out.slice(0, 10);
}

export async function startInvoice(st) {
  const rows = await invoiceCandidates();
  if (!rows.length) { await say(st, 'Nothing is waiting to be invoiced: no posted deal without an invoice and no posted sponsor card without a deal. To bill something else, tell me "raise the <brand> invoice for <creator>".'); return; }
  await sendList(st.person.number, `🧾 *Raise an invoice*\nThese are posted and not invoiced yet. Pick one and I'll ask only for what's missing.`, 'Pick a deal', rows, 'Ready to invoice');
  st.messages.push({ role: 'assistant', content: '(invoice pick-list sent)', meta: 'wa', at: new Date().toISOString() });
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
  setup.missing = !setup.amount ? 'amount' : !setup.billTo ? 'billTo' : !setup.payment ? 'payment' : null;
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
  const lines = [
    `🧾 *${setup.brand} x ${setup.creator}*`,
    `Amount: ${usd(setup.amount)}`,
    `Billed to: ${String(setup.billTo).replace(/\s*\|\s*/g, ', ').replace(/(Company|Address|Email|Country|Tax ID):\s*/gi, '').slice(0, 300)}`,
    `Paid to: ${setup.creator}'s ${setup.payment === '(on file)' ? 'saved bank/PayPal details' : 'details you just sent'}`,
    '',
    setup.hasThread ? 'Email it to the brand (it waits in Approvals), or make a PDF you upload yourself?' : 'I\'ll make the PDF for you to upload (this deal has no email thread).',
  ];
  const btns = setup.hasThread ? [{ id: 'invgo:email', title: '📧 Email it' }, { id: 'invgo:pdf', title: '📄 PDF to upload' }, { id: 'invgo:cancel', title: '✖️ Cancel' }] : [{ id: 'invgo:pdf', title: '📄 Make the PDF' }, { id: 'invgo:cancel', title: '✖️ Cancel' }];
  await sendButtons(st.person.number, lines.join('\n'), btns);
  st.messages.push({ role: 'assistant', content: lines.join('\n'), meta: 'wa', at: new Date().toISOString() });
}

// A row tapped in the pick-list
export async function pickInvoice(st, arg) {
  const [kind, id] = String(arg || '').split('|');
  let dealId = id;
  if (kind === 'c') {
    const { allVideos } = await import('./tools.js');
    const { videos } = await allVideos({ quick: true });
    const v = videos.find((x) => String(x.id).replace(/-/g, '') === id);
    if (!v) { await say(st, 'I could not find that card any more.'); return; }
    const { dealFromCard } = await import('./ask.js');
    const brand = String(v.title || '').split(/\s+[-x×]\s+|\s+-\s+/)[0].trim();
    const made = await dealFromCard({ brand, creator: v.creator });
    if (made.error) { await say(st, `I couldn't open a deal for it: ${made.error}`); return; }
    dealId = made.id;
  }
  for (const m of st.messages) if (m.meta === 'invoice-setup' && !m.resolved) m.resolved = 'replaced';
  const setup = { role: 'assistant', content: '(invoice setup)', meta: 'invoice-setup', at: new Date().toISOString(), dealId };
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
  setup.resolved = 'done';
  const { invoiceFromChat } = await import('./ask.js');
  const r = await invoiceFromChat({ deal_id: setup.dealId, amount_usd: setup.amount, bill_to: setup.billTo, payment_details: setup.payment === '(on file)' ? '' : setup.payment, upload_to_platform: choice === 'pdf' }).catch((e) => ({ error: e.message }));
  if (r.error || r.need) { setup.resolved = null; await say(st, `I couldn't make it: ${r.error || r.need}`); return; }
  if (choice === 'pdf') await say(st, r.pdf_sent_on_whatsapp ? `✅ Invoice ${r.invoice} (${usd(r.amount)}) is above. Upload it where the brand asked, then tell me "uploaded ${setup.brand}" and I'll mark it invoiced.` : `✅ Invoice ${r.invoice} is made in ${setup.creator}'s Stripe, but the PDF didn't come through here. Open it in Stripe to download it.`);
  else await say(st, `✅ The invoice email for ${setup.brand} x ${setup.creator} is waiting in Approvals with the invoice attached.`);
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
