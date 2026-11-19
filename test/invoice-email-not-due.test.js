// Bug hunter, Nov 19: Manyfast x Chris (50% on script approval, 50% after publication). The final share's Stripe draft
// made on Nov 17 stayed on the deal after its email was rejected, and step 3 of the Invoices step ("every Stripe draft
// has its email in Approvals") wrote a fresh final-invoice email at 00:17 UTC on Nov 19, while the video was still in
// changes and not published. Only parts that are due get an invoice email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftsToEmail } from '../lib/invoicing.js';

const manyfast = {
  stage: 'Invoiced', paymentTerms: '50% upon script approval, 50% after publication', finalRate: 1500, postedLinks: '', linksSent: '',
  stripeInvoices: 'upfront | in_up | paid | 750\nfinal | in_fin | draft | 750',
};
const list = [{ part: 'upfront', id: 'in_up', status: 'paid', amount: 750 }, { part: 'final', id: 'in_fin', status: 'draft', amount: 750 }];

test('a final-share Stripe draft gets no invoice email before the video is live', () => {
  assert.deepEqual(draftsToEmail(manyfast, list), []);
});

test('the same final draft gets its email once the video is posted', () => {
  const posted = { ...manyfast, stage: 'Posted', postedLinks: 'https://instagram.com/reel/x' };
  assert.deepEqual(draftsToEmail(posted, list).map((x) => x.id), ['in_fin']);
});

test('an upfront draft that is due and a hand pay-link draft still get their email', () => {
  const up = { ...manyfast, stage: 'Script Approved', stripeInvoices: '' };
  assert.deepEqual(draftsToEmail(up, [{ part: 'upfront', id: 'in_a', status: 'draft', amount: 750 }]).map((x) => x.id), ['in_a']);
  assert.deepEqual(draftsToEmail(manyfast, [{ part: 'extra', id: 'in_x', status: 'draft', amount: 100 }]).map((x) => x.id), ['in_x']);
});

// Same run: the reply-writer's filler rewrite handed back the first draft when the rewrite still had a timing promise.
test('a filler sentence left after the rewrite is taken out, and "as soon as it is live" counts as filler', async () => {
  const { dropFillerSentences, needsFillerRewrite } = await import('../lib/outbox.js');
  assert.equal(needsFillerRewrite('Hi Mia,\n\nThanks! We will share the live link here as soon as it is live.'), true);
  const body = 'Hi Mia,\n\nThanks for clearing the video. We will publish it on Instagram shortly. The ad code will be in this thread with the live link.\n\nBest,\nChris\'s Team';
  const out = dropFillerSentences(body);
  assert.ok(!/shortly/.test(out));
  assert.ok(/ad code will be in this thread/.test(out));
  // nothing but the promise: kept as it was so the draft is held instead of going out empty
  assert.equal(dropFillerSentences('Hi Mia,\n\nWe will post it shortly.\n\nBest,\nTeam'), 'Hi Mia,\n\nWe will post it shortly.\n\nBest,\nTeam');
});
