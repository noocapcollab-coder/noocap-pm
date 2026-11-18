import { test } from 'node:test';
import assert from 'node:assert/strict';

// Vercel errors Nov 18, 16:20 and 16:24 UTC: "WhatsApp info ask failed Pratham ... template pm_needs_you not found".
// Pratham's chat was closed, so askForInfo queued the question as a pending-ask and then tried the nudge template.
// The nudge threw (template missing) before saveState, so the queued question was never saved and Pratham never got it,
// not even with the next message or the morning round-up.
function setup() {
  process.env.WA_TOKEN = 't'; process.env.WA_PHONE_ID = '1'; process.env.WA_NUMBERS = 'Pratham:919800000000';
  process.env.WA_QUIET = '0-0'; process.env.NOTION_TOKEN = 'n';
  const old = [{ role: 'user', content: 'hi', at: new Date(Date.now() - 3 * 864e5).toISOString() }];
  const box = { saved: null };
  const json = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('graph.facebook.com') && url.endsWith('/messages')) return json(404, { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } });
    if (url.includes('graph.facebook.com')) return json(200, {});
    if (url.includes('/data_sources/') && url.endsWith('/query')) return json(200, { results: [{ id: 'chat1', properties: { Data: { rich_text: [{ plain_text: JSON.stringify(box.saved || old) }] } } }] });
    if (url.includes('/pages/chat1') && opts.method === 'PATCH') {
      box.saved = JSON.parse(JSON.parse(opts.body).properties.Data.rich_text.map((t) => t.text?.content ?? '').join(''));
      return json(200, { id: 'chat1' });
    }
    return json(200, { results: [] });
  };
  return box;
}

test('a contract alert is still queued for the chat when the nudge template fails', async () => {
  const realFetch = globalThis.fetch;
  let box;
  try {
    box = setup();
    const W = await import('../lib/whatsapp.js?nudgefail2');
    await W.sendContract({ text: 'Contract from Zeely AI x Duncan', files: [] });
  } finally { globalThis.fetch = realFetch; }
  assert.ok(box.saved, 'the chat was saved');
  assert.ok(box.saved.find((m) => m.meta === 'pending-doc'), 'the contract waits in the chat');
});

test('a brand question is still queued for the chat when the nudge template fails', async () => {
  process.env.WA_TOKEN = 't'; process.env.WA_PHONE_ID = '1'; process.env.WA_NUMBERS = 'Pratham:919800000000';
  process.env.WA_QUIET = '0-0'; process.env.NOTION_TOKEN = 'n';
  const old = [{ role: 'user', content: 'hi', at: new Date(Date.now() - 3 * 864e5).toISOString() }];
  let saved = null;
  const realFetch = globalThis.fetch;
  const json = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('graph.facebook.com') && url.endsWith('/messages')) return json(404, { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } });
    if (url.includes('graph.facebook.com')) return json(200, {});
    if (url.includes('/data_sources/') && url.endsWith('/query')) return json(200, { results: [{ id: 'chat1', properties: { Data: { rich_text: [{ plain_text: JSON.stringify(saved || old) }] } } }] });
    if (url.includes('/pages/chat1') && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      saved = JSON.parse(body.properties.Data.rich_text.map((t) => t.text?.content ?? '').join(''));
      return json(200, { id: 'chat1' });
    }
    return json(200, { results: [] });
  };
  try {
    const W = await import('../lib/whatsapp.js?nudgefail');
    await W.askForInfo({ brand: 'Zeely AI', creator: 'Duncan', need: 'the ad code', theirMessage: 'Could you share the ad code?', dealId: 'deal-1' });
  } finally { globalThis.fetch = realFetch; }
  assert.ok(saved, 'the chat was saved');
  const q = saved.find((m) => m.meta === 'pending-ask');
  assert.ok(q, 'the question waits in the chat for the next message or the morning round-up');
  assert.equal(q.infoAsk?.dealId, 'deal-1');
});
