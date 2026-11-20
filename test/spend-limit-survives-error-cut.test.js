import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../lib/claude.js';
import { spendLimitAlert } from '../lib/pause.js';
import { AI_DOWN } from '../api/inbox.js';

// Bug hunter, Nov 20: a7d8009 appended Claude's reason AFTER Gemini's 429 body, but api/inbox.js and api/leads.js cut
// every error to 300 characters before recordError, so "usage limits" never reached spendLimitAlert. From 04:54 to
// 07:12 UTC about 30 Inbox and Leads runs failed this way and Harsh never got the "Anthropic spend limit" alert (rule 66),
// although Claude was blocked until Dec 1.
test('the Anthropic spend limit survives the 300-character error cut and still raises the alert', async () => {
  const realFetch = globalThis.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  const geminiBody = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. '.repeat(2), status: 'RESOURCE_EXHAUSTED' } }, null, 2);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."},"request_id":"req_011"}', { status: 400 });
    if (u.includes('generativelanguage.googleapis.com')) return new Response(geminiBody, { status: 429 });
    return new Response('{}', { status: 200 });
  };
  try {
    let err;
    try { await callModel({ model: 'claude-haiku', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
    assert.ok(err, 'should throw');
    const msg = String(err.message).slice(0, 300); // exactly what api/inbox.js and api/leads.js hand to recordError
    assert.ok(AI_DOWN.test(msg), 'the email is retried, not given up on');
    let sent = '';
    assert.equal(await spendLimitAlert(msg, async (m) => { sent = m; }), true, 'the spend-limit alert fires');
    assert.match(sent, /console\.anthropic\.com/);
    assert.match(msg, /Gemini 429/, 'Gemini failing is still shown');
  } finally {
    globalThis.fetch = realFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  }
});
