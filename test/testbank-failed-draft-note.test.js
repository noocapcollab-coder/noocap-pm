import test from 'node:test';
import assert from 'node:assert/strict';
import { resultNote } from '../lib/testbank.js';

test('a failing writer case keeps the draft that failed in its Last Note', () => {
  const note = resultNote({ fails: ['repeats the mistake: promises to post right away'], got: 'Hi Mia,\n\nWe are publishing it immediately.\n\nBest,\nChris\'s Team' });
  assert.match(note, /repeats the mistake/);
  assert.match(note, /draft: "Hi Mia, We are publishing it immediately\./);
});

test('a passing case keeps the short ok note, and a fail with no draft has no empty draft part', () => {
  assert.equal(resultNote({ fails: [], got: 'Hi there' }), 'ok (Hi there)');
  assert.equal(resultNote({ fails: ['wrote nothing'], got: '' }), 'wrote nothing');
});
