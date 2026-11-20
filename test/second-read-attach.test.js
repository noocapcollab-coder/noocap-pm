// Nov 19 (21:55 and 22:55 UTC): the second reader never saw that script emails get their PDF at send time, so it
// flagged "says attached but no file is attached" and held Runway AI x Chris and CapCut x Lindsay scripts that should
// have gone on their own. A missing-attachment flag on an email that carries a file is dropped (bug hunter).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropAttachedFileFlags, attachLabel } from '../lib/outbox.js';

const flags = [
  'The email mentions a script is "attached" but no file is attached to the draft.',
  'The email says "Please find the revised scripts... attached" but there are no attachments.',
  'Does not attach the script mentioned in the body.',
  'Does not answer: the brand asked for the posting date.',
];

test('a Script PDF email drops the missing-attachment flags and keeps the rest', () => {
  assert.deepEqual(dropAttachedFileFlags(flags, { attach: 'Script PDF' }), ['Does not answer: the brand asked for the posting date.']);
});

test('a Send File counts as a file too', () => {
  assert.equal(dropAttachedFileFlags([flags[0]], { attach: 'None', sendFile: [{ name: 'cover.png' }] }).length, 0);
});

test('an email with no file keeps the flag, so a fake "attached" is still held', () => {
  assert.deepEqual(dropAttachedFileFlags([flags[0]], { attach: 'None' }), [flags[0]]);
});

test('the reader is told the file goes on when it sends', () => {
  assert.match(attachLabel({ attach: 'Script PDF' }), /Script PDF \(attached automatically/);
  assert.equal(attachLabel({ attach: 'None' }), 'none');
});
