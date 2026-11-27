// PM LESSONS "The question that comes with video notes is the brand's real ask" (HoneyBook x Chris, Nov 26) had no code
// guard: the WhatsApp for a question inside video notes took the first summary line, "Brand loves the video", so Dori's
// ask for Chris's MyCo account email never reached Harsh. Bug hunter, Nov 27.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesQuestionLine } from '../lib/inbox.js';

const dori = 'Hi team, we love the video! A couple of notes: please trim the intro and add the logo at the end.\nAlso, could you send over the email Chris uses for his MyCo account so we can set up the UTM?\nThanks, Dori';

test('the brand\'s ask is passed on, never the praise line', () => {
  const line = notesQuestionLine({ summary: ['Brand loves the video', 'Trim the intro, add the logo at the end'] }, dori);
  assert.match(line, /MyCo account/);
  assert.doesNotMatch(line, /loves the video/);
});

test('info_needed and a summary question come first', () => {
  assert.match(notesQuestionLine({ info_needed: "Chris's MyCo account email for the UTM", summary: ['Brand loves the video'] }, dori), /They need: Chris's MyCo account email/);
  assert.equal(notesQuestionLine({ summary: ['Brand loves the video', 'Can we get the TikTok ad code?'] }, ''), 'Can we get the TikTok ad code?');
});

test('with nothing to quote it never sends praise as the ask', () => {
  assert.equal(notesQuestionLine({ summary: ['Brand loves the video'] }, 'Love it, small notes below.'), 'Open the email to see what they asked');
});
