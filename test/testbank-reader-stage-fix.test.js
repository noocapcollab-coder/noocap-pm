// Bug hunter Nov 23: the test bank scored the reader alone and missed handleInboxEmail's stage correction, so
// aiinspo-duncan-script-notes-called-video-draft-nov23 stayed "not fixed yet" after 2c8c0bd fixed it in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readerStageFixes } from '../lib/testbank.js';
import * as I from '../lib/inbox.js';

const x = () => ({ from_role: 'brand', event: 'video_feedback', feedback: '1. Shorten the intro\n2. Mention the free trial\n3. Add the app name on screen' });

test('notes on a script-only deal score as script_changes in the test bank, like production', () => {
  assert.equal(readerStageFixes(x(), { brand: 'AI Inspo', creator: 'Duncan', stage: 'Script Sent' }, I).event, 'script_changes');
});

test('a deal past the script stage, or a case with a cut sent, keeps video_feedback', () => {
  assert.equal(readerStageFixes(x(), { stage: 'Video Sent' }, I).event, 'video_feedback');
  assert.equal(readerStageFixes(x(), { stage: 'Script Sent', cutSent: true }, I).event, 'video_feedback');
  assert.equal(readerStageFixes({ ...x(), from_role: 'us' }, { stage: 'Script Sent' }, I).event, 'video_feedback');
});

// Bug hunter Nov 25: kylon-publish-chase was reported BROKEN after 34fd4ee ("wanted to set the stage to Paid") though
// production never writes a money stage from the reader (aiStage drops Invoiced/Paid), so the bank flagged a commit
// for undoing over a stage the PM cannot set
test('a money stage from the reader is dropped in the test bank, like production (aiStage)', () => {
  const paid = readerStageFixes({ from_role: 'brand', event: 'brand_reply', deal_stage: 'Paid' }, { stage: 'Invoiced' }, I);
  assert.equal(paid.deal_stage, null);
  assert.equal(readerStageFixes({ from_role: 'brand', event: 'brand_reply', deal_stage: 'Invoiced' }, { stage: 'Posted' }, I).deal_stage, null);
  assert.equal(readerStageFixes({ from_role: 'brand', event: 'brand_reply', deal_stage: 'Approved' }, { stage: 'Video Sent' }, I).deal_stage, 'Approved');
});
