import test from 'node:test';
import assert from 'node:assert/strict';

// Teamily AI x Brad, Nov 28-29: reminded at 23:27 IST, then again at 00:17 IST because the day key rolled over.
test('a late cut reminded yesterday is not reminded again before 10:00 IST', async () => {
  const { remindNow } = await import('../lib/reviewwait.js');
  assert.equal(remindNow({ hour: 0, urgency: 'late', remindedYesterday: true }), false);
  assert.equal(remindNow({ hour: 0, urgency: 'soon', remindedYesterday: true }), false);
});

test('a newly late cut is still reminded at once, and everything is reminded from 10:00 IST', async () => {
  const { remindNow } = await import('../lib/reviewwait.js');
  assert.equal(remindNow({ hour: 0, urgency: 'late', remindedYesterday: false }), true);
  assert.equal(remindNow({ hour: 3, urgency: 'later' }), false);
  assert.equal(remindNow({ hour: 10, urgency: 'late', remindedYesterday: true }), true);
  assert.equal(remindNow({ hour: 11, urgency: 'none' }), true);
  assert.equal(remindNow({ hour: 2, urgency: 'late', remindedYesterday: true, force: true }), true);
});
