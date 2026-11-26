// Night check Nov 26 (Luma AI x Lindsay): a status acknowledgement goes once per round, and a reply that only says we
// are standing by is hollow
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameRoundCopy, STATUS_ACKS } from '../lib/replytemplates.js';
import { hollowReply } from '../lib/unanswered.js';

test('draft_review_ack is a status ack (no per-email copy)', () => {
  assert.ok(STATUS_ACKS.has('draft_review_ack'));
  assert.ok(STATUS_ACKS.has('script_review_ack'));
  assert.ok(!STATUS_ACKS.has('video_changes_ack'));
});

test('a second status ack in the same round is blocked', () => {
  const rows = [
    { why: 'Draft video [x]', status: 'Sent', created: '2026-11-26T12:00:00Z' },
    { why: 'Fixed reply [template:draft_review_ack]', status: 'Sent', created: '2026-11-26T13:10:00Z' },
  ];
  assert.equal(sameRoundCopy(rows, 'draft_review_ack'), 'sent');
});

test('"we are standing by for their feedback" is a hollow reply', () => {
  assert.ok(hollowReply('Hi Upendra,\n\nThanks for the update and for letting us know. We are standing by for their feedback.\n\nBest,\nLindsay\'s Team'));
  assert.ok(!hollowReply('Hi Upendra,\n\nHere is the revised cut: https://f.io/x\n\nBest,\nLindsay\'s Team'));
});
