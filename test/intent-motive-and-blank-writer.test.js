// Bug hunter, Nov 28. The 07:07 UTC test bank run after c96d09d reported two writer cases BROKEN (each failed twice):
// emergent-chris-why-script-nov26: "We apologize for the confusion regarding the script share, as we intended to
//   proactively show our direction for the upcoming content" is a made-up motive (rule 84), but OWN_MOTIVE only knew
//   purpose clauses after "we sent / shared", so "as we intended to" slipped past the hold.
// capcut-brad-answer-newest-nov19: "wrote nothing". writeEmail only rewrote a greeting-only body; a blank body from the
//   writer skipped the NOT_EMPTY rewrite and the Needs-you stamp altogether.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOwnMotive, checkDraft, autoHoldReason, emptyBody } from '../lib/outbox.js';

const wrap = (who, s, c = 'Chris') => `Hi ${who},\n\n${s}\n\nBest,\n${c}'s Team`;

test('"as we intended to" and other stated intentions behind our own action are a motive held for Harsh', () => {
  for (const line of [
    'We apologize for the confusion regarding the script share, as we intended to proactively show our direction for the upcoming content.',
    'We meant to give you an early look at the direction.',
    'Our intention was to show the direction before the agreement.',
    'The idea was to get ahead on the creative so nothing slipped.',
    'We shared it because we wanted to show you the direction early.',
  ]) {
    assert.ok(claimsOwnMotive(line), line);
    assert.ok(checkDraft({ body: wrap('Karan', line) }).issues.some((i) => /explains why we/.test(i)), line);
    assert.ok(autoHoldReason({ body: wrap('Karan', line), why: 'Reply', creator: 'Chris' }), line);
  }
});

test('ordinary lines with "wanted to" or a question about intent are not a motive', () => {
  for (const line of [
    'We wanted to check in on the script feedback.',
    'We wanted to let you know the invoice is attached.',
    'Could you tell us what you intended for the hook?',
    'Regarding the payment, we have noted that the terms are net 15 days from receipt of the invoice.',
  ]) assert.equal(claimsOwnMotive(line), false, line);
});

test('a blank body from the writer counts as empty, so it gets the rewrite and the hold', () => {
  assert.equal(emptyBody(''), true);
  assert.equal(emptyBody(undefined), true);
  assert.equal(emptyBody(wrap('Alisa', 'We will confirm the production timeline with Brad and come back with a date.', 'Brad')), false);
});

test('writeEmail sends a blank writer body through the empty-email rewrite (source check)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/outbox.js', import.meta.url), 'utf8');
  // the empty-email branch must not be skipped when the body is blank
  assert.ok(!/if \(mail\.body && emptyBody\(mail\.body\)\)/.test(src), 'blank body skips the empty-email rewrite');
  assert.ok(/if \(emptyBody\(mail\.body\)\)/.test(src));
});
