// Test bank capcut-chris-cleared-to-post-nov16 failed at 18:26 UTC on Nov 25 with "We have published the video as
// requested and we will share the live link here." Nothing caught a claim that the video is already out while no live
// link exists (the brand only said "please publish it"; the post date is Harsh's call), and the NO_FILLER rewrite did
// not forbid it. Bug hunter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, autoHoldReason, claimsUnprovenPost, NO_FILLER } from '../lib/outbox.js';
import { heldByGuards } from '../lib/testbank.js';

const wrap = (s) => `Hi Mia,\n\n${s}\n\nBest,\nChris's Team`;

test('"published + we will share the live link here" is held (capcut-chris-cleared-to-post-nov16, Nov 25)', () => {
  const body = wrap('We have published the video as requested and we will share the live link here.');
  assert.ok(heldByGuards(body, 'Chris').some((i) => /already published or live/.test(i)));
  assert.ok(autoHoldReason({ body, creator: 'Chris' }));
  assert.ok(checkDraft({ body: wrap('Great news, the reel has been posted.') }).issues.some((i) => /already published or live/.test(i)));
});

test('the NO_FILLER rewrite forbids saying the video is out without its link', () => {
  assert.match(NO_FILLER, /Never say the video is already published, posted or live unless Facts gives its live link/);
});

test('a "video is live" claim needs a live link or a Posted deal', () => {
  assert.equal(claimsUnprovenPost(wrap('The video is now live and performing well.')), true);
  assert.equal(claimsUnprovenPost(wrap('The video is now live: https://www.instagram.com/reel/abc123/')), false);
  assert.equal(claimsUnprovenPost(wrap('We have posted the video.'), '{"stage":"Posted"}'), false);
  assert.equal(claimsUnprovenPost(wrap('Has the video been approved?')), false);
  assert.equal(claimsUnprovenPost(wrap('Thanks for approving the cut, we will hold until the agreed date.')), false);
});
