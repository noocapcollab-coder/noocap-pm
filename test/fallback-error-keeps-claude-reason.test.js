import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../lib/claude.js';
import { SPEND_LIMIT, spendLimitAlert } from '../lib/pause.js';

// Bug hunter, Nov 20: from 00:24 UTC every Leads and Inbox run that fell back to Gemini failed with only
// "Gemini 429 ... exceeded your current quota", so nobody could see why Claude had failed, and an Anthropic spend
// limit behind it never raised the spend-limit alert (rule 66), because that alert looks for Claude's own words.
test('when Claude and the Gemini fallback both fail, the error keeps Claude\'s reason', async () => {
  const realFetch = globalThis.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}', { status: 400 });
    if (u.includes('generativelanguage.googleapis.com')) return new Response('{"error":{"code":429,"message":"You exceeded your current quota"}}', { status: 429 });
    return new Response('{}', { status: 200 });
  };
  try {
    let err;
    try { await callModel({ model: 'claude-haiku', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
    assert.ok(err, 'should throw');
    assert.match(err.message, /Gemini 429/);
    assert.match(err.message, /Claude 400/);
    assert.ok(SPEND_LIMIT.test(err.message), 'the spend-limit alert can see the Anthropic limit');
    let sent = '';
    assert.equal(await spendLimitAlert(err.message, async (m) => { sent = m; }), true);
    assert.match(sent, /spend limit/);
  } finally {
    globalThis.fetch = realFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  }
});
