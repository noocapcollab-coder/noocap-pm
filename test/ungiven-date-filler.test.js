// Test bank capcut-brad-answer-newest-nov19 failed every run on Nov 19 (20:16 to 23:36 UTC) with replies that gave
// Alisa a calendar date nobody gave us ("November 23 to 27", a publication date): FILLER only knew vague timing words,
// so a made-up date passed checkDraft and dropFillerSentences. A date ask is Harsh's to answer on WhatsApp (lesson
// "Answer the brand's newest email, to the person who wrote it"). A date Harsh gave (in facts) stays. Bug hunter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, dropFillerSentences, hasUngivenFiller } from '../lib/outbox.js';

const wrap = (s) => `Hi Alisa,\n\nThanks for checking in on Brad's CapCut video and for the extra details on the brief. ${s}\n\nBest,\nBrad's Team`;

test('a calendar date we promise is a filler promise', () => {
  for (const line of [
    'We can have the video produced between November 23 and 27.',
    'Brad will publish it on November 25th.',
    'The video should be live by 27 November.',
    'Our earliest timeline is November 23 to 27.',
    'We expect to deliver the draft by Nov 24.',
  ]) {
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /promises to send/.test(i)), line);
    assert.ok(!/(Nov|November)/.test(dropFillerSentences(wrap(line)).replace(/Brad's CapCut video/, '')), line);
  }
});

test("the brand's own date and a date Harsh gave stay", () => {
  assert.equal(checkDraft({ body: wrap('Thanks for letting us know the brand would like it live by November 25.') }).issues.length, 0);
  assert.equal(hasUngivenFiller(wrap('Brad will publish it on November 25.'), '{"go_live":"November 25"}'), false);
});
