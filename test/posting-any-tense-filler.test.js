import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUngivenFiller } from '../lib/outbox.js';

// capcut-chris-publish-asap-nov19 failed again at 19:30 UTC on Nov 21: a promise to post "right away" in a tense the
// guard did not know. Any tense of our own posting with an immediate timing word is the same dateless promise.
test('any tense of an immediate posting promise is filler', () => {
  for (const s of [
    'We are publishing the video immediately.',
    "We're posting it straight away.",
    'Chris is posting it ASAP.',
    "We're getting it posted as we speak.",
    'We are prioritizing the post and it will be live very soon.',
    'Chris will publish it at the earliest.',
    'The video will be live in a few hours.',
    'Chris will post the video as soon as he can.',
  ]) assert.ok(hasUngivenFiller(s), s);
});

test('plain statements and questions about posting are not filler', () => {
  for (const s of [
    'We will share the live link here.',
    'It is up to you whether we post on Monday.',
    'The video is live now: https://x.com/1',
    'Chris is happy to post it soon after your approval?',
    'We are up for it.',
  ]) assert.ok(!hasUngivenFiller(s), s);
});
