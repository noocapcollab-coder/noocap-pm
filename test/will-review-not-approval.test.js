// Bug hunter Nov 24: test bank case fotor-will-review-script-nov20 was read as script_approved twice in the 07:27 UTC
// gate run. "Sounds good! We'll review the script as soon as possible" is a promise to review, so the next move stays
// with the brand: a script_approved read would put the card at To Film and send a tool-access email.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextGuards, reviewPromiseOnly } from '../lib/inbox.js';

const fotor = "Sounds good! We'll review the script as soon as possible.\n\nAlso, my colleague is already working with Duncan Rogoff from your team, which is why I wanted to check whether you have any other creators who might be interested in participating in this campaign.";

test("\"we'll review the script\" is never a script approval (fotor-will-review-script-nov20)", () => {
  const x = applyTextGuards({ from_role: 'brand', event: 'script_approved', needs_reply: false }, { text: fotor });
  assert.equal(x.event, 'brand_reply');
});

test('a promise to review is told apart from a real approval', () => {
  assert.equal(reviewPromiseOnly("We'll review the script and get back to you"), true);
  assert.equal(reviewPromiseOnly('Thanks, the team will take a look at the script this week.'), true);
  assert.equal(reviewPromiseOnly('We will go over it internally.'), true);
  assert.equal(reviewPromiseOnly('We reviewed the script and it is approved, go ahead and film.'), false);
  assert.equal(reviewPromiseOnly("Script approved! We'll review the cut once it's ready."), false);
  assert.equal(reviewPromiseOnly('Looks great, good to go.'), false);
  assert.equal(reviewPromiseOnly('Thanks for the update.'), false);
});

test('a real approval that also mentions a later review stays script_approved', () => {
  const x = applyTextGuards({ from_role: 'brand', event: 'script_approved' }, { text: "The script is approved. We'll review the draft video when you send it." });
  assert.equal(x.event, 'script_approved');
});
