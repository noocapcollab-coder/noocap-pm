import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCutNotes } from '../lib/inbox.js';
import { burstOf } from '../api/whatsapp.js';

const BRAD = `Hey. Overall looks good. Here are some fixes.

1/ At 5 seconds, it cuts me off when I say "30 seconds."

2/ The mountain shot needs to show on the phone screen at 15 seconds right after I say "Open with a mountain shot." And before I say "more upbeat music."

3/ My avatar looks whacky in the CTA. My head is jumping around. If it can't be fixed, just remove my avatar in the CTA.`;

test('cut notes are told apart from script notes (Brad x PromoCut, Nov 13)', () => {
  assert.equal(looksLikeCutNotes(BRAD), true);
  assert.equal(looksLikeCutNotes('Can you reword the hook line in the script? The second paragraph should mention the free trial.'), false);
  assert.equal(looksLikeCutNotes('Please change the CTA wording in the script to say link in bio'), false);
});

test('a forwarded note and the label sent with it are read as one message by the newest one', () => {
  const at = '2026-11-13T10:22:28.000Z';
  const notes = { role: 'user', content: BRAD, wa: 'wamid.A', at, fwd: true };
  const label = { role: 'user', content: 'Brad x promo cut changes', wa: 'wamid.B', at };
  const msgs = [{ role: 'assistant', content: 'draft card', at: '2026-11-13T09:49:49.000Z' }, notes, label];
  assert.deepEqual(burstOf(msgs, notes), { yield: true });
  const b = burstOf(msgs, label);
  assert.ok(b.text.startsWith('Hey. Overall looks good'));
  assert.ok(b.text.endsWith('Brad x promo cut changes'));
  assert.equal(b.fwd, true);
  // A message on its own, or one a minute later, is not a burst
  assert.deepEqual(burstOf([notes], notes), {});
  assert.deepEqual(burstOf([notes, { ...label, at: '2026-11-13T10:23:40.000Z' }], notes), {});
  // Button taps are never joined
  assert.deepEqual(burstOf([notes, { ...label, meta: 'button' }], notes), {});
});
