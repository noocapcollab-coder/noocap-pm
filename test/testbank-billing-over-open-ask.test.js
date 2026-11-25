// Bug hunter Nov 25: the 12:07 and 15:16 UTC test bank runs reported dreamina-chris-billing-over-hashtags-nov20 as
// BROKEN (a billing-details reminder that ignored Jenny's hashtag question), though the writer had not changed since the
// 08:56 run that passed. In production that reminder is never drafted: brandWaitingOnUs (lib/heartbeat.js) skips a
// billing-details ask while the brand's newest email is unanswered. runWriter called writeEmail with no heartbeat gate
// but liveLinkOwed, so it scored a draft production never makes, and a false regression marks a commit for undoing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatSkip } from '../lib/testbank.js';

const dreamina = {
  kind: 'Writer',
  email: { from: 'jenny@viralvibe.llc', subject: 'Re: Paid Collaboration Invitation with Dreamina × thechriscordero', text: 'Hi! Could you please revise the hashtags accordingly? Thank you!\n\n#Dreamina #MarketingStudio #HireDreamina #Seedance #DreaminaPartner\nJenny, BD' },
  deal: { brand: 'Dreamina', creator: 'Chris' },
  expect: { kind: 'Billing details' },
};

test("a billing-details ask over the brand's unanswered email is not scored (Dreamina x Chris hashtags)", () => {
  assert.match(heartbeatSkip(dreamina), /unanswered|waiting for our answer/);
  assert.equal(heartbeatSkip({ ...dreamina, expect: { kind: 'Reply' } }), '', 'a reply to it is still scored');
  assert.equal(heartbeatSkip({ ...dreamina, deal: { ...dreamina.deal, lastBrand: '2026-11-20T10:00:00Z', lastOur: '2026-11-21T10:00:00Z' } }), '', 'we answered after their email: the reminder is real');
});
