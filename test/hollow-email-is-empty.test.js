// Bug hunter Nov 25: test bank panda-chris-content-when-tool-access-nov18 regressed at 04:56 UTC with the draft
// "Hi Camila, Thanks for reaching out and checking in. Best, Chris's Team" to a brand asking when the content comes.
// writeEmail's emptyBody only caught a bare greeting and sign-off, so a thanks-only email could still be saved and sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBody } from '../lib/outbox.js';

test('a thanks-only email counts as empty (panda-chris-content-when-tool-access-nov18)', () => {
  assert.equal(emptyBody("Hi Camila,\n\nThanks for reaching out and checking in.\n\nBest,\nChris's Team"), true);
  assert.equal(emptyBody("Hi Upendra,\n\nThat is great news that the script is approved. We look forward to working with you.\n\nBest,\nLindsay's Team"), true);
  assert.equal(emptyBody("Hi Konan,\n\nThank you so much for the update!\n\nBest,\nDuncan's Team"), true);
});

test('an email that says something is never empty', () => {
  assert.equal(emptyBody("Hi Camila,\n\nThanks for checking in. The first cut is in edit and comes to you for approval as soon as it is done.\n\nBest,\nChris's Team"), false);
  assert.equal(emptyBody("Hi Upendra,\n\nGreat news, the script is attached for your review.\n\nBest,\nLindsay's Team"), false);
  assert.equal(emptyBody("Hi Alisa,\n\nThanks for approving the script. Could you give access to CapCut on noocaptools@gmail.com?\n\nBest,\nChris's Team"), false);
  assert.equal(emptyBody("Hi Upendra,\n\nPlease find the script attached.\n\nBest,\nLindsay's Team"), false);
  assert.equal(emptyBody("Hi Upendra,\n\nBest,\nLindsay's Team"), true);
});
