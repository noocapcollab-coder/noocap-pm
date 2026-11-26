import test from 'node:test';
import assert from 'node:assert/strict';
import { needsBillingAsk, paidThroughPlatform } from '../lib/invoicing.js';
import { findDue } from '../lib/duewatch.js';

// PM LESSONS "A fee the brand already scheduled through a partner platform needs no invoice" (system check, Nov 25):
// ZenBusiness x Lindsay BD-48 is paid through Awin (Ronnie, Jul 2: "net payment terms in Awin"). After the videos were
// approved the PM asked Natalie for company billing details and the due watch listed the deal as "posted, no invoice".
// The lesson says to record "Paid through <platform>" in the deal's Billing Details; nothing in the code read it.

test('a Billing Details line saying the fee is paid through a platform is recognised', () => {
  assert.equal(paidThroughPlatform('Paid through Awin (net terms, scheduled Jul 14)'), 'Awin');
  assert.equal(paidThroughPlatform('paid via impact.com'), 'Impact.com');
  assert.equal(paidThroughPlatform('Company: Acme Inc | Email: ap@acme.com'), null);
  assert.equal(paidThroughPlatform(''), null);
  assert.equal(paidThroughPlatform('Paid via bank transfer'), null);
  assert.equal(paidThroughPlatform('Paid via Gusto'), null);
  assert.equal(paidThroughPlatform('paid through Faved, upload the invoice there'), null);
});

test('no billing-details ask for a deal paid through a partner platform', () => {
  const deal = { stage: 'Posted', billing: 'Paid through Awin' };
  assert.equal(needsBillingAsk(deal), false);
  assert.equal(needsBillingAsk({ stage: 'Posted', billing: '' }), true);
  // ZenBusiness's real deal: Billing Details empty, the platform is in Notes and the Deal Memory BILLING line
  assert.equal(needsBillingAsk({ stage: 'Posted', billing: '', notes: 'Pays through Awin (partnership platform, publisher ID 2933515)' }), false);
  assert.equal(needsBillingAsk({ stage: 'Posted', billing: '', memory: 'BILLING: Paid through Awin, no invoice or billing details needed.' }), false);
});

test('the due watch never lists a platform-paid deal as posted with no invoice', () => {
  const now = Date.parse('2026-11-26T00:00:00Z');
  const base = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', brand: 'ZenBusiness', creator: 'Lindsay', stage: 'Posted', linksSent: '2026-11-20', channel: 'Email' };
  const flagged = (d) => findDue({ deals: [d], now }).some((x) => x.kind === 'invoice' || /no invoice/.test(x.text || x.msg || JSON.stringify(x)));
  assert.equal(flagged({ ...base, billing: '' }), true);
  assert.equal(flagged({ ...base, billing: 'Paid through Awin' }), false);
});
