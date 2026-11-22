import test from 'node:test';
import assert from 'node:assert/strict';
import { stillNeedsFolders } from '../lib/drive.js';

// AI Learns · CLADUE ANIMATIONS got "Drive folders ready" in Discord at 22:05 and again at 22:15 UTC on Nov 21: the
// board snapshot was stale, so the card whose links were written at 22:05 still looked empty at 22:15. The heartbeat
// now checks the live card before making folders and posting again.
const url = (u) => ({ type: 'url', url: u });
const page = (props) => ({ id: 'p1', properties: props });

test('a card whose Edited Vid link is already on the live page needs no folders', () => {
  const live = page({ 'Edited Vid': url('https://drive.google.com/drive/folders/1MYTvpZBwlpt11i-aJf0tumrx8omSP0tF'), Assets: url('') });
  assert.equal(stillNeedsFolders({ title: 'CLADUE ANIMATIONS' }, live), false);
});

test('a card whose live page is still empty needs folders', () => {
  const live = page({ 'Edited Vid': url(null), Assets: url(null) });
  assert.equal(stillNeedsFolders({ title: 'X' }, live), true);
});

test('a Raw Footage backfill is skipped once Raw Footage is filled, and a deleted card is skipped', () => {
  assert.equal(stillNeedsFolders({ rawOnly: 'abc' }, page({ 'Raw Footage': url('https://drive.google.com/drive/folders/abcdefghijkl') })), false);
  assert.equal(stillNeedsFolders({ rawOnly: 'abc' }, page({ 'Raw Footage': url(null) })), true);
  assert.equal(stillNeedsFolders({ title: 'X' }, { ...page({ 'Edited Vid': url(null) }), archived: true }), false);
});
