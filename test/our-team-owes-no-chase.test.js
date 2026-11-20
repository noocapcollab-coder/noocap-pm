import test from 'node:test';
import assert from 'node:assert/strict';

// Bug hunter Nov 20: HoneyBook x Chris (BD-86) sat at Brief Received with Next Action "Waiting for Chris's team to send
// the script". ourMoveText read any "Waiting for ..." as the brand owing us, so the heartbeat drafted a follow-up to Dori
// promising the script "shortly" while the script was ours to send (rules 4 and 57).
test("'Waiting for <creator>'s team / our team' is our move, never a brand follow-up", async () => {
  const { ourMoveText } = await import('../lib/heartbeat.js');
  assert.equal(ourMoveText("Waiting for Chris's team to send the script", 'Chris'), true);
  assert.equal(ourMoveText('Waiting for Chris to film the video', 'Chris'), true);
  assert.equal(ourMoveText('Waiting on our team to finish the script', 'Lindsay'), true);
  assert.equal(ourMoveText('Waiting for Rudraksh to write the script', 'Lindsay'), true);
  assert.equal(ourMoveText('Waiting for the editor to finish the cut', 'Brad'), true);
  assert.equal(ourMoveText('Waiting for Harsh to confirm the date', 'Brad'), true);
  // the brand still owes it: chase as before
  assert.equal(ourMoveText('Waiting for HoneyBook to approve the script', 'Chris'), false);
  assert.equal(ourMoveText('Waiting for the brand to send the brief', 'Chris'), false);
  assert.equal(ourMoveText('Waiting for Dori to review the script', 'Chris'), false);
});

// Test bank capcut-chris-cleared-to-post-nov16 (15:26 UTC, Nov 20): "right after it goes live" passed the filler guard
test('"right after it goes live" and "once it is live" count as filler promises', async () => {
  const { checkDraft } = await import('../lib/outbox.js');
  for (const s of ['We will share the link right after it goes live.', "We'll send the live link the moment it's live.", 'Once the video is live, we will share the link here.', 'We will share it immediately after it is posted.']) {
    assert.ok(checkDraft({ body: s }).issues.length > 0, s);
  }
  assert.equal(checkDraft({ body: 'Here is the live link: https://instagram.com/p/abc' }).issues.length, 0);
});
