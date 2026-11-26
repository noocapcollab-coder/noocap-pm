// PM LESSONS "Deal Memory billing follows the invoice actually paid, not the split the brand first proposed" (Manyfast
// x Duncan, Nov 26, afternoon check) had no code guard: the memory writer never saw the deal's Stripe invoices, so it
// kept the brand's 50/50 proposal as "balance pending publication" after the full $1,600 was paid. Bug hunter, Nov 26.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceFacts } from '../lib/memory.js';

test('a fee paid in full in Stripe reaches the memory writer as "no balance is due"', () => {
  const deal = { finalRate: 1600, stripeInvoices: 'full | in_1Abc | paid | 1600' };
  const f = invoiceFacts(deal);
  assert.match(f, /full \$1600 paid/);
  assert.match(f, /Paid in full \(\$1600 of the \$1600 fee\): no balance is due/);
});

test('a part payment is listed but never called paid in full', () => {
  const f = invoiceFacts({ finalRate: 1600, stripeInvoices: 'deposit | in_1 | paid | 800\nfinal | in_2 | sent | 800' });
  assert.match(f, /deposit \$800 paid; final \$800 sent/);
  assert.doesNotMatch(f, /Paid in full/);
});

test('no Stripe invoices, nothing added; void invoices are ignored', () => {
  assert.equal(invoiceFacts({ finalRate: 500 }), '');
  assert.equal(invoiceFacts({ finalRate: 500, stripeInvoices: 'full | in_9 | void | 500' }), '');
});
