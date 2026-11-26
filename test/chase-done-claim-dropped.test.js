// Bug hunter, Nov 26: the auto-sent payment chase to Delton (ChatGPT x Duncan, 19:25 UTC, PM OUTBOX
// 424508e99dda810a8a92c799de30f1c8) said "We have updated the Trolley information, so when can we expect the payment
// for invoice INV-004", though our last email said we would pass the form to Duncan and the deal's Next Action still
// read "Waiting on us: Submit or update the Trolley form". Rule 86: nobody on our side said it was done.
// claimsSetupDone only knew set up / uploaded / connected, so "updated / filled out / completed / submitted the form"
// passed, and payment chases never wait for Harsh (rule 80). Now a chase drops the unproven claim and keeps the ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsSetupDone, dropDoneClaims, autoHoldReason } from '../lib/outbox.js';

const wrap = (s) => `Hi Delton,\n\n${s}\n\nBest,\nDuncan's Team`;
const DELTON = 'Thanks for sharing the link. We have updated the Trolley information, so when can we expect the payment for invoice INV-004 to come through?';

test('a claim that we updated, filled out or submitted a form or details is a done-claim', () => {
  for (const s of [
    'We have updated the Trolley information.',
    "We've filled out the Vendor Form.",
    'Duncan has completed the Trolley setup.',
    'We have submitted the vendor form and the W-9.',
    'The Trolley details have been updated.',
  ]) assert.equal(claimsSetupDone(wrap(s)), true, s);
  for (const s of [
    "We'll update the Trolley information today.",
    'Could you confirm the form was received?',
    'Once Duncan has updated the Trolley details, we will let you know.',
    'We have updated the caption as you asked.',
  ]) assert.equal(claimsSetupDone(wrap(s)), false, s);
});

test('the Delton chase loses the made-up Trolley claim and keeps the payment question', () => {
  const out = dropDoneClaims(wrap(DELTON));
  assert.equal(claimsSetupDone(out), false);
  assert.match(out, /When can we expect the payment for invoice INV-004 to come through\?/);
  assert.doesNotMatch(out, /updated the Trolley/);
  assert.match(out, /^Hi Delton,/);
  assert.match(out, /Duncan's Team$/);
  assert.equal(autoHoldReason({ body: out, creator: 'Duncan', why: 'Invoice sent 22 days ago, no payment yet' }), null);
});

test('a whole sentence that is only a claim is removed, an email without one is unchanged', () => {
  const out = dropDoneClaims(wrap('We have filled out the Vendor Form. Could you let us know when the payment for INV-004 will be processed?'));
  assert.doesNotMatch(out, /Vendor Form/);
  assert.match(out, /Could you let us know when the payment for INV-004 will be processed\?/);
  const clean = wrap('I wanted to check in on invoice INV-004 for $1,800. When can we expect the payment to come through?');
  assert.equal(dropDoneClaims(clean), clean);
});
