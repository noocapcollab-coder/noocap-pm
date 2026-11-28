// Bug hunter, Nov 28. Emergent x Chris: Karan asked whether the December 8 go-live works; the WhatsApp ask to Harsh
// failed, and the revised script that auto-sent at 11:45 UTC said "Thanks for the update, and December 8 works for us".
// Confirming a date is Harsh's call, so an email that agrees to one in our own words never sends on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreesToDate, checkDraft, autoHoldReason } from '../lib/outbox.js';

const wrap = (s) => `Hi Karan,\n\n${s}\n\nBest,\nChris's Team`;

test('an email agreeing to a date for us is held for Harsh', () => {
  for (const line of [
    "Thanks for the update, and December 8 works for us. We'll look out for the updated brief and agreement.",
    'Dec 8th is fine on our side.',
    'We confirm the go-live date of December 8.',
    'That works for us, so we will go with Dec 8.',
    'Chris is available on the 8th.',
    'Friday works for Chris.',
  ]) {
    assert.ok(agreesToDate(line), line);
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /agrees to a date/.test(i)), line);
    assert.ok(autoHoldReason({ body: wrap(line), why: 'Revised script for "Emergent × Chris #2". Sends on its own in 30 min unless you reject it.', creator: 'Chris' }), line);
  }
});

test('dates that agree to nothing, questions and Harsh\'s templates are left alone', () => {
  for (const line of [
    "We're checking in to see if you've had a chance to review the video we shared via Frame.io on November 2.",
    'Thanks for the notes and for confirming the Nov 30 deadline.',
    'Does December 8 work for the go-live?',
    'Please find the revised script attached with your notes worked in.',
    'Here is the invoice for $1,200, due on December 28.',
  ]) assert.ok(!agreesToDate(line), line);
  assert.equal(autoHoldReason({ body: wrap("Sounds good. We'll share the live link here as soon as the video is up on December 3rd."), why: 'Fixed reply (sends on its own) [template:share_link_ack]', creator: 'Chris' }), null);
});
