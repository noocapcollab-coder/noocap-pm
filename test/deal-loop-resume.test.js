// Nov 19 (bug hunter): every heartbeat for 5 hours ran out of time in the deal loop ("rest of the deal emails"). The
// start only jumped half the list every 10 minutes, so deals beyond one run's reach could wait hours. Each run now
// records where it stopped and the next run starts there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dealLoopStart } from '../lib/heartbeat.js';

const deals = ['Polar', 'CapCut', 'Runway', 'Dreamina', 'Zeely'].map((brand, i) => ({ brand, creator: i % 2 ? 'Chris' : 'Valeri' }));

test('the deal loop starts at the deal the last heartbeat stopped before', () => {
  const prev = '✓ Read brand deals · 400ms\n✓ Deal emails (2 of 5 deals, next: Dreamina × Chris) · 110000ms\n✓ Invoices · 20000ms';
  assert.equal(dealLoopStart(deals, prev, 0), 3);
});

test('without a stop mark (or for a deal that is gone) it falls back to the half-list rotation', () => {
  assert.equal(dealLoopStart(deals, '✓ Deal emails (5 deals) · 9000ms', 6e5), 3);
  assert.equal(dealLoopStart(deals, '✓ Deal emails (2 of 5 deals, next: Gone × Brad) · 110000ms', 0), 0);
  assert.equal(dealLoopStart([], 'x', 0), 0);
});
