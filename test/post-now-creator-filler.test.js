// Test bank capcut-chris-publish-asap-nov19 still failed on Nov 20 (18:46 and 19:56 UTC) with replies that promised to
// post "now" or "today" without a time from Harsh. FILLER only caught "we're posting ... right now" and "we will post ...
// today", so "we will post it now", "Chris will post it today" and "we are going ahead and posting it now" passed
// checkDraft and autoHoldReason and could have sent on their own (rules 4 and 6). Bug hunter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, dropFillerSentences } from '../lib/outbox.js';

const wrap = (s) => `Hi Mia,\n\n${s}\n\nBest,\nChris's Team`;

test('"post it now" and the creator posting today are filler promises (capcut-chris-publish-asap-nov19)', () => {
  for (const line of [
    'We will post it now.',
    "We'll get it posted now and share the link.",
    'Chris will post it today.',
    'Chris is posting the video now.',
    'We are going ahead and posting it now.',
    "We're getting it live now and will send you the link.",
    'The video is going live tonight.',
    'The reel will go live tomorrow.',
  ]) assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /promises to send/.test(i)), line);
});

test('facts about a live post and questions stay allowed', () => {
  for (const line of [
    'The video is live now on Instagram: https://instagram.com/p/abc',
    'We posted it today, here is the link: https://instagram.com/p/abc',
    'Chris posted the reel today: https://instagram.com/p/abc',
    'Would you like us to post it now?',
    'Now that the cut is approved, thank you for the quick review.',
  ]) assert.equal(checkDraft({ body: wrap(line) }).issues.length, 0, line);
});

test('a posting time Harsh gave is kept, an ungiven one is dropped', () => {
  const body = wrap('Thanks for the approval, Mia, we really appreciate the quick turnaround on this one. Chris will post it today.');
  assert.ok(!/post it today/.test(dropFillerSentences(body)));
  assert.ok(/post it today/.test(dropFillerSentences(body, 'post it today at 5pm EST')));
});
