import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUngivenFiller } from '../lib/outbox.js';

// capcut-brad-answer-newest-nov19 failed at 21:43 UTC on Nov 21 with "Yes, we can produce the video within this
// timeframe": Alisa asked whether the video can be made this week or next, and agreeing to HER window is a timeline
// Harsh never gave (lesson "Answer the brand's newest email": a date ask goes to Harsh on WhatsApp). The guard only knew
// our own time words, so "within this timeframe" and "meet your deadline" passed.
test('agreeing to the brand\'s timeframe or deadline is filler', () => {
  for (const s of [
    'Yes, we can produce the video within this timeframe using the original brief and script.',
    'We can deliver it within that time frame.',
    'Brad will be able to have the video ready within your timeline.',
    'We can meet this deadline.',
    "We'll make sure we hit your timeline.",
    'Yes, that timeline works for us.',
    'This timeframe works for Brad.',
    'The video can be ready within this window.',
  ]) assert.ok(hasUngivenFiller(s), s);
});

test('timeline questions and plain mentions are not filler', () => {
  for (const s of [
    'Could you share the timeline for the campaign?',
    'What timeframe do you have in mind?',
    'Thanks for sharing the timeline.',
    'We have noted your deadline and will come back to you with a date.',
  ]) assert.ok(!hasUngivenFiller(s), s);
});

test('a timeframe Harsh gave in the facts is kept', () => {
  assert.ok(!hasUngivenFiller('Yes, Brad can film it within this timeframe.', '{"harsh":"yes brad can do it within this timeframe"}'));
});
