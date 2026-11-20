// Lesson "Don't send 'ignore this' emails unless the error is critical" (Draft rejected, Nov 19) had no code guard.
// A draft asking the brand to ignore or disregard our earlier email is marked Needs you and never sends on its own.
// Bug hunter, Nov 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, autoHoldReason } from '../lib/outbox.js';

const wrap = (s) => `Hi Mia,\n\n${s}\n\nBest,\nChris's Team`;

test('"please ignore our last email" holds the draft for Harsh', () => {
  for (const line of [
    'Please ignore our last email, it was sent by mistake.',
    'Kindly disregard the previous email.',
    'Please disregard my earlier message about the invoice.',
    'You can ignore that email, the link below is the right one.',
  ]) {
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /ignore or disregard/.test(i)), line);
    assert.ok(autoHoldReason({ body: wrap(line), why: 'Follow-up 1 of 3', creator: 'Chris' }), line);
  }
});

test('ordinary emails that mention ignoring nothing of ours stay allowed', () => {
  for (const line of [
    'Here is the revised cut with the music changed: https://f.io/abc',
    'Thanks for your email, the script is attached.',
    'Feel free to ignore the watermark, it is only on the preview.',
  ]) assert.equal(checkDraft({ body: wrap(line) }).issues.length, 0, line);
});
