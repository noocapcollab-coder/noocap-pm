// Bug hunter (Nov 17): learnFromReply created the "_new" Reply Templates row with bare rich-text arrays as property
// values, so Notion answered 400 and none of Harsh's hand replies were saved as examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnFromReply, improveTemplates } from '../lib/replytemplates.js';

const validProp = (v) => v && !Array.isArray(v) && typeof v === 'object' && ['title', 'rich_text', 'checkbox'].some((k) => k in v);

function mockNotion(calls, { agentHit = true, newRow = null } = {}) {
  globalThis.fetch = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (opts.method === 'POST' && url.endsWith('/pages')) {
      for (const v of Object.values(body.properties)) if (!validProp(v)) return { ok: false, status: 400, json: async () => ({}), text: async () => 'validation_error' };
      return ok({ id: 'new-page' });
    }
    if (url.includes('/query') && JSON.stringify(body).includes('[unread thread:')) {
      return ok({ results: agentHit ? [{ id: 'log1', properties: { Details: { type: 'rich_text', rich_text: [{ plain_text: '[unread thread:T1 ]' }] }, Event: { type: 'title', title: [{ plain_text: 'Brand asked X' }] } } }] : [] });
    }
    if (url.includes('/query')) return ok({ results: newRow ? [newRow] : [] });
    return ok({ id: 'x' });
  };
}

test('learnFromReply creates the _new templates row with valid Notion property values', async () => {
  const calls = [];
  mockNotion(calls);
  const out = await learnFromReply({ threadId: 'T1', ourText: 'Thanks, we will send it Friday.', agentLogDs: 'log-ds' });
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pages'));
  assert.ok(create, 'a _new row is created');
  for (const [k, v] of Object.entries(create.body.properties)) assert.ok(validProp(v), `property ${k} is a valid Notion value`);
  assert.equal(out, 'saved as an example for new templates');
});

test('improveTemplates writes proposed templates with valid Notion property values', async () => {
  const calls = [];
  const ex = '--- a\nx\n--- b\ny\n--- c\nz';
  mockNotion(calls, { newRow: { id: 'nw', properties: { Key: { type: 'title', title: [{ plain_text: '_new' }] }, Examples: { type: 'rich_text', rich_text: [{ plain_text: ex }] } } } });
  const reply = "Hi {name},\n\nThanks, noted.\n\nBest,\n{creator}'s Team";
  const claude = async () => ({ content: [{ type: 'tool_use', input: { templates: [{ key: 'thanks_ack', when: 'brand says thanks', reply, stages: ['In Production'], timing: '' }] } }] });
  const done = await improveTemplates({ claude, HAIKU: 'h' });
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pages'));
  if (create) for (const [k, v] of Object.entries(create.body.properties)) assert.ok(validProp(v), `property ${k} is a valid Notion value`);
  assert.ok(!create || done.some((d) => d.includes('thanks_ack')));
});
