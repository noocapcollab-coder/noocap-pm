// Bug hunter, Nov 26: CapCut x Chris BD-67 (3 videos for $3,000). Posted Links held video 1 on Instagram, the same
// video 1 on Facebook and video 2 on Instagram; the three links were read as three videos live, so videosStillOwed said
// nothing was owed and a $3,000 final invoice email was drafted while video 3 was still at script stage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partDue, videosStillOwed, postedVideoCount } from '../lib/invoicing.js';

const capcut = {
  stage: 'Posted',
  deliverables: '3 short-form videos (signed contract, GrowMaxValue agency)',
  postedLinks: 'Instagram: https://www.instagram.com/reel/Df6p-3CQCF2/<br />Facebook: https://www.facebook.com/share/r/1CE9oUf1NL/<br />https://www.instagram.com/reel/DgGIoDVTxXe/?utm_source=ig_web_copy_link&hvrq=MzRlODBiNWFlZA==',
  memory: 'BILLING: Brand provided company info and tax forms on 2026-11-25. Invoice status: not yet.<br /><br />OPEN NOW: We owe: Complete tax forms, boost engagement on the first video, and edit the published video post to move promo text to a pinned comment. Waiting on brand: Review of the third script.',
};

test('a Facebook cross-post of the same reel is not another video (CapCut x Chris, Nov 26)', () => {
  assert.equal(postedVideoCount(capcut.postedLinks), 2);
  assert.equal(videosStillOwed(capcut), true);
  assert.equal(partDue(capcut, 'final', ''), false);
});

test('all videos live on one platform still makes the final invoice due', () => {
  const done = { ...capcut, postedLinks: capcut.postedLinks + ' https://www.instagram.com/reel/C3third/ https://www.facebook.com/share/r/XYZ/' };
  assert.equal(postedVideoCount(done.postedLinks), 3);
  assert.equal(videosStillOwed(done), false);
  assert.equal(partDue(done, 'final', ''), true);
});

test('the same reel pasted twice (with and without tracking) counts once', () => {
  assert.equal(postedVideoCount('https://www.instagram.com/reel/A1/ https://www.instagram.com/reel/A1/?utm_source=x'), 1);
  assert.equal(postedVideoCount(''), 0);
});
