import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages } from '../lib/whatsapp.js';

// Higgsfield × Chris, Nov 16: the offer was saved by one run, then the tap's run saved over it
test('a save never wipes a message another run saved', () => {
  const base = [{ role: 'user', content: 'Chris x higgsfield', wa: 'w1', at: '2026-11-16T06:40:06Z' }];
  const offerRun = [...base, { role: 'assistant', meta: 'deal-confirm', content: 'New brand deal', brand: 'Higgsfield', at: '2026-11-16T06:40:20Z' }];
  const tapRun = [...base, { role: 'user', content: '[tapped ✅ File · WhatsApp]', wa: 'w2', at: '2026-11-16T06:40:21Z', meta: 'button' }];
  const merged = mergeMessages(tapRun, offerRun);
  assert.deepEqual(merged.map((m) => m.content), ['Chris x higgsfield', 'New brand deal', '[tapped ✅ File · WhatsApp]']);
});

test('a resolved offer stays resolved whichever run saves last', () => {
  const offer = { role: 'assistant', meta: 'deal-confirm', content: 'New brand deal', at: '2026-11-16T06:40:20Z' };
  const merged = mergeMessages([offer], [{ ...offer, resolved: 'filed' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].resolved, 'filed');
});
