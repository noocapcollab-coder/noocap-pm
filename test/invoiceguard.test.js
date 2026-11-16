import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceProblems, fixGreeting, brandSigners, strayPaymentDetails, amountsIn, paymentText, blocking } from '../lib/invoiceguard.js';

const convo = [
  '📨 2026-11-01 · brand (Harper Lee <harper@readdy.ai>) · Paid collaboration\nHi team, we can do $1,200 for one Instagram reel and one YouTube Short.\n\nBest,\nHarper',
  '📨 2026-11-02 · us (NOOCAP) · Re: Paid collaboration\nSounds good.',
  '📨 2026-11-12 · brand (Harper Lee <harper@readdy.ai>) · Re: Paid collaboration\nBilling: INTERACTIVE LINK PTE. LTD., 10 Anson Road, Singapore.\n\nThanks,\nHarper',
].join('\n\n');
const deal = { id: 'd1', brand: 'Readdy', creator: 'Lindsay', finalRate: 1200, deliverables: 'Instagram reel + YouTube Short', postedLinks: 'https://www.instagram.com/reel/DfvNh_pGUud/\nhttps://www.youtube.com/shorts/A93bIb5wbPM', created: '2026-10-30T00:00:00Z' };
const bill = { company_name: 'INTERACTIVE LINK PTE. LTD.' };
const yt = { A93bIb5wbPM: { channelId: 'UCgugjY9T1jv41UcKmaZ5NLQ', at: '2026-11-14T10:00:00Z' } };

test('a clean invoice passes every check', () => {
  const p = invoiceProblems({ deal, bill, amount: 1200, pct: 100, convo, youtube: yt, channels: ['UCgugjY9T1jv41UcKmaZ5NLQ'], revenue: [1200], otherDealLinks: new Set() });
  assert.deepEqual(blocking(p), []);
  assert.ok(p.every((x) => x.ok), JSON.stringify(p.filter((x) => !x.ok)));
});

test('wrong amount, wrong platform, wrong company and a reused link are stopped', () => {
  const bad = { ...deal, deliverables: 'Instagram reel + TikTok', postedLinks: 'https://www.instagram.com/reel/DfvNh_pGUud/' };
  const p = blocking(invoiceProblems({ deal: bad, bill: { company_name: 'Readdy Inc' }, amount: 1500, pct: 100, convo, revenue: [1000], otherDealLinks: new Set(['https://www.instagram.com/reel/DfvNh_pGUud']) }));
  const keys = p.map((x) => x.k);
  for (const k of ['amount-match', 'amount-revenue', 'billing-source', 'platforms']) assert.ok(keys.includes(k), k);
  assert.ok(keys.some((k) => k.startsWith('link-')));
});

test('a YouTube link from another channel or from before the deal is stopped', () => {
  const p1 = blocking(invoiceProblems({ deal, bill, amount: 1200, convo, youtube: { A93bIb5wbPM: { channelId: 'UCother', at: '2026-11-14T00:00:00Z' } }, channels: ['UCgugjY9T1jv41UcKmaZ5NLQ'] }));
  assert.ok(p1.some((x) => /another YouTube channel/.test(x.t)));
  const p2 = blocking(invoiceProblems({ deal, bill, amount: 1200, convo, youtube: { A93bIb5wbPM: { channelId: 'UCgugjY9T1jv41UcKmaZ5NLQ', at: '2026-09-01T00:00:00Z' } }, channels: ['UCgugjY9T1jv41UcKmaZ5NLQ'] }));
  assert.ok(p2.some((x) => /before this deal began/.test(x.t)));
});

test('the greeting only names someone who signed the brand\'s emails (Natalia, not Pavinder)', () => {
  const c = '📨 2026-11-10 · brand (Natalia Brown <payments@houseofmarketers.com>) · Invoice\nHi, please send the invoice.\n\nBest,\nNatalia';
  assert.ok(brandSigners(c).has('natalia'));
  assert.equal(fixGreeting('Hi Pavinder,\n\nHere is the invoice.', c).body, 'Hi there,\n\nHere is the invoice.');
  assert.equal(fixGreeting('Hi Natalia,\n\nHere is the invoice.', c).changed, false);
});

test('bank or PayPal lines that are not the verified ones are caught', () => {
  assert.equal(strayPaymentDetails('Pay here: {{invoice_link}}').length, 0);
  assert.equal(strayPaymentDetails('Account number: 12345680\nRouting: 026073150').length, 2);
  const v = paymentText({ 'PayPal Email': 'duncan@buildroom.ai' });
  assert.equal(strayPaymentDetails('PayPal: duncan@buildroom.ai', v).length, 0);
  assert.equal(strayPaymentDetails('PayPal: someone@else.com', v).length, 1);
});

test('fees are read however they are written', () => {
  for (const t of ['$1,200', '1200 USD', 'USD 1,200', '$1.2k', 'US$1200']) assert.ok(amountsIn(t).has(1200), t);
});

import { asksOtherPayment, detailsFor, paymentDetailsEmail } from '../lib/invoiceguard.js';
test('a brand that can only pay by bank or PayPal is recognised', () => {
  assert.equal(asksOtherPayment('Our finance team only pays by bank transfer, could you share the bank details?'), 'Bank transfer');
  assert.equal(asksOtherPayment('We can\'t pay through Stripe, do you have PayPal?'), 'PayPal');
  assert.equal(asksOtherPayment('Can you send wire or PayPal info?'), 'any');
  assert.equal(asksOtherPayment('Thanks, we will pay the invoice this week.'), null);
});
test('only the details they asked for are sent, word for word from the table', () => {
  const row = { 'Account Holder Name': 'Chris Cordero', 'Bank Name': 'Chase', 'Account Number / IBAN': '000123', 'Routing / SWIFT / IFSC / Sort Code': '021000021', 'PayPal Email': 'chris@x.com' };
  assert.equal(detailsFor(row, 'PayPal'), 'PayPal: chris@x.com');
  assert.ok(!/PayPal/.test(detailsFor(row, 'Bank transfer')) && /000123/.test(detailsFor(row, 'Bank transfer')));
  const body = paymentDetailsEmail({ name: 'Natalia', creator: 'Chris', amount: 3600, number: 'INV-002', details: detailsFor(row, 'Bank transfer'), want: 'Bank transfer' });
  assert.match(body, /^Hi Natalia,/);
  assert.match(body, /INV-002/);
  assert.match(body, /Account number \/ IBAN: 000123/);
  assert.deepEqual(strayPaymentDetails(body, paymentText(row)), []);
});

import { pickDetails } from '../lib/invoiceguard.js';
test('PayPal asked but only a bank on file: the email says so instead of calling bank lines PayPal', () => {
  const row = { 'Bank Name': 'Chase', 'Account Number / IBAN': '000123' };
  const p = pickDetails(row, 'PayPal');
  assert.equal(p.sent, 'Bank transfer'); assert.equal(p.instead, true);
  const body = paymentDetailsEmail({ name: 'Sophie', creator: 'Chris', details: p.details, want: p.sent, asked: 'PayPal', instead: p.instead });
  assert.match(body, /Chris doesn't take PayPal, so here are Chris's bank details instead/);
});
test('platforms: a brand naming other platforms stops it, emails naming none only warn', () => {
  const d = { finalRate: 0, deliverables: 'Instagram reel + YouTube Short' };
  const silent = '📨 2026-11-01 · brand (Harper <h@x.ai>) · Re\nThanks, billing details below.';
  const other = '📨 2026-11-01 · brand (Harper <h@x.ai>) · Re\nOne TikTok video please.';
  assert.equal(invoiceProblems({ deal: d, convo: silent }).find((x) => x.k === 'platforms').block, false);
  assert.equal(invoiceProblems({ deal: d, convo: other }).find((x) => x.k === 'platforms').block, true);
});
