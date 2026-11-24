import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_DOWN as LEADS_DOWN } from '../api/leads.js';
import { AI_DOWN as INBOX_DOWN } from '../api/inbox.js';

// Nov 24 17:21 UTC: "Re: Quick idea for Automate AI Consulting" failed with every Gemini model busy (503 high demand).
// That says nothing about the email, so it must be retried later and never count towards giving up on it after 3 tries.
const BUSY = 'Gemini 503 (gemini-3.5-flash): { "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "status": "UNAVAILABLE" } }';
const QUOTA = 'Gemini 429 (gemini-3.5-flash): { "error": { "code": 429, "status": "RESOURCE_EXHAUSTED" } }';

test('a busy or out-of-quota Gemini is an AI outage for Leads and Inbox, never a failed try', () => {
  for (const re of [LEADS_DOWN, INBOX_DOWN]) {
    assert.ok(re.test(BUSY), 'Gemini 503 high demand');
    assert.ok(re.test(QUOTA), 'Gemini 429 quota');
    assert.ok(re.test('Gemini (gemini-3.5-flash): The operation was aborted due to timeout'), 'Gemini hung past 50s');
    assert.ok(!re.test('Gemini 400 (gemini-3.5-flash): Invalid JSON payload'), 'a bad request is still a real error');
    assert.ok(!re.test('Notion 400: validation_error on property Brand'));
  }
});
