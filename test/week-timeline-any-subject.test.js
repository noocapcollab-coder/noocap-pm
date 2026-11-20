// Night system check, Nov 20: test bank capcut-brad-answer-newest-nov19 regressed again after 911525a with a draft that
// promised "ready within the next week". FILLER only caught week timelines after "we / Brad / ..." as the subject, so
// "The video will be ready within the next week" or "It can be produced within this week" passed and the reply made a
// date promise Harsh never gave (rule 4, rule 6). Any subject now counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsFillerRewrite, dropFillerSentences, checkDraft } from '../lib/outbox.js';

const wrap = (s) => `Hi there,\n\n${s}\n\nBest,\nBrad's Team`;

test('week and weekday timelines with any subject are filler', () => {
  for (const line of [
    'The video will be ready within the next week.',
    'It should be ready within the next week.',
    'The video can be produced within this week.',
    'Yes, the video can be produced within this week or the next.',
    'We expect the video to be ready by the end of next week.',
    'We can get it to you within the next two weeks.',
    'We are aiming to have it ready by next week.',
    'Brad will film it on Monday.',
  ]) assert.equal(needsFillerRewrite(wrap(line)), true, line);
});

test('the brand\'s own timing, questions and plain facts stay allowed', () => {
  for (const line of [
    'Thanks Alisa, we understand the brand would like it this week.',
    'Thanks for letting us know you need it within this week or the next.',
    'Could you confirm whether the brand needs it this week?',
    'We posted it today, here is the link: https://instagram.com/p/abc',
  ]) assert.equal(checkDraft({ body: wrap(line) }).issues.length, 0, line);
});

test('a week timeline Harsh gave in the facts is kept, an ungiven one is dropped', () => {
  const body = wrap('Thanks for checking in, Alisa, and for your patience on this one. The video will be ready within the next week.');
  assert.ok(/within the next week/.test(dropFillerSentences(body, JSON.stringify({ we_provide: 'The video will be ready within the next week' }))));
  assert.ok(!/within the next week/.test(dropFillerSentences(body, '{}')));
});
