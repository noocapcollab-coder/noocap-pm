// Test bank, Nov 21 (00:27 to 04:18 UTC): capcut-brad-answer-newest-nov19 kept failing on a promised date or timeline
// nobody gave, and capcut-chris-cleared-to-post-nov16 on a promise to share the ad code later (rules 4 and 6). FILLER
// needed a month name for a date, a modal for a weekday or week timeline, and only caught get/send/share with
// soon/today/later, so "we are aiming to publish on the 25th", "expect the video early next week" and "we will share the
// ad code once it is ready" passed checkDraft and autoHoldReason and could have sent on their own. Bug hunter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, hasUngivenFiller } from '../lib/outbox.js';

const wrap = (s) => `Hi Alisa,\n\n${s}\n\nBest,\nBrad's Team`;
const flagged = (s) => checkDraft({ body: wrap(s) }).issues.some((i) => /promises to send something later/.test(i));

test('an ordinal date, "expect ... next week" and "share it once it is ready" are filler promises', () => {
  for (const line of [
    'We are aiming to publish on the 25th.',
    'Brad plans to have it live by the 27th.',
    'Expect the video early next week.',
    'You can expect the first cut by Friday.',
    'We will share the ad code once it is ready.',
    "We'll send the final cut as soon as the edit is done.",
  ]) assert.ok(flagged(line), line);
});

test('questions, plain facts and a date Harsh gave stay allowed', () => {
  for (const line of [
    'Could you confirm the 25th works for you?',
    'The video went live on the 20th.',
    'Thanks for the brief, it is clear.',
    "We'll share the ad code with you below: AB12.",
  ]) assert.ok(!flagged(line), line);
  assert.equal(hasUngivenFiller(wrap('We are aiming to publish on the 25th.'), 'Harsh: publish on the 25th'), false);
});
