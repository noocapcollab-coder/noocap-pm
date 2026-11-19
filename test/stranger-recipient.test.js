// Lesson "Reply to the correct person in their own thread" (Draft rejected, Nov 18) and rule 2 (a Runway draft went
// To SpeakOn's Cassie, Nov 3): an address that never appears in the deal's conversation holds the draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strangerRecipient } from '../lib/outbox.js';

const deal = { brandEmail: 'natalie@houseofmarketers.com', threadCc: 'payments@houseofmarketers.com' };
const convo = 'Natalie <natalie@houseofmarketers.com>: please send the invoice to finance@runwayml.com';

test("another brand's address is flagged", () => {
  assert.equal(strangerRecipient('cassie@speakon.ai', deal, convo), 'cassie@speakon.ai');
});

test('anyone at a domain from the thread, the contact or an address named in it passes', () => {
  assert.equal(strangerRecipient('pavinder@houseofmarketers.com', deal, convo), null);
  assert.equal(strangerRecipient('finance@runwayml.com', deal, convo), null);
  assert.equal(strangerRecipient('noocapcollab@gmail.com, natalie@houseofmarketers.com', deal, convo), null);
});

test('free-mail addresses must match exactly, and an unread conversation flags nothing', () => {
  assert.equal(strangerRecipient('someone@gmail.com', { brandEmail: 'brand.owner@gmail.com' }, 'brand.owner@gmail.com wrote'), 'someone@gmail.com');
  assert.equal(strangerRecipient('brand.owner@gmail.com', { brandEmail: 'brand.owner@gmail.com' }, 'x'), null);
  assert.equal(strangerRecipient('cassie@speakon.ai', deal, ''), null);
});
