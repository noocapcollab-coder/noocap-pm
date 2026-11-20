// Night system check, Nov 20: Harsh's "Hi" (sent to open the WhatsApp window) came 2 minutes after the PM asked about
// CapCut x Lindsay's GTA 6 brief and was taken as the answer, so a reply to Sophie said "we are open to switching to the
// new GTA 6 brief ... and we can make that work for this weekend", a decision Harsh never gave (rule 13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infoAskFor, isBareAck, isGreeting } from '../api/whatsapp.js';

const ask = { role: 'assistant', meta: 'info-ask', at: new Date().toISOString(), content: 'CapCut × Lindsay is asking for: an answer', infoAsk: { brand: 'CapCut', creator: 'Lindsay', need: 'an answer to the GTA 6 brief' } };

test('a greeting is never the answer to the question above it', () => {
  const st = { messages: [ask] };
  for (const t of ['Hi', 'hi', 'Hey', 'hello', 'Hii', 'Good morning', 'hi harsh', 'Hey 👋']) {
    assert.equal(isGreeting(t), true, t);
    assert.equal(infoAskFor(st, null, t), null, t);
    assert.equal(isBareAck(t), true, t);
  }
});

test('a real answer still answers', () => {
  const st = { messages: [ask] };
  assert.equal(isGreeting('Hi, yes switch to the GTA 6 brief, post Sunday'), false);
  assert.equal(infoAskFor(st, null, 'Yes switch to the GTA 6 brief, Lindsay can post it Sunday'), ask);
});
