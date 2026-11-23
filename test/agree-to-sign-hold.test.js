// Rule 78 (HubSpot x Duncan, Nov 23): a draft must never tell a brand we are ready to sign their contract on its own.
// Signing is Harsh's decision, so such a draft is marked Needs you and held. Bug hunter, Nov 23.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, autoHoldReason } from '../lib/outbox.js';

const wrap = (s) => `Hi Piers,\n\n${s}\n\nBest,\nDuncan's Team`;

test('agreeing to sign the brand\'s contract holds the draft for Harsh', () => {
  for (const line of [
    "Thanks for the brief, we're ready to sign it.",
    'We are happy to sign the agreement.',
    "We'll sign the contract and send it back.",
    'Duncan is ready to sign once you share it. We will go ahead and sign today.',
    'She is willing to sign the agreement.',
  ]) {
    assert.ok(checkDraft({ body: wrap(line) }).issues.some((i) => /will sign their contract/.test(i)), line);
    assert.ok(autoHoldReason({ body: wrap(line), why: 'Reply', creator: 'Duncan' }), line);
  }
});

test('asking the brand to sign, or a fixed template, stays allowed', () => {
  for (const line of [
    'Please sign the agreement and send it back when you can.',
    'Here is the revised cut: https://f.io/abc',
    'Could you let us know who will sign on your side?',
  ]) assert.equal(checkDraft({ body: wrap(line) }).issues.length, 0, line);
  assert.equal(autoHoldReason({ body: wrap("We'll sign it and send it back."), why: '[template:contract_ack] Contract received', creator: 'Duncan' }), null);
});
