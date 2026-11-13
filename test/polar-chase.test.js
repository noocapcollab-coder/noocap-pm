// Polar x Valeri (Nov 14): the revised cut of video 2 went to Ushni by hand on Nov 10 and the deal sat at Posted
// (video 1 was live), so it was never chased. The memory line must count as a cut waiting on the brand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutAwaitsBrand } from '../lib/heartbeat.js';

test('"final OK on the revised cut" is a cut waiting on the brand', () => {
  assert.ok(cutAwaitsBrand("HISTORY: ...\n\nOPEN NOW: We owe: Valeri's billing details to Ushni (needs Harsh). Waiting on brand: final OK on the revised cut, then post video 2 (POST DATE 2026-11-17)."));
  assert.ok(cutAwaitsBrand('OPEN NOW: Waiting on brand: approval of the video.'));
  assert.ok(!cutAwaitsBrand('OPEN NOW: Waiting on brand: billing details.'));
  assert.ok(!cutAwaitsBrand('OPEN NOW: Nothing open.'));
});
