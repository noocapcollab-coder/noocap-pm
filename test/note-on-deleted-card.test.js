// Bug hunter (Nov 19): Virash AI x Chris. The deal's card was deleted at 13:08 UTC, the brand approved the video at
// 13:18, and adding the feedback note to the deleted card threw "Can't edit block that is archived", so the whole
// approval email failed (Inbox run Partial) before the PM told anyone the brand wants it posted today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNoteToVideo } from '../lib/inbox.js';

test('a note for a deleted card is skipped instead of failing the whole email', async () => {
  const real = globalThis.fetch;
  process.env.NOTION_TOKEN = 'n';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({}), text: async () => JSON.stringify({ object: 'error', status: 400, code: 'validation_error', message: "Can't edit block that is archived. You must unarchive the block before editing." }) }; };
  try {
    const r = await addNoteToVideo('https://www.notion.so/41c508e99dda81df8f5febb6e62c47e8', 'Brand feedback', ['approved']);
    assert.equal(r, 'card deleted');
    assert.equal(calls, 1);
    // any other Notion error still surfaces
    globalThis.fetch = async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({}), text: async () => '{"message":"body failed validation"}' });
    await assert.rejects(() => addNoteToVideo('https://www.notion.so/41c508e99dda81df8f5febb6e62c47e8', 'x', ['y']), /validation/);
  } finally { globalThis.fetch = real; }
});
