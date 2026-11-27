// PM LESSONS "No repeat billing-details requests if already provided or requested" (Draft rejected, Nov 27) had no code
// guard: sendBillingAsk only looked for its own billing templates in the thread, so a reply Harsh sent by hand asking
// Jenny for Dreamina's company details (Nov 26 21:57 UTC) left the 3-day billing reminder running. Bug hunter, Nov 27.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingAskedIn } from '../lib/invoicing.js';

const now = Date.parse('2026-11-27T01:00:00Z');
const harsh = 'Hi Jenny,<br /><br />For payment, we\'ll send you an invoice through Stripe once the video is live.<br /><br />To raise that invoice, could you share your company\'s billing details (registered company name, billing email, full address, and tax ID if you have one)?<br /><br />Best,<br />Chris\'s Team';

test('a hand-sent reply that asked for the billing details blocks the reminder', () => {
  const r = billingAskedIn([{ status: 'Sent', body: harsh, created: '2026-11-26T21:55:35Z', sentAt: '2026-11-26T21:57:00Z' }], { now });
  assert.ok(r);
});

test('an approval email asking for the details, waiting in Approvals, also counts', () => {
  const body = 'Hi Lim,<br /><br />Thanks for approving the video. In the meantime, could you please send over your company\'s billing details? That way the invoice can go out with the live link.';
  assert.ok(billingAskedIn([{ status: 'Draft', body, created: '2026-11-26T10:27:00Z' }], { now }));
});

test('older asks, rejected drafts and emails that only mention billing details do not block it', () => {
  assert.equal(billingAskedIn([{ status: 'Sent', body: harsh, sentAt: '2026-11-22T10:00:00Z' }], { now }), null);
  assert.equal(billingAskedIn([{ status: 'Rejected', body: harsh, created: '2026-11-26T21:00:00Z' }], { now }), null);
  assert.equal(billingAskedIn([{ status: 'Sent', body: 'Hi Dori,<br />Here is the revised cut: https://f.io/x', sentAt: '2026-11-26T16:49:00Z' }], { now }), null);
  assert.equal(billingAskedIn([{ status: 'Sent', body: 'Thanks for your billing details, the invoice is attached.', sentAt: '2026-11-26T16:49:00Z' }], { now }), null);
});
