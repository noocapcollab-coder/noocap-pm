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

test('a system auto-rejection stops blocking new drafts after a day', async () => {
  const { autoRejected, AUTO_REJECT_COOLDOWN_H } = await import('../lib/outbox.js');
  assert.equal(AUTO_REJECT_COOLDOWN_H, 24);
  assert.ok(autoRejected({ properties: { Error: { rich_text: [{ plain_text: 'Auto-rejected by system check: drafted 2.4 days after...' }] } } }));
  assert.ok(!autoRejected({ properties: { Error: { rich_text: [] } } }));
});

import { changesAfterCut } from '../lib/heartbeat.js';
test('a row left on Changes from an older round does not stop the chase after a newer cut (ZenBusiness, Nov 16)', () => {
  const rows = [{ status: 'Changes', changesAt: '2026-11-02T20:57:00.000Z' }, { status: 'Send to Brand', changesAt: null }];
  assert.equal(changesAfterCut(rows, '2026-11-09T05:37:00.000Z'), false);
  assert.equal(changesAfterCut([{ status: 'Changes', changesAt: '2026-11-10T09:00:00.000Z' }], '2026-11-09T05:37:00.000Z'), true);
});

import { latestChangeRound } from '../lib/brandsend.js';
test('round 2 of brand changes counts from its own time, not round 1 (Dreamina × Chris, Nov 16)', () => {
  assert.equal(latestChangeRound({ changesAt: '2026-11-14T09:18:00.000Z', brandChangesAt: '2026-11-15T11:00:00.000Z' }), '2026-11-15T11:00:00.000Z');
  assert.equal(latestChangeRound({ changesAt: '2026-11-14T09:18:00.000Z' }), '2026-11-14T09:18:00.000Z');
});
