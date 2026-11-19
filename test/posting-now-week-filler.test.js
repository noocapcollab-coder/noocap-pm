// Test bank, Nov 19 after c2332e8: capcut-chris-publish-asap-nov19 kept failing with "we are getting the video posted
// right now" (11:07 UTC) and "we are posting it today" (11:47, 12:27 UTC), and capcut-brad-answer-newest-nov19 with
// "we can produce it within this week" (Alisa asked for the earliest timeline, which is Harsh's date to give).
// FILLER only knew "we will/we'll <verb> ... today", so the present tense and "this week / next week" passed checkDraft
// and autoHoldReason and could have sent on their own (rule 4 and rule 6). Bug hunter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, needsFillerRewrite, dropFillerSentences } from '../lib/outbox.js';

const wrap = (s) => `Hi there,\n\n${s}\n\nBest,\nBrad's Team`;

test('present-tense posting promises and week timelines are filler (capcut-chris-publish-asap / capcut-brad-answer-newest)', () => {
  for (const line of [
    'We are getting the video posted right now.',
    "We're posting it today and will share the live link here.",
    'We are publishing the reel tonight.',
    "I'm uploading it later today.",
    'We can produce the video within this week.',
    'Brad can have it ready by next week.',
    'We should be able to deliver it this week or the next.',
    "We'll have it filmed by Friday.",
    'We will get it done by the end of the week.',
  ]) {
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /promises to send/.test(i)), line);
    assert.equal(needsFillerRewrite(wrap(line)), true, line);
  }
});

test('the brand\'s own timing and plain facts stay allowed', () => {
  for (const line of [
    'Thanks Alisa, we understand the brand would like it this week.',
    'Thanks for letting us know you need it within this week or the next.',
    'The video is live now on Instagram: https://instagram.com/p/abc',
    'We posted it today, here is the link: https://instagram.com/p/abc',
  ]) assert.equal(checkDraft({ body: wrap(line) }).issues.length, 0, line);
});

test('dropFillerSentences takes the week promise out and keeps the rest', () => {
  const out = dropFillerSentences(wrap('Thanks for checking in, Alisa, and for your patience while the brand waits on this one. We can produce the video within this week.'));
  assert.ok(!/within this week/.test(out));
  assert.ok(/Thanks for checking in/.test(out));
});

test('a timing line that comes from Harsh\'s own answer in the facts is kept', () => {
  const body = wrap('Thanks for checking in, Alisa, and for your patience on this one. Brad can film it within this week.');
  const given = JSON.stringify({ we_provide: 'Brad can film it within this week' });
  assert.ok(/within this week/.test(dropFillerSentences(body, given)));
  assert.ok(!/within this week/.test(dropFillerSentences(body, '{}')));
});

test('hasUngivenFiller only counts timing the facts did not give', async () => {
  const { hasUngivenFiller } = await import('../lib/outbox.js');
  const body = wrap('Brad can film it within this week.');
  assert.equal(hasUngivenFiller(body, 'Brad can film it within this week'), false);
  assert.equal(hasUngivenFiller(body, ''), true);
});
