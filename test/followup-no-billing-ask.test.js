// Polar x Valeri, Nov 21: follow-up 3 on the revised cut also asked Ushni for company billing details, though three
// billing reminders had gone, Polar pays via Gusto and she had asked for OUR details (night system check). A
// follow-up chases only what it is about; the billing ask is taken out.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PAYMENT_KEYS_SECRET ||= 'test-secret-for-the-safety-checks-only-0123456789';
const { dropBillingAsk, BILLING_ASK } = await import('../lib/outbox.js');

test('a cut follow-up loses its billing-details ask but keeps the cut chase', () => {
  const bad = "Hi Ushni,\n\nFollowing up to see if you've had a chance to look at the revised video and share the company billing details so we can get everything finalized.\n\nBest,\nValeri's Team";
  const out = dropBillingAsk(bad);
  assert.ok(!BILLING_ASK.test(out), out);
  assert.match(out, /look at the revised video/);
  assert.match(out, /Valeri's Team/);
});

test('a separate billing sentence is dropped whole', () => {
  const bad = 'Hi Ushni,\n\nAny feedback on the revised cut?\n\nAdditionally, we are still awaiting the company name, billing address, and billing email.\n\nBest,\nValeri\'s Team';
  const out = dropBillingAsk(bad);
  assert.ok(!/billing|company name/i.test(out), out);
  assert.match(out, /revised cut\?/);
});

test('a follow-up with no billing ask is untouched', () => {
  const ok = 'Hi Mia,\n\nJust checking in on the script we sent.\n\nBest,\nChris\'s Team';
  assert.equal(dropBillingAsk(ok), ok);
});
