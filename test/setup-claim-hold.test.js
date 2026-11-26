// Rule 86 / PM LESSONS "A reply never says something is already set up or done unless someone on our side said so"
// (Manyfast x Duncan, Nov 26, afternoon check): the hourly reply check drafted "We have the comment DM automation set
// up" though nobody had confirmed it. The lesson had no code guard; bug hunter, Nov 26.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, autoHoldReason, claimsSetupDone } from '../lib/outbox.js';

const wrap = (s) => `Hi Seungjoo,\n\n${s}\n\nBest,\nDuncan's Team`;

test('the Manyfast draft that claimed the DM automation was set up is held for Harsh', () => {
  const body = wrap('Thanks for approving the cut. We have the comment DM automation set up, so everyone who comments PLAN gets the DUNCAN30 code.');
  assert.ok(checkDraft({ body, creator: 'Duncan' }).issues.some((i) => /already set up/.test(i)));
  assert.match(autoHoldReason({ body, creator: 'Duncan', why: 'Unanswered brand email' }), /already set up/);
});

test('done-claims about setup, uploads and access are caught', () => {
  for (const s of [
    'We have the comment DM automation set up.',
    "We've uploaded the final file to the shared folder.",
    'The automation is already set up and working.',
    'Access is working on our side now.',
    "Duncan has connected the account.",
    'Everything is set up for launch.',
  ]) assert.equal(claimsSetupDone(wrap(s)), true, s);
});

test('future steps, conditions and questions are left alone', () => {
  for (const s of [
    "We'll have the comment flow set up so everyone who comments PLAN gets the code.",
    'We will share the link here once it is set up.',
    'Could you confirm the automation is set up on your side?',
    'Please let us know when access is working.',
    'The team is working on the revised cut.',
    'Final V4 (33 seconds) is the version for release.',
    "We've passed your notes to our editor and you'll have the revised cut within 1 to 2 working days.",
  ]) assert.equal(claimsSetupDone(wrap(s)), false, s);
});

test('a fixed reply template is never held for this', () => {
  const body = wrap('Everything is set up for launch.');
  assert.equal(autoHoldReason({ body, creator: 'Duncan', why: 'Fixed reply [template:video_changes_ack]' }), null);
});
