// Bug hunter Nov 22: Gamut x Lindsay. Iddo asked for the invoice "together with the live link"; only the invoice went,
// and a payment chase was drafted 3 days later (test bank gamut-lindsay-chase-without-live-link-nov20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveLinkOwed } from '../lib/heartbeat.js';

test('no payment chase while the live link the brand asked for is unsent (Gamut x Lindsay, Nov 20)', () => {
  const gamut = { linksSent: null, postedLinks: '', nextAction: 'Send Gamut the live link with the invoice', memory: '' };
  assert.equal(liveLinkOwed(gamut, 'Payment chase'), true);
  assert.equal(liveLinkOwed({ linksSent: null, postedLinks: 'https://www.instagram.com/reel/abc', nextAction: '' }, 'Payment chase'), true, 'a posted link we hold but never emailed');
  assert.equal(liveLinkOwed({ linksSent: null, memory: 'Deal memory\nOPEN NOW: Iddo wants the posted links before paying.\n' }, 'Payment chase'), true);
  assert.equal(liveLinkOwed({ ...gamut, linksSent: '2026-11-21' }, 'Payment chase'), false, 'links already sent');
  assert.equal(liveLinkOwed(gamut, 'Follow-up'), false, 'only payment chases');
  assert.equal(liveLinkOwed({ linksSent: null, postedLinks: '', nextAction: 'Waiting for payment of INV-003', memory: 'OPEN NOW: invoice unpaid' }, 'Payment chase'), false);
});
