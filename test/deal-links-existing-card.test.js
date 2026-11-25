import test from 'node:test';
import assert from 'node:assert/strict';
import { cardToLink } from '../lib/heartbeat.js';

// PM LESSONS "A deal past the brief always has a video card" (Harsh, Nov 17; seen again Nov 22): Panda Security x Chris
// and ZenBusiness x Lindsay had their cards on the board (PANDA SECURITY at 7, ZEN UGC 1-3) but the deals' Linked Video
// was empty, so the heartbeat sent Harsh a "brief received but no video card" alert instead of linking the card it
// could see. Now the heartbeat links the deal's own card and only alerts when there is none.
const c = (id, num, created) => ({ id, url: `https://www.notion.so/${id}`, title: 'X', num, status: `${num}- x`, created });
const deal = { id: 'd1', brand: 'ZenBusiness', creator: 'Lindsay', stage: 'Brief Received', linkedVideo: '' };

test('the earliest live card of the deal is linked', () => {
  const cards = [c('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 6, '2026-11-10T00:00:00Z'), c('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, '2026-11-09T00:00:00Z')];
  assert.equal(cardToLink(cards, deal, [deal])?.id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('a card already linked to another deal is never taken', () => {
  const other = { id: 'd2', brand: 'ZenBusiness', creator: 'Lindsay', stage: 'Posted', linkedVideo: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const cards = [c('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, '2026-11-09T00:00:00Z')];
  assert.equal(cardToLink(cards, deal, [deal, other]), null);
});

test('a posted card (last campaign) is history, not this deal\'s card', () => {
  assert.equal(cardToLink([c('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 12, '2026-11-01T00:00:00Z')], deal, [deal]), null);
});

test('no card on the board means the alert still goes', () => {
  assert.equal(cardToLink([], deal, [deal]), null);
});
