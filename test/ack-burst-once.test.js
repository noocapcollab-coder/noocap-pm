// Morning check Nov 27 (Atoms x Lindsay): two brand emails a minute apart got the same script_changes_ack twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keepAckCopy, sameRoundCopy } from '../lib/replytemplates.js';

const key = 'script_changes_ack';
const ack = { why: 'Fixed reply [template:script_changes_ack]', status: 'Sent', created: '2026-11-27T03:40:37.000Z' };

test('an ack sent a minute before the next brand email still blocks a second ack', () => {
  const rows = [ack].filter((r) => keepAckCopy(r, key, '2026-11-27T03:40:47.000Z'));
  assert.equal(sameRoundCopy(rows, key), 'sent');
});

test('an ack from an earlier day does not block the ack for new notes', () => {
  const old = { ...ack, created: '2026-11-19T10:00:00.000Z' };
  const rows = [old].filter((r) => keepAckCopy(r, key, '2026-11-27T03:40:47.000Z'));
  assert.equal(sameRoundCopy(rows, key), false);
});

test('rows that are not this ack are always kept', () => {
  assert.ok(keepAckCopy({ why: 'Script', created: '2026-01-01T00:00:00Z' }, key, '2026-11-27T03:40:47.000Z'));
});
