// Test bank capcut-chris-cleared-to-post-nov16 failed again at 20:16 UTC on Nov 19: the reply promised to post
// "promptly", which FILLER did not know, so checkDraft and autoHoldReason would have let it send on its own (rule 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, autoHoldReason } from '../lib/outbox.js';

const wrap = (s) => `Hi Mia,\n\n${s}\n\nBest,\nChris's Team`;

test('"promptly" and "without delay" are filler promises (capcut-chris-cleared-to-post-nov16, Nov 19)', () => {
  for (const line of ['Thanks for clearing it, we will publish the video promptly.', 'We will get it live without delay.']) {
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /promises to send/.test(i)), line);
    assert.match(autoHoldReason({ why: 'Fixed reply', body: wrap(line), creator: 'Chris' }) || '', /promises to send/, line);
  }
  assert.equal(checkDraft({ body: wrap('Thanks for clearing it. The video is attached here.') }).issues.length, 0);
});
