import test from 'node:test';
import assert from 'node:assert/strict';

// CreatorRates, Nov 27 20:39 UTC: a half-price Black Friday subscription email (in Spanish) was kept "on second look
// (it offers a paid fee for content)" after the MyDesigns fix, because the creator-fee check matched "creator" inside
// the brand name "CreatorRates". A brand name is not a word about paying a creator.
test('a store sale from a brand whose name starts with Creator is not kept as a lead (CreatorRates, Nov 27)', async () => {
  const { maybeRealDeal } = await import('../lib/leads.js');
  const subject = 'Pro a mitad de precio hasta el domingo (tecnología en Instagram)';
  const text = 'CreatorRates Pro a mitad de precio: $119 en lugar de $239 al año. Oferta de Black Friday hasta el domingo.';
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'CreatorRates tool subscription offer at half price for Black Friday' }, { subject, text }), null);
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'newsletter_or_notice', offer: 'CreatorRates Black Friday subscription promotion' }, { subject, text }), null);
  // the plain words still count: a sale-season offer that pays a creator is kept
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Paying creators $900 for an Instagram reel during our Black Friday sale' }, { subject: 'Black Friday creator campaign', text: '' }));
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Influencer reel for our Black Friday sale, $700' }, { subject: 'Black Friday', text: '' }));
});
