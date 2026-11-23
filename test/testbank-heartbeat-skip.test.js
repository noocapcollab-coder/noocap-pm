// Bug hunter Nov 23: the nightly test bank scored a payment chase the heartbeat never drafts (gamut-lindsay-chase-
// without-live-link-nov20 reported as broken on Nov 22), because runWriter skipped the heartbeat's liveLinkOwed gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatSkip } from '../lib/testbank.js';

const gamut = {
  kind: 'Writer',
  email: { from: 'iddo.gino@gamut.so', text: 'Hi team,\n\nSure, here are our billing details for the invoice:\n\nPlease send the invoice for the second payment to\niddo.gino@gamut.so together with the live link, and we\'ll get it paid.\n\nThanks!\nIddo' },
  deal: { brand: 'Gamut', creator: 'Lindsay' },
  expect: { kind: 'Payment chase' },
};

test('a writer case the heartbeat would never draft is not scored (Gamut x Lindsay live link)', () => {
  assert.match(heartbeatSkip(gamut), /live link/);
  assert.equal(heartbeatSkip({ ...gamut, deal: { ...gamut.deal, linksSent: '2026-11-21' } }), '', 'links already sent: the chase is real');
  assert.equal(heartbeatSkip({ ...gamut, expect: { kind: 'Reply' } }), '', 'only payment chases');
  assert.equal(heartbeatSkip({ ...gamut, email: { text: 'Hi, invoice received, paying Friday.' } }), '');
  assert.equal(heartbeatSkip({}), '');
});
