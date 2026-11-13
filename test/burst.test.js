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

test('a flagged card finds its deal by link, else by brand and creator', async () => {
  const { dealForCard } = await import('../lib/scriptping.js');
  const deals = [
    { id: 'd1', brand: 'Hyper3D', creator: 'Lindsay', linkedVideo: 'https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { id: 'd2', brand: 'Hyper3D', creator: 'Chris', linkedVideo: '' },
  ];
  assert.equal(dealForCard(deals, { url: 'https://www.notion.so/Hyper3D-Lindsay-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'whatever', creator: 'Lindsay' }).id, 'd1');
  assert.equal(dealForCard(deals, { url: 'https://www.notion.so/x-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'Hyper3D × Chris', creator: 'Chris' }).id, 'd2');
  assert.equal(dealForCard(deals, { url: 'https://www.notion.so/x-cccccccccccccccccccccccccccccccc', title: 'Polar', creator: 'Chris' }), null);
});

test('loop-in reply confirms we take over and asks only for what is missing (Nov 13)', async () => {
  const { handoverAckText } = await import('../lib/inbox.js');
  const a = handoverAckText({ name: 'Jessie', brand: 'AI Inspo', creator: 'Duncan', text: "I'm adding noocapcollab@gmail.com to this thread so they can handle all next steps from here." });
  assert.ok(a.startsWith('Hi Jessie,'));
  assert.ok(/take this collaboration forward from here/.test(a));
  assert.ok(/Could you share the brief and the contract in this thread\?/.test(a));
  assert.ok(!/Lindsay's team and|(if there is one)/.test(a));
  assert.ok(a.endsWith("Duncan's Team"));
  const b = handoverAckText({ name: '', brand: 'Hyper3D', creator: 'Lindsay', text: 'Adding noocapcollab. The brief is here: https://notion.so/brief-123' });
  assert.ok(b.startsWith('Hi Hyper3D team,'));
  // Same copy for everyone (Harsh, Nov 13): only the sign-off changes
  assert.equal(b.split('\n').slice(1, -1).join('\n'), a.split('\n').slice(1, -1).join('\n'));
  assert.ok(b.endsWith("Lindsay's Team"));
});

test('a video approval the second reader only relabels is not held (Upfluence x Duncan, Nov 12)', async () => {
  const { labelOnlyApproval } = await import('../lib/verify.js');
  const x = { event: 'video_feedback', video_approved: true };
  assert.ok(labelOnlyApproval(x, { agree: false, rightEvent: 'brand_reply', reason: "The brand approved the first draft video and asked the team to proceed with remaining assets, but this is not feedback on a video—it's an approval" }));
  assert.ok(!labelOnlyApproval(x, { agree: false, rightEvent: 'brand_reply', reason: 'The brand has not approved the video yet, they only asked a question' }));
  assert.ok(!labelOnlyApproval(x, { agree: false, rightEvent: 'brand_reply', wrongDeal: true, reason: 'approved, but another deal' }));
  assert.ok(!labelOnlyApproval({ event: 'video_feedback', video_approved: false }, { agree: false, rightEvent: 'brand_reply', reason: 'approved' }));
});
