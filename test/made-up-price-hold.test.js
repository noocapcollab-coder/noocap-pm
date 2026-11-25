import test from 'node:test';
import assert from 'node:assert/strict';

// Night check, Nov 25: the hourly reply check drafted "$7,000 in total" to Evan (Teamily x Lindsay), a price on no
// email, deal or WhatsApp answer, while Lindsay's team had already offered $2,200.
test('a price the brand email, deal and Harsh never gave holds the reply (Teamily x Lindsay, Nov 25)', async () => {
  const O = await import('../lib/outbox.js');
  const src = 'Hi Lindsay\'s Team, I wanted to follow up on the potential Teamily integration with Lindsay.\n{"brand":"Teamily","memory":"us offered $2,200 for the youtube integration; Evan quoted the previous $2,500"}';
  const bad = O.checkDraft({ body: 'Hi Evan,\n\nOur combined package is $7,000 in total.\n\nBest,\nLindsay\'s Team', creator: 'Lindsay', sources: src });
  assert.ok(bad.issues.some((i) => /\$7,000/.test(i) && /made up/.test(i)));
  // prices that are on the deal pass, in any spelling
  assert.deepEqual(O.inventedAmounts('That would be $2,200 for the integration.', src), []);
  assert.deepEqual(O.inventedAmounts('The rate is 2500 USD.', src), []);
  assert.deepEqual(O.inventedAmounts('The rate is $2.2k.', src), []);
  assert.deepEqual(O.inventedAmounts('USD 7000 for both.', src), ['USD 7000']);
  // without sources (WhatsApp answers, templates) nothing is checked
  assert.equal(O.checkDraft({ body: 'It is $7,000.', creator: 'Lindsay' }).issues.length, 0);
});
