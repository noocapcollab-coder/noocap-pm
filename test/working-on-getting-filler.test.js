// Test bank capcut-chris-cleared-to-post-nov16 failed at 04:17 UTC on Nov 24 with "I am currently working on getting the
// 60-day ad code to you": FILLER knew "we'll get it to you soon" but not a progress claim about something only Harsh can
// give, so checkDraft and autoHoldReason would have let it send on its own (rules 4 and 6; bug hunter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, autoHoldReason } from '../lib/outbox.js';

const wrap = (s) => `Hi Mia,\n\n${s}\n\nBest,\nChris's Team`;

test('"working on getting X to you" is a filler promise (capcut-chris-cleared-to-post-nov16, Nov 24)', () => {
  for (const line of [
    'I am currently working on getting the 60-day ad code to you.',
    "We're working on getting the ad code over to you.",
    'We are still working on sending the spark code.',
    'Chris is working on securing the code for you.',
  ]) {
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /promises to send/.test(i)), line);
    assert.match(autoHoldReason({ why: 'Fixed reply', body: wrap(line), creator: 'Chris' }) || '', /promises to send/, line);
  }
  for (const ok of ['Thanks for clearing it. The video is attached here.', 'The code works on our side.', 'Here is how the workflow works.']) {
    assert.equal(checkDraft({ body: wrap(ok) }).issues.length, 0, ok);
  }
});
