// Bug hunter Nov 23 (rule 68): the script_changes_ack fixed reply to "Business VivaVideoapp" <business@vivavideotech.com>
// opened "Hi Business". Jessie signs her emails; a mailbox role word is never the greeting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillTemplate } from '../lib/replytemplates.js';

const body = 'Hi {name},\n\nThanks for the notes.\n\nBest,\n{creator}\'s Team';
const from = '"Business VivaVideoapp" <business@vivavideotech.com>';
const text = 'Hi,\n\nThank you for sending over the drafts.\n\nBest regards,\nJessie\nAI Inspo Team';

test('a role-word From name greets the person who signed the email', () => {
  assert.match(fillTemplate(body, { from, deal: { creator: 'Duncan' }, text }), /^Hi Jessie,/);
});

test('with no signature it falls back to "Hi there", never the role word', () => {
  assert.match(fillTemplate(body, { from, deal: { creator: 'Duncan' } }), /^Hi there,/);
});

test('a real first name in the From line is still used', () => {
  assert.match(fillTemplate(body, { from: '"Karan V" <karan.v@emergent.sh>', deal: { creator: 'Chris' }, text }), /^Hi Karan,/);
});
