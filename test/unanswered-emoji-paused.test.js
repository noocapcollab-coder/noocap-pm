// Night check Nov 26: a bare emoji needs no reply (Luma AI x Lindsay)
import test from 'node:test';
import assert from 'node:assert/strict';
import { noReplyNeeded } from '../lib/unanswered.js';

test('a bare thumbs-up, with or without a signature, needs no reply', () => {
  assert.ok(noReplyNeeded('👍'));
  assert.ok(noReplyNeeded('👍\n\nBest,\n\nUpendra Singh\nCampaign Head | NJ Agency'));
  assert.ok(!noReplyNeeded('Thanks! Can you share the link?'));
  assert.ok(!noReplyNeeded('Please wait for a little while. The team is reviewing the video.'));
});
