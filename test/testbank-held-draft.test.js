import test from 'node:test';
import assert from 'node:assert/strict';
import { heldByGuards } from '../lib/testbank.js';

// System check, Nov 22: capcut-chris-publish-asap-nov19 counted as BROKEN though the filler guard would hold the draft
test('a writer draft the outbox guards would hold counts as held, not as a repeated mistake', () => {
  assert.ok(heldByGuards("Hi Mia,\n\nWe are getting the video posted right now.\n\nBest,\nChris's Team", 'Chris').length > 0);
  assert.ok(heldByGuards("Hi Alisa,\n\nWe can produce and publish the video within that timeline.\n\nBest,\nBrad's Team", 'Brad').length > 0);
});

test('a clean draft is not held, so the judge still checks it', () => {
  assert.deepEqual(heldByGuards("Hi Jenny,\n\nWe have updated the hashtags as requested.\n\nBest,\nChris's Team", 'Chris'), []);
});
