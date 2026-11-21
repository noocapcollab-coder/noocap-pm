// Test bank topview-lindsay-agreement-details-nov21 failed at 11:56, 13:07 and 16:16 UTC on Nov 21: after the lesson and
// the preflight hold (2515762) the writer still answered Su Wern's agreement form with made-up details ("Business Name:
// Lindsay Creative LLC", "Legal Name: Lindsay Smith", "123 Maple Street", "lindsay@noocap.com"). Rule 71: those only
// ever come from Harsh, so writeEmail takes the lines out and the draft is held for him.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dropUngivenDetails } from '../lib/outbox.js';

const BAD = "Hi Su Wern,\n\nNice to meet you as well, and we are excited to get started.\n\nAttached is the script for the campaign. Please let us know if you have any feedback or if it is approved to move into production.\n\nRegarding the agreement, here are Lindsay's details:\n\nBusiness Name: Lindsay Creative LLC\nLegal Name: Lindsay Smith\nLegal Address: 123 Maple Street, Suite 400, Los Angeles, CA 90001\nContact Email: lindsay@noocap.com\n\nBest,\nLindsay's Team";

test('made-up business and legal details are taken out of a written email (topview-lindsay-agreement-details-nov21)', () => {
  const r = dropUngivenDetails(BAD, '{}');
  assert.equal(r.dropped, 4);
  assert.doesNotMatch(r.body, /Lindsay Creative|Lindsay Smith|Maple|noocap\.com|here are Lindsay's details/);
  assert.match(r.body, /Attached is the script/);
  assert.match(r.body, /Best,\nLindsay's Team$/);
});

test('details Harsh gave in the facts stay in', () => {
  const given = JSON.stringify({ business_name: 'Automate AI Consulting', legal_name: 'Lindsay Gonzales' });
  const r = dropUngivenDetails("Hi,\n\nHere are the details:\nBusiness Name: Automate AI Consulting\nLegal Name: Lindsay Gonzales\n\nBest,\nLindsay's Team", given);
  assert.equal(r.dropped, 0);
  assert.match(r.body, /Legal Name: Lindsay Gonzales/);
});

test('an email with no detail lines is left exactly as it was', () => {
  const body = "Hi Mia,\n\nThanks for approving the script. Could you give access on noocaptools@gmail.com?\n\nBest,\nChris's Team";
  assert.deepEqual(dropUngivenDetails(body, ''), { body, dropped: 0 });
});

test('writeEmail runs the details guard and the heartbeat holds such a draft for Harsh', () => {
  const ob = readFileSync(new URL('../lib/outbox.js', import.meta.url), 'utf8');
  const fn = ob.slice(ob.indexOf('export async function writeEmail'), ob.indexOf('export const NEEDS_DETAILS'));
  assert.match(fn, /dropUngivenDetails\(mail\.body/);
  assert.match(fn, /mail\.needsYou = NEEDS_DETAILS/);
  const hb = readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(hb, /if \(mail\.needsYou && !\/\^Needs you\/i\.test\(why\)\) why = `Needs you: \$\{mail\.needsYou\}/);
  assert.match(hb, /notify: !auto \|\| !!mail\.needsYou/);
});
