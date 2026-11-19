// Test bank capcut-chris-publish-asap-nov19 (Nov 19): Mia chased the posting we had promised for "today". The writer
// kept answering "we will post it today" or "we are putting the finishing touches on the post", which FILLER missed
// (it only knew get/send/share ... today), so such a reply would have sent on its own with a dateless promise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, needsFillerRewrite, dropFillerSentences } from '../lib/outbox.js';

const wrap = (s) => `Hi Mia,\n\n${s}\n\nBest,\nChris's Team`;

test('"we will post it today" and "finishing touches" are filler promises (capcut-chris-publish-asap-nov19)', () => {
  for (const line of [
    'We will post it today and share the live link here.',
    "We'll publish the reel later today.",
    'We are putting the finishing touches on the post and we will share the live link here.',
    "We're finalizing the video now.",
    'I will upload it tomorrow.',
  ]) {
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /promises to send/.test(i)), line);
    assert.equal(needsFillerRewrite(wrap(line)), true, line);
  }
});

test('a plain statement or a brand asking for today is not our filler', () => {
  assert.equal(checkDraft({ body: wrap('Thanks Mia. The video went live on Instagram, here is the link: https://instagram.com/p/abc') }).issues.length, 0);
  assert.equal(checkDraft({ body: wrap('Thanks for letting us know your client wants it posted today. It is attached for one last look.') }).issues.length, 0);
});

test('dropFillerSentences removes the dateless posting promise and keeps the rest', () => {
  const body = wrap('Thanks for your patience on this one, we know the client has been waiting for a while now. We will post it today. The live link will be shared in this thread with the ad code once it is up on Chris\'s Instagram account.');
  const out = dropFillerSentences(body);
  assert.ok(!/post it today/.test(out));
  assert.ok(/Thanks for your patience/.test(out));
});
