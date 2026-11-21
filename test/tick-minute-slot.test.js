// Nov 21 (bug hunter): 0f85a31 moved the hourly tail jobs to hourlyTailTick (the :14 tick), but each job read the clock
// when it was reached. The :14 tick spends ~107 s on deal emails and ~22 s on Invoices first, so the jobs saw minute 16,
// hourlyTailTick was false and Brand pool, the "Updates, nothing needed from you" digest, the unsigned-contract alert and
// the WhatsApp template check still never ran (9 Queued FYI rows, none sent or expired, Nov 20 00:05 to Nov 21 04:47).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hourlyTailTick } from '../lib/heartbeat.js';

const src = readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
const run = src.slice(src.indexOf('export async function runHeartbeat'));

test('every slot check in the heartbeat uses the minute the tick started, not the minute the step is reached', () => {
  assert.match(run, /const tickMin = new Date\(T0\)\.getUTCMinutes\(\)/);
  assert.equal((run.match(/getUTCMinutes\(\)/g) || []).length, 1, 'only tickMin reads the clock minute');
  assert.equal(/hourlyTailTick\(new Date\(\)/.test(run), false);
  for (const job of ['syncBrandPool', 'flushFyi', 'staleContractAlerts', 'ensureTemplate', 'openRawFolders']) {
    const at = run.indexOf(job);
    assert.match(run.slice(Math.max(0, at - 260), at), /hourlyTailTick\(tickMin\)/, job);
  }
});

test('a :14 tick that reaches the tail at minute 16 is still the hourly tail tick', () => {
  const started = new Date('2026-11-21T08:14:00Z');
  const reached = new Date(started.getTime() + 135e3);
  assert.equal(hourlyTailTick(reached.getUTCMinutes()), false); // what the old code saw
  assert.equal(hourlyTailTick(started.getUTCMinutes()), true);
});
