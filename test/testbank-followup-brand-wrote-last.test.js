// Bug hunter Nov 27: test bank capcut-brad-timeline-ask-nov20 was reported "1 broken by this change" after 4046841's
// neighbour runs, in the Nov 26 nightly and again at 04:16 UTC after e904496 (an inbox ack change that never touches the
// writer). The case is a Follow-up whose email is Alisa's newest message ("we would like to know the timeline for Brad"),
// but the heartbeat only drafts a follow-up when the brand has been silent since our newest email (brandSilent in the
// follow-up loop, lib/heartbeat.js): a brand that wrote last is answered, never chased. runWriter still asked writeEmail
// for a follow-up with no facts, the writer guessed we were "waiting for your feedback on the revised script", and the
// false regression marks a commit for undoing or switches off a lesson.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatSkip } from '../lib/testbank.js';

const capcut = {
  kind: 'Writer',
  email: { from: 'alisa@globeinflu.com', subject: 'Re: Paid Collaboration Opportunity with CapCut', text: 'Hi,\n\nJust checking in again on our previous email. We would like to know the timeline for Brad.\n\nBest regards,\nAlisa' },
  deal: { brand: 'CapCut', creator: 'Brad' },
  expect: { kind: 'Follow-up' },
};

test("a follow-up over the brand's own newest email is not scored (CapCut x Brad timeline ask)", () => {
  assert.match(heartbeatSkip(capcut), /follow-up/i);
  assert.equal(heartbeatSkip({ ...capcut, expect: { kind: 'Reply' } }), '', 'a reply to it is still scored');
  assert.equal(heartbeatSkip({ ...capcut, deal: { ...capcut.deal, lastBrand: '2026-11-20T10:00:00Z', lastOur: '2026-11-21T10:00:00Z' } }), '', 'we wrote after their email: a follow-up is real');
});
