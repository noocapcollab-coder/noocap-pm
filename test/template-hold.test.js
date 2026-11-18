// Bug hunter (Nov 18): a fixed reply (Reply Templates) with Harsh's own "as soon as possible" line was stamped
// "Needs you: it promises to send something later" by createDraft, so autoHoldReason held it in Approvals and the
// billing ask on approval never sent on its own (Emergent x Chris 14:47 UTC, CapCut x Chris 12:17 UTC).
import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockNotion(calls) {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method, body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (String(url).includes('/query')) return ok({ results: [] });
    return ok({ id: 'new-draft', properties: {} });
  };
}

const deal = { id: 'deal-1', brand: 'Emergent', creator: 'Chris', threadId: 'T1', threadSubject: 'Emergent X thechriscordero Paid Collab!', brandEmail: 'karan.v@emergent.sh', messageRfc: '<m@x>' };

test('a fixed reply with Harsh\'s "as soon as possible" line is saved without Needs you, so it can send on its own', async () => {
  const { createDraft, autoHoldReason } = await import('../lib/outbox.js');
  const { BUILT_IN } = await import('../lib/replytemplates.js');
  const body = BUILT_IN.find((t) => t.key === 'billing_on_approval').body.replace('{name}', 'Karan').replace('{creator}', 'Chris');
  const calls = [];
  mockNotion(calls);
  await createDraft({ kind: 'Reply', deal, subject: 'Re: x', body, notify: false, why: 'Fixed reply (sent by hand) [template:billing_on_approval]: Emergent × Chris' });
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pages'));
  assert.ok(create, 'draft created');
  const why = create.body.properties.Why.rich_text.map((t) => t.text?.content || '').join('');
  assert.ok(!/^Needs you/.test(why), why);
  assert.equal(autoHoldReason({ body, creator: 'Chris', why }), null);
});

test('an AI-written reply with the same line is still marked Needs you', async () => {
  const { createDraft } = await import('../lib/outbox.js');
  const calls = [];
  mockNotion(calls);
  await createDraft({ kind: 'Reply', deal, subject: 'Re: x', body: 'Hi Karan,\n\nWe\'ll get it posted as soon as possible.\n\nBest,\nChris\'s Team', notify: false, why: 'Reply to the brand' });
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pages'));
  const why = create.body.properties.Why.rich_text.map((t) => t.text?.content || '').join('');
  assert.ok(/^Needs you: .*promises to send/.test(why), why);
});
