// Nov 21 (bug hunter): the hourly jobs at the end of the heartbeat (Brand pool, the "Updates, nothing needed from you"
// digest, the unsigned-contract alert, the WhatsApp re-open template, the 11:30 IST raw-folder opener) were gated on
// "minute < 10". That is the :04 tick, which also runs the 30-minute work, so Invoices took 75 to 95 s and the tick was
// always past its budget before reaching them: Queued FYI rows sat unsent from Nov 9 to Nov 21.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { every15Tick, hourlyTailTick } from '../lib/heartbeat.js';
import { splitStaleFyi } from '../lib/briefs.js';

test('the hourly tail slot hits exactly one tick an hour and never a 30-minute tick, for any 10-minute cadence', () => {
  for (let offset = 0; offset < 10; offset++) {
    const ticks = [0, 1, 2, 3, 4, 5].map((k) => offset + 10 * k);
    const hits = ticks.filter(hourlyTailTick);
    assert.equal(hits.length, 1, `offset ${offset}`);
    assert.equal(every15Tick(hits[0]), false, `offset ${offset}: hourly tick ${hits[0]} is also a 30-minute tick`);
  }
  // the live cadence (:04, :14, ...): the 30-minute work is on :04 and :34, the hourly tail on :14
  assert.deepEqual([4, 14, 24, 34, 44, 54].filter(every15Tick), [4, 34]);
  assert.deepEqual([4, 14, 24, 34, 44, 54].filter(hourlyTailTick), [14]);
});

test('no job after the Invoices step is gated on the "minute < 10" slot any more', () => {
  const src = readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  const tail = src.slice(src.indexOf("mark('Invoices');"));
  assert.ok(tail.length > 1000);
  assert.equal(/getUTCMinutes\(\)\s*<\s*10/.test(tail), false);
  for (const job of ['syncBrandPool', 'flushFyi', 'staleContractAlerts', 'ensureTemplate', 'openRawFolders']) {
    const at = tail.indexOf(job);
    assert.ok(at > 0, job);
    assert.match(tail.slice(Math.max(0, at - 260), at), /hourlyTailTick/, `${job} runs in the hourly tail slot`);
  }
});

test('queued updates older than a day are retired instead of posted as a backlog', () => {
  const now = Date.parse('2026-11-21T01:00:00Z');
  const rows = [{ id: 'a', created_time: '2026-11-09T14:07:00Z' }, { id: 'b', created_time: '2026-11-20T15:37:00Z' }, { id: 'c', created_time: '2026-11-21T00:30:00Z' }];
  const { fresh, stale } = splitStaleFyi(rows, now);
  assert.deepEqual(fresh.map((r) => r.id), ['b', 'c']);
  assert.deepEqual(stale.map((r) => r.id), ['a']);
});
