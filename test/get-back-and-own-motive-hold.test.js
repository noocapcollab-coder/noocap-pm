// Bug hunter, Nov 26. Two test bank writer cases failed in the 04:26 UTC run after c9b83a2:
// holo-valeri-when-seen-nov24 (BROKEN): "We are still reviewing the request for an ad extension and will get back to you."
//   passed the filler check, because FILLER knew "we'll send it shortly" but not a bare "will get back to you" (rule 4).
// emergent-chris-why-script-nov26 (never passed): Karan asked why a script went out before the agreement and the draft
//   said "we sent it over to keep the production momentum going" (rule 84: a motive only Harsh can give).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, autoHoldReason, dropFillerSentences, claimsOwnMotive } from '../lib/outbox.js';

const wrap = (who, s) => `Hi ${who},\n\n${s}\n\nBest,\nValeri's Team`;

test('"will get back to you" is a filler promise and is taken out of the reply', () => {
  for (const line of [
    'We are still reviewing the request for an ad extension and will get back to you.',
    "We'll get back to you on the dates.",
    'I will circle back with the details.',
    "We're still checking with Valeri on this.",
  ]) {
    assert.ok(checkDraft({ body: wrap('Milda', line) }).issues.some((i) => /promises to send/.test(i)), line);
    assert.ok(autoHoldReason({ body: wrap('Milda', line), why: 'Reply', creator: 'Valeri' }), line);
  }
  const body = wrap('Milda', 'We identified that the unauthorized ads were active between October 25 and November 24. We are still reviewing the request for an ad extension and will get back to you.');
  const out = dropFillerSentences(body);
  assert.ok(!/get back to you/.test(out));
  assert.ok(/October 25 and November 24/.test(out));
});

test('a conditional "if you have questions, we\'ll get back to you" stays allowed (lead follow-ups)', () => {
  for (const line of [
    "Wanted to check in once more on the Holo collaboration. If you have any questions, just reply here and we'll get back to you.",
    'Let us know if anything is unclear.',
  ]) assert.equal(checkDraft({ body: wrap('Milda', line) }).issues.length, 0, line);
});

test('a reply that explains why we did something is held for Harsh', () => {
  const lines = [
    'Regarding the script, we sent it over to keep the production momentum going while we awaited the signed agreement.',
    'We shared the script early so that Chris could start filming sooner.',
    'We went ahead with the script because we wanted to save time.',
  ];
  for (const line of lines) {
    assert.ok(claimsOwnMotive(line), line);
    assert.ok(checkDraft({ body: wrap('Karan', line) }).issues.some((i) => /explains why we/.test(i)), line);
    assert.ok(autoHoldReason({ body: wrap('Karan', line), why: 'Reply', creator: 'Chris' }), line);
  }
});

test('ordinary replies about what we sent are not a motive', () => {
  for (const line of [
    'We sent the revised cut yesterday: https://f.io/abc',
    'We have noted the Net 15 payment terms from the invoice receipt.',
    'The script is attached so you can review it.',
  ]) {
    assert.equal(claimsOwnMotive(line), false, line);
    assert.equal(checkDraft({ body: wrap('Karan', line) }).issues.length, 0, line);
  }
});
