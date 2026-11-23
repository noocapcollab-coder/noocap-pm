// Rule 75 (Emergent x Chris, Nov 22-23): a fully executed agreement the brand sends back is filed, never turned into a
// "read it and sign it yourself" WhatsApp card or a "we'll sign it" contract_ack to the brand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractToWhatsApp } from '../lib/inbox.js';

const pdf = (filename) => ({ filename, mimeType: 'application/pdf', data: 'JVBERi0xLjQK' });

test('a fully executed agreement from the brand sends no sign-it card and no contract ack', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('offline in tests'); };
  try {
    const email = {
      from: 'Karan <karan@emergent.sh>', subject: 'Re: Emergent x Chris', threadId: 't-emergent', messageId: '<m1@emergent.sh>',
      date: new Date().toISOString(),
      text: 'Hi team, please find the fully executed agreement attached for your records. Billing details: Emergent Labs Inc, 1 Market St.',
      attachments: [pdf('Emergent_Chris_Agreement.pdf')],
    };
    const deal = { id: 'd1', brand: 'Emergent', creator: 'Chris', brandEmail: 'karan@emergent.sh', threadId: 't-emergent' };
    const out = await contractToWhatsApp(email, { from_role: 'brand' }, deal);
    assert.match(out, /fully signed copy filed/);
    assert.doesNotMatch(out, /to WhatsApp|contract ack/);
    assert.ok(!calls.some((u) => /graph\.facebook\.com/.test(u)), 'no WhatsApp call');
  } finally { globalThis.fetch = real; }
});
