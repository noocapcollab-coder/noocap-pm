// Nov 22 (bug hunter): Lead follow-ups were gated on every15 (the :04/:34 ticks). Those ticks also run the tool-access
// catch-up and the other 30-minute work, so the heartbeat was always past its 170 s budget before reaching them and
// PM RUNS showed "Out of time, next tick picks up: ... Lead follow-ups" on every :04/:34 tick from Nov 17 to Nov 22:
// no quote nudge, unanswered-lead catch-up or brief chase ran in that time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { every15Tick, hourlyTailTick, leadTick } from '../lib/heartbeat.js';

test('lead follow-ups get their own slot: twice an hour, never a 30-minute tick or the hourly tail tick', () => {
  for (let offset = 0; offset < 10; offset++) {
    const ticks = [0, 1, 2, 3, 4, 5].map((k) => offset + 10 * k);
    const hits = ticks.filter(leadTick);
    assert.equal(hits.length, 2, `offset ${offset}`);
    for (const h of hits) {
      assert.equal(every15Tick(h), false, `offset ${offset}: ${h} is also a 30-minute tick`);
      assert.equal(hourlyTailTick(h), false, `offset ${offset}: ${h} is also the hourly tail tick`);
    }
  }
  assert.deepEqual([4, 14, 24, 34, 44, 54].filter(leadTick), [24, 54]);
});

test('the lead follow-up step is gated on leadTick, not every15', () => {
  const src = readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  const at = src.indexOf("skipped.push('Lead follow-ups')");
  assert.ok(at > 0);
  const gate = src.slice(at, at + 120);
  assert.match(gate, /leadTick\(tickMin\)/);
  assert.doesNotMatch(gate, /every15/);
});
