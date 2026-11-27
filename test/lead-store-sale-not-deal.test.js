import test from 'node:test';
import assert from 'node:assert/strict';

test('a store sale email is not kept as a lead on second look (MyDesigns Black Friday, Nov 27)', async () => {
  const { maybeRealDeal } = await import('../lib/leads.js');
  const e = (subject, text = '') => ({ subject, text });
  const body = 'Black Friday is here. Pay for one year and get two. Pro plan $199/year, Business $499/year. Promotional offer ends at midnight.';
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Promotional Black Friday software sale (buy 1 year, get 2) for MyDesigns platform.' }, e('Black Friday: pay for one year, get two', body)), null);
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'newsletter_or_notice', offer: 'Black Friday promotion for MyDesigns software subscription.' }, e('Black Friday: pay for one year, get two', body)), null);
  // a real paid offer that mentions Black Friday is still kept
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: '$1,500 for one Instagram reel promoting our Black Friday sale' }, e('Paid collaboration for Black Friday', '')));
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Sponsored reel, budget $800, promoting our Black Friday sale' }, e('Quick question', '')));
});
