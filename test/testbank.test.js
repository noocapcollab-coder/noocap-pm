import test from 'node:test';
import assert from 'node:assert/strict';
import { validCase, gateReason, compare, slugId, rowToCase, GATE_GAP_MIN } from '../lib/testbank.js';

test('a case needs a real email and something to check', () => {
  assert.equal(validCase({ email: { text: '' }, expect: { event: 'brief' } }), false);
  assert.equal(validCase({ email: { text: 'hi' }, expect: {} }), false);
  assert.equal(validCase({ email: { text: 'hi' }, expect: { not_stage: 'Paid' } }), true);
  assert.equal(validCase({ kind: 'Writer', email: { text: 'hi' }, expect: {} }), false);
  assert.equal(validCase({ kind: 'Writer', email: { text: 'hi' }, expect: { lesson: { never: 'promise dates' } } }), true);
});

test('gate runs after a new commit or a new lesson, not twice in a row', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const ago = (m) => new Date(now - m * 60000).toISOString();
  assert.equal(gateReason({ last: null, commit: 'abc1234', lessonAt: '', now }), 'commit');
  assert.equal(gateReason({ last: { at: ago(60), commit: 'abc1234', lessonAt: ago(500) }, commit: 'def5678', lessonAt: ago(500), now }), 'commit');
  assert.equal(gateReason({ last: { at: ago(GATE_GAP_MIN.commit - 5), commit: 'abc1234', lessonAt: '' }, commit: 'def5678', lessonAt: '', now }), null);
  assert.equal(gateReason({ last: { at: ago(60), commit: 'abc1234', lessonAt: ago(500) }, commit: 'abc1234', lessonAt: ago(500), now }), null);
  assert.equal(gateReason({ last: { at: ago(200), commit: 'abc1234', lessonAt: ago(500) }, commit: 'abc1234', lessonAt: ago(100), now }), 'lesson');
  assert.equal(gateReason({ last: { at: ago(60), commit: 'abc1234', lessonAt: ago(500) }, commit: 'abc1234', lessonAt: ago(30), now }), null);
});

test('a case that passed before and fails now is a regression; one that never passed is still broken', () => {
  const cases = [{ id: 'a', everPassed: true, last: 'Pass' }, { id: 'b', everPassed: false, last: 'Not run' }, { id: 'c', everPassed: true, last: 'Fail' }, { id: 'd', everPassed: true, last: 'Pass' }];
  const results = [{ id: 'a', fails: ['x'] }, { id: 'b', fails: ['y'] }, { id: 'c', fails: [] }, { id: 'd', fails: ['z'], error: true }];
  const r = compare(cases, results);
  assert.deepEqual(r.regressions.map((x) => x.id), ['a']);
  assert.deepEqual(r.stillBroken.map((x) => x.id), ['b']);
  assert.deepEqual(r.fixed.map((x) => x.id), ['c']);
});

test('case rows read back with their JSON data split across text pieces', () => {
  const json = JSON.stringify({ email: { text: 'x'.repeat(2500) }, expect: { event: 'brief' } });
  const p = { id: 'p1', created_time: '2026-11-13', properties: {
    Case: { type: 'title', title: [{ plain_text: 'weglot-x' }] }, Kind: { type: 'select', select: { name: 'Reader' } },
    Data: { type: 'rich_text', rich_text: [{ plain_text: json.slice(0, 1900) }, { plain_text: json.slice(1900) }] },
    Active: { type: 'checkbox', checkbox: true }, 'Ever Passed': { type: 'checkbox', checkbox: false } } };
  const c = rowToCase(p);
  assert.equal(c.email.text.length, 2500);
  assert.equal(c.expect.event, 'brief');
  assert.equal(slugId('Runway AI · payment queue!'), 'runway-ai-payment-queue');
});

test('test bank calls go to free Gemini only inside the bank run', async () => {
  const G = await import('../lib/gemini.js');
  process.env.GEMINI_API_KEY = 'k';
  try {
    assert.equal(G.geminiFirst(), false);
    assert.equal(G.freeOnly.run(true, () => G.geminiFirst()), true);
  } finally { process.env.GEMINI_API_KEY = ''; }
});
