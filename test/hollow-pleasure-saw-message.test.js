import test from 'node:test';
import assert from 'node:assert/strict';

// Morning system check, Nov 28: test bank capcut-chris-publish-asap-nov19 wrote "We saw your message about the video."
// to a brand chasing the posting, and the hourly reply check drafted "It was a pleasure working with you" to Luma AI's
// "invoice forwarded for Net 30". Both say nothing, so both are hollow.
test('"we saw your message" and "it was a pleasure" are empty emails (capcut-chris-publish-asap-nov19, Nov 28)', async () => {
  const { emptyBody } = await import('../lib/outbox.js');
  assert.equal(emptyBody("Hi Mia,<br /><br />We saw your message about the video.<br /><br />Best,<br />Chris's Team"), true);
  assert.equal(emptyBody('Hi Upendra,<br /><br />Thank you for the update. It was a pleasure working with you on this.<br /><br />Best,<br />Lindsay\'s Team'), true);
  // a real answer is still an email
  assert.equal(emptyBody("Hi Mia,<br /><br />We saw your message. The video goes live on December 2 at 10am EST.<br /><br />Best,<br />Chris's Team"), false);
});

test('a pleasure line is only a pleasantry, so the hourly check drafts no reply (Luma AI x Lindsay, Nov 28)', async () => {
  const { hollowReply } = await import('../lib/unanswered.js');
  assert.equal(hollowReply("Hi Upendra,<br /><br />Thank you for the update. It was a pleasure working with you on this, and we look forward to future collaborations.<br /><br />Best,<br />Lindsay's Team"), true);
  assert.equal(hollowReply("Hi Upendra,<br /><br />Thank you for the update. The Story screenshot is attached.<br /><br />Best,<br />Lindsay's Team"), false);
});
