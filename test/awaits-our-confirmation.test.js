// Bug hunter Nov 25: test bank case emergent-chris-brief-not-contract-nov19 failed twice in the 00:47 UTC gate run.
// Karan's "Once you confirm the intent to go live on 23rd Nov, I will share the formal agreement" was read as a brief
// with no needs_our_info, so the go-live confirmation only Harsh can give would never reach him (rule 70).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextGuards, awaitsOurConfirmation } from '../lib/inbox.js';

const karan = "Please read the previous email carefully. The attached document is the\ncampaign brief to help align with Chris's intent, not the final contract.\nOnce you confirm the intent to go live on 23rd Nov, I will share the formal\nagreement for signature.\n\nBest regards,\nKaran Varyani";

test('a brand waiting on our go-live confirmation needs our info (emergent-chris-brief-not-contract-nov19)', () => {
  const x = applyTextGuards({ from_role: 'brand', event: 'brief', needs_reply: false, needs_our_info: false }, { text: karan });
  assert.equal(x.needs_our_info, true);
  assert.equal(x.needs_reply, true);
  assert.match(x.info_needed, /go live on 23rd Nov/);
  assert.notEqual(x.event, 'script_approved');
});

test('confirmation asks are told apart from the brand confirming things itself', () => {
  assert.ok(awaitsOurConfirmation('Could you confirm the posting date for the reel?'));
  assert.ok(awaitsOurConfirmation('Please confirm if Chris is available on Dec 3.'));
  assert.ok(awaitsOurConfirmation('As soon as you confirm the go-live date we will send the contract.'));
  assert.equal(awaitsOurConfirmation('We confirm the go-live date of Nov 23.'), '');
  assert.equal(awaitsOurConfirmation('Please confirm receipt of the brief by Friday.'), '');
  assert.equal(awaitsOurConfirmation('Thanks, the video looks great!'), '');
  assert.equal(awaitsOurConfirmation('Please confirm you got the files.'), '');
});

test('the creator side confirming is left alone', () => {
  const x = applyTextGuards({ from_role: 'creator', event: 'brand_reply', needs_our_info: false }, { text: 'Can you confirm the go-live date with the client?' });
  assert.equal(x.needs_our_info, false);
});
