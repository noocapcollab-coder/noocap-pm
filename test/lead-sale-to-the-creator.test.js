import test from 'node:test';
import assert from 'node:assert/strict';

// MyDesigns, Nov 28 16:00 UTC ("The seller who starts this weekend"): the reader summed the store's Black Friday email up
// as "Promoting MyDesigns tools / Black Friday deal to the creator". "creator" there is who the sale is aimed at, not a
// creator being paid, but the creator-fee check counted it, so the store-sale guard let it through and the email was
// kept "on second look (it offers a paid fee for content)" for the fourth time.
test('a sale pitched "to the creator" is not kept as a lead (MyDesigns, Nov 28)', async () => {
  const { maybeRealDeal } = await import('../lib/leads.js');
  const subject = 'The seller who starts this weekend';
  const text = 'Black Friday: start selling this weekend. Pro plan $199/year, Business $499/year. Offer ends Sunday.';
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Promoting MyDesigns tools / Black Friday deal to the creator' }, { subject, text }), null);
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Black Friday discount offered to you as a creator on MyDesigns Pro' }, { subject, text }), null);
  // paying a creator still counts, even in sale season
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Paying the creator $900 for an Instagram reel about our Black Friday sale' }, { subject: 'Black Friday', text: '' }));
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Influencer reel for our Black Friday sale, $700' }, { subject: 'Black Friday', text: '' }));
});
