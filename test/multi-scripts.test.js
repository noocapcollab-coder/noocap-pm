import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDealCardTitle, cardScriptOwed, hexId } from '../lib/heartbeat.js';
import { scriptCardUrls } from '../lib/outbox.js';
import { buildMime } from '../lib/mime.js';

test('cards of one deal are recognised by name', () => {
  assert.ok(isDealCardTitle('CapCut × Lindsay', 'CapCut', 'Lindsay'));
  assert.ok(isDealCardTitle('CapCut × Lindsay (2)', 'CapCut', 'Lindsay'));
  assert.ok(isDealCardTitle('CapCut x Lindsay #3', 'CapCut', 'Lindsay'));
  assert.ok(isDealCardTitle('Teamily AI × David (2)', 'Teamily AI', 'David Iya'));
  assert.ok(!isDealCardTitle('CapCut tips for beginners', 'CapCut', 'Lindsay'));
  assert.ok(!isDealCardTitle('CapCut × Chris', 'CapCut', 'Lindsay'));
});

const now = Date.parse('2026-11-16T10:00:00Z');
const card = (id, extra = {}) => ({ id, title: 'CapCut × Lindsay', num: 5, edited: '2026-11-16T09:00:00Z', ...extra });

test('a card at 5 is owed unless its script went or is waiting', () => {
  const covered = new Set(['416508e99dda81d484edcdcfc625b1e1']);
  assert.equal(cardScriptOwed(card('416508e9-9dda-81d4-84ed-cdcfc625b1e1'), { covered, now }), false);
  assert.equal(cardScriptOwed(card('416508e9-9dda-8156-9ac7-df4572c40c97'), { covered, now }), true);
  assert.equal(cardScriptOwed(card('416508e9-9dda-8156-9ac7-df4572c40c97', { num: 4 }), { covered, now }), false);
  // sat at 5 for weeks: old news
  assert.equal(cardScriptOwed(card('416508e9-9dda-8156-9ac7-df4572c40c97', { edited: '2026-10-20T00:00:00Z' }), { covered, now }), false);
  // Harsh sent the script himself (no PM email), after the card last changed
  assert.equal(cardScriptOwed(card('416508e9-9dda-8156-9ac7-df4572c40c97', { edited: '2026-11-15T09:00:00Z' }), { covered: new Set(), scriptSent: '2026-11-15', now }), false);
});

test('a Script email lists every card it carries, once', () => {
  const a = 'https://www.notion.so/416508e99dda81d484edcdcfc625b1e1', b = 'https://www.notion.so/416508e99dda81569ac7df4572c40c97';
  assert.deepEqual(scriptCardUrls({ video: a, context: `Script cards: ${a} ${b}\nother notes` }), [a, b]);
  assert.deepEqual(scriptCardUrls({ video: a, context: '' }), [a]);
});

test('an email can carry several PDFs', () => {
  const raw = Buffer.from(buildMime({ to: 'a@b.com', subject: 's', text: 't', html: 'h', attachment: [{ filename: '1.pdf', mimeType: 'application/pdf', data: 'QQ==' }, { filename: '2.pdf', mimeType: 'application/pdf', data: 'Qg==' }] }), 'base64url').toString();
  assert.match(raw, /filename="1\.pdf"/);
  assert.match(raw, /filename="2\.pdf"/);
});

test('a card id is read right from a link with a number in its title', () => {
  assert.equal(hexId('https://app.notion.com/p/CapCut-Lindsay-2-416508e99dda81569ac7df4572c40c97'), '416508e99dda81569ac7df4572c40c97');
  assert.equal(hexId('https://app.notion.com/p/CapCut-Lindsay-3-416508e99dda812caddee2f535c11ff7'), '416508e99dda812caddee2f535c11ff7');
  assert.equal(hexId('416508e9-9dda-8156-9ac7-df4572c40c97'), '416508e99dda81569ac7df4572c40c97');
});

import { scriptsAlreadySent } from '../lib/outbox.js';
import { pageIdOf } from '../lib/notion.js';

// The real rows of Nov 16: scripts 2 and 3 had gone at 21:14 UTC, the 21:54 email must be stopped
const c1 = 'https://app.notion.com/p/CapCut-Lindsay-416508e99dda81d484edcdcfc625b1e1';
const c2 = 'https://app.notion.com/p/CapCut-Lindsay-2-416508e99dda81569ac7df4572c40c97';
const c3 = 'https://app.notion.com/p/CapCut-Lindsay-3-416508e99dda812caddee2f535c11ff7';
const sent = [{ video: c1, context: `Script cards: ${c1} ${c2} ${c3}`, sentAt: '2026-11-15T21:14:00.000Z' }];

test('the same scripts never go to the brand twice', () => {
  assert.ok(scriptsAlreadySent([c2, c3].map(pageIdOf), sent));
  assert.ok(scriptsAlreadySent(['416508e9-9dda-8156-9ac7-df4572c40c97'].map(pageIdOf), sent));
  // a card whose script never went is sent
  assert.equal(scriptsAlreadySent([pageIdOf('https://app.notion.com/p/CapCut-Lindsay-4-416508e99dda81aaaaaaaaaaaaaaaaaaaa')], sent), null);
  assert.equal(scriptsAlreadySent([pageIdOf(c2)], []), null);
});

test('every link shape gives the same card id', () => {
  const id = '416508e99dda81569ac7df4572c40c97';
  for (const u of [c2, `${c2}?pvs=204`, 'https://www.notion.so/416508e99dda81569ac7df4572c40c97', '416508e9-9dda-8156-9ac7-df4572c40c97', 'https://app.notion.com/p/416508e99dda81569ac7df4572c40c97#abc']) assert.equal(pageIdOf(u), id, u);
});
