// System check Nov 26 night: a Writer case's quoted history is shown apart from the brand's newest message
import test from 'node:test';
import assert from 'node:assert/strict';
import { writerMemory } from '../lib/testbank.js';

test('writer case: Zoho quoted history is split off the newest message', () => {
  const m = writerMemory({ from: 'Alisa', subject: 'Re: CapCut', text: 'Hi there,\n\nJust checking in to see if the video can be produced within this week or the next.\n\n---- On Tue, 17 Nov 2026 11:35:29 +0800 Alisa alisa@globeinflu.com wrote ---\n\nWould it be possible to continue with the original brief for Brad instead?' });
  const [latest, earlier] = m.split('Earlier in the thread');
  assert.match(latest, /produced within this week/);
  assert.doesNotMatch(latest, /original brief/);
  assert.match(earlier || '', /original brief/);
});

test('writer case: an email with no quoted history is passed whole', () => {
  const m = writerMemory({ from: 'x', subject: 'y', text: 'Can you send the script?' });
  assert.match(m, /Can you send the script\?/);
  assert.doesNotMatch(m, /Earlier in the thread/);
});
