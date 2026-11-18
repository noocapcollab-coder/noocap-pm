// Bug hunter (Nov 18): sentRecently counted a billing ask still held in Approvals as gone, so the Invoices step's
// "already went" check stamped Billing Request Sent on Emergent x Chris and CapCut x Chris though nothing was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentRecently, templateBlock } from '../lib/replytemplates.js';

const mock = (status) => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: status ? [{ id: 'd', properties: { Status: { select: { name: status } } } }] : [] }), text: async () => '' });
};
const t = { active: true, stages: ['Approved'], days: 0 };

test('a template copy held in Approvals blocks a second copy but never reads as "already went"', async () => {
  mock('Draft');
  const s = await sentRecently('ds', 'T1', 'billing_on_approval');
  const why = templateBlock(t, { stage: 'Approved', today: '2026-11-18', sentRecently: s });
  assert.ok(why, 'still blocked');
  assert.ok(!/already went/.test(why), why);
});

test('a template copy that was sent reads as "already went"', async () => {
  mock('Sent');
  const s = await sentRecently('ds', 'T1', 'billing_on_approval');
  assert.match(templateBlock(t, { stage: 'Approved', today: '2026-11-18', sentRecently: s }), /already went/);
  mock(null);
  assert.equal(await sentRecently('ds', 'T1', 'billing_on_approval'), false);
});
