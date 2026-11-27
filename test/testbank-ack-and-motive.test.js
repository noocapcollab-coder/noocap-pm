// Bug hunter, Nov 27. The 07:27 UTC test bank run reported two writer cases BROKEN:
// emergent-chris-why-script-nov26: "to ensure we were aligned on the creative direction" is a made-up motive (rule 84),
//   but OWN_MOTIVE only knew "to keep the momentum", "so that X could" and "because we", so the reply was not held.
// luma-lindsay-please-wait-ack-nov26: a thanks-and-"we'll stand by" reply was scored as sent, though production never
//   drafts it (unanswered.js hollowReply sends the fixed status ack once per round or nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOwnMotive, checkDraft, autoHoldReason } from '../lib/outbox.js';
import { ackOnlyReply } from '../lib/testbank.js';

const wrap = (who, s, c = 'Chris') => `Hi ${who},\n\n${s}\n\nBest,\n${c}'s Team`;

test('a purpose clause explaining why we sent something is a motive held for Harsh', () => {
  for (const line of [
    'We shared the script early to ensure we were aligned on the creative direction.',
    'The script was shared to ensure we were aligned on the creative direction before the agreement.',
    'We sent the script first to make sure Chris could start sooner.',
  ]) {
    assert.ok(claimsOwnMotive(line), line);
    assert.ok(checkDraft({ body: wrap('Karan', line) }).issues.some((i) => /explains why we/.test(i)), line);
    assert.ok(autoHoldReason({ body: wrap('Karan', line), why: 'Reply', creator: 'Chris' }), line);
  }
});

test('plain statements of what we sent, and asks to the brand, are not a motive', () => {
  for (const line of [
    'We sent the invoice on November 3.',
    'We have shared access to the folder.',
    'Please make sure to tag @luma in the caption.',
    'The script is attached so you can review it.',
  ]) assert.equal(claimsOwnMotive(line), false, line);
});

test('the test bank scores a thanks-and-stand-by reply as never drafted', () => {
  const bad = wrap('Upendra', 'Thanks for letting us know, so we will stand by for your update once the team finishes reviewing the video.', 'Lindsay');
  assert.equal(ackOnlyReply('Reply', bad), true);
  assert.equal(ackOnlyReply(undefined, bad), true);
  assert.equal(ackOnlyReply('Follow-up', bad), false);
  assert.equal(ackOnlyReply('Reply', wrap('Upendra', "Lindsay's Luma account email is lindsay@example.org.", 'Lindsay')), false);
});
