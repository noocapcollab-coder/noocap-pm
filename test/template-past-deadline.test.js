import test from 'node:test';
import assert from 'node:assert/strict';
import { templateBlock } from '../lib/replytemplates.js';

const ack = { key: 'video_changes_ack', active: true, stages: ['Submitted', 'Changes'], days: 2 };

test('templateBlock: a deadline already passed (left from an earlier round) does not block the round ack', () => {
  // CapCut x Lindsay, Nov 27: round 2 notes, deal deadline still Nov 22 from round 1
  assert.equal(templateBlock(ack, { stage: 'Submitted', deadline: '2026-11-22', today: '2026-11-27' }), '');
});

test('templateBlock: a deadline still ahead but sooner than the promise still blocks', () => {
  assert.match(templateBlock(ack, { stage: 'Submitted', deadline: '2026-11-27', today: '2026-11-27' }), /deadline/);
  assert.match(templateBlock(ack, { stage: 'Submitted', deadline: '2026-11-28', today: '2026-11-27' }), /deadline/);
  assert.equal(templateBlock(ack, { stage: 'Submitted', deadline: '2026-12-10', today: '2026-11-27' }), '');
});
