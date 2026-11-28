// Bug hunter, Nov 28 (2). Test bank 10:17 UTC after 6290903: emergent-chris-why-script-nov26 drafted a motive
// "to help speed up the concept alignment process" (rule 84). OWN_MOTIVE knew "to speed up" but not "to help speed up",
// so the reply would not have been held for Harsh's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOwnMotive, autoHoldReason } from '../lib/outbox.js';

const wrap = (s) => `Hi Karan,\n\n${s}\n\nBest,\nChris's Team`;

test('"to help" before a purpose behind our own action is a motive held for Harsh', () => {
  for (const line of [
    'We shared the script ahead of the agreement to help speed up the concept alignment process.',
    'We sent the script over early to help us align on the creative direction.',
    'The script was shared early to help ensure we were aligned.',
    'This was done to help speed things up.',
  ]) {
    assert.ok(claimsOwnMotive(line), line);
    assert.ok(autoHoldReason({ body: wrap(line), why: 'Reply', creator: 'Chris' }), line);
  }
});

test('"to help" lines that explain no action of ours stay free', () => {
  for (const line of [
    'Happy to help with anything else you need.',
    'Let us know if a call would help speed things up.',
    'The attached brief should help you get started.',
  ]) assert.ok(!claimsOwnMotive(line), line);
});
