// Bug hunter Nov 23: AI Inspo x Duncan's card was back at 5 with the script the brand already had (same fingerprint
// 3969fafe2b80 as the Nov 21 email) and the PM sent it twice as "the revised script with your notes worked in".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameScriptAsSent } from '../lib/heartbeat.js';

const card = '419508e99dda81859d7bd9d34b26e198';
const vers = { sent: new Map([[card, '3969fafe2b80']]), pending: new Set(), sentAt: new Map() };

test('a card whose script matches the version the brand got is not a revised script', () => {
  assert.equal(sameScriptAsSent(vers, card, '3969fafe2b80'), true);
});

test('a changed script, an unknown fingerprint or a card never sent is judged as before', () => {
  assert.equal(sameScriptAsSent(vers, card, 'aaaaaaaaaaaa'), false);
  assert.equal(sameScriptAsSent(vers, card, null), false);
  assert.equal(sameScriptAsSent(vers, 'ffffffffffffffffffffffffffffffff', '3969fafe2b80'), false);
  assert.equal(sameScriptAsSent({}, card, '3969fafe2b80'), false);
});

test('both revised-script paths in the heartbeat check the fingerprint before drafting', () => {
  const src = readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(src, /if \(sameScriptAsSent\(vers, h, current\[h\]\)\) \{ due\.delete\(h\)/);
  assert.match(src, /if \(!unchangedScript && video && video\.num === 5 && deal\.stage === 'Script Sent'/);
});
