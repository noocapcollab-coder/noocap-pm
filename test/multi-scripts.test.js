import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDealCardTitle, cardScriptOwed } from '../lib/heartbeat.js';
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
