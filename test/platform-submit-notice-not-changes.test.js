// Bug hunter Nov 25: PM LESSONS "A platform's 'submit it in the app' notice is not change notes" (rule 79, Weglot x
// Lindsay via Faved, Nov 23) had no code guard. Two Faved notices ("there is no asset", "submit the video link in the
// Faved app") were read as video_feedback, put the EDIT TRACKER row on Changes and pinged Prateek with CHANGES REQUESTED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextGuards, platformSubmitNotice } from '../lib/inbox.js';

const noAsset = "Hi Automate AI Consulting,\n\nThere has been an update to your Weglot Paid Sponsorship x Automate AI Consulting deal.\n\nUpdate\nWeglot - Draft Video Feedback:\nHi, there is no asset in your submission. Could you please submit the video link in the Faved app?\n\nNext Step\nDraft video - waiting on creator submission";
const inApp = "Hi Lindsay,\n\nPlease submit the draft video through the Faved campaign page so the brand can review it there.\n\nThanks,\nFaved team";

test('a Faved "no asset / submit in the app" notice is not video feedback (rule 79)', () => {
  for (const text of [noAsset, inApp]) {
    const x = applyTextGuards({ from_role: 'brand', event: 'video_feedback', feedback: 'there is no asset, submit the video link in the Faved app' }, { text });
    assert.equal(x.event, 'brand_reply');
    assert.equal(x.feedback, null);
    assert.equal(x.needs_reply, false);
    assert.equal(x.needs_our_info, true);
    assert.equal(x.platform_submit, true);
    assert.match(x.info_needed, /submit the cut on the brand's platform/);
  }
});

test('real change notes sent through a platform stay video feedback', () => {
  const notes = "Update\nWeglot - Draft Video Feedback:\nPlease change the music and shorten the intro to 3 seconds. Then submit the new version in the Faved app.";
  const x = applyTextGuards({ from_role: 'brand', event: 'video_feedback', feedback: 'change the music, shorten the intro' }, { text: notes });
  assert.equal(x.event, 'video_feedback');
  assert.equal(platformSubmitNotice(notes), '');
});

test('a platform approval is never turned into a submission ask', () => {
  const ok = "Update\nWeglot - Draft Video Approved:\nLooks great! Please post on Nov 30 and add the live link in the Faved app.";
  assert.equal(platformSubmitNotice(ok), '');
  const x = applyTextGuards({ from_role: 'brand', event: 'video_feedback', video_approved: true }, { text: ok });
  assert.equal(x.event, 'video_feedback');
});

test('plain brand notes by email are untouched', () => {
  assert.equal(platformSubmitNotice('Can you remove the logo at 0:12 and add subtitles?'), '');
  const x = applyTextGuards({ from_role: 'brand', event: 'video_feedback', feedback: 'remove the logo' }, { text: 'Can you remove the logo at 0:12?' });
  assert.equal(x.event, 'video_feedback');
});
