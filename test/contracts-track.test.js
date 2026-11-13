// Contracts that were missed on Nov 13 (CapCut x Lindsay in noocapcollab, Panda Security x Chris in Chris's inbox):
// both must be recognised as contracts to sign, and our signed copy going back must close them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractIn } from '../lib/inbox.js';
import { isFullySigned, signedCopyIn, briefLines, ageDays } from '../lib/contracttrack.js';

const pdf = (filename) => ({ filename, mimeType: 'application/pdf', data: 'JVBERi0xLjQK' });

test('CapCut x Lindsay contract (Nov 12) is a contract to sign', () => {
  const email = { from: 'Sophie Wilson <sophie.wilson@growmaxvalue.com>', subject: 'Re: Paid Collaboration Opportunity with CapCut🚀', text: "Great news! The brand has approved the package for three videos.\n\nI've also attached the contract to this email. Please review it, fill in all the required information, sign it, and send the completed copy back to me.", attachments: [pdf('COLLABORATION AGREEMENT CapCut -ins_20261110110751.pdf'), { filename: '3.png', mimeType: 'image/png', data: 'x' }] };
  const c = contractIn(email);
  assert.ok(c && c.files.length === 1 && /AGREEMENT/.test(c.files[0].filename));
  assert.ok(!isFullySigned(email.text, c.files));
});

test('Panda Security x Chris agreement (Nov 4, Chris inbox) is a contract to sign', () => {
  const email = { from: 'Camila Molares <camila.molares@luagroup.com>', subject: 'Re: Paid campaign with Panda Security - thechriscordero', text: 'Hi Chris, Apologies for the delay in my response, your email ended up in my spam folder! Please find the contract attached for your signature.', attachments: [pdf('Numucorp_Panda_Security_Chris_Cordero_Agreement_EN.docx.pdf')] };
  const c = contractIn(email);
  assert.ok(c && c.files.length === 1);
  assert.ok(!isFullySigned(email.text, c.files));
});

test('a fully signed copy from the brand closes the contract instead of opening a new one', () => {
  assert.ok(isFullySigned('Please find the fully executed agreement attached for your records.', []));
  assert.ok(isFullySigned('', [pdf('Agreement - countersigned.pdf')]));
  assert.ok(!isFullySigned('Please sign and return the attached agreement.', [pdf('Agreement.pdf')]));
});

test('our signed copy going back is recognised', () => {
  assert.ok(signedCopyIn({ text: 'Hi Sophie, please find the signed contract attached.', attachments: [pdf('CapCut agreement Lindsay.pdf')] }));
  assert.ok(signedCopyIn({ text: 'Attached.', attachments: [pdf('signed.pdf')] }));
  assert.ok(!signedCopyIn({ text: 'Here is the script for your review.', attachments: [pdf('Script - CapCut.pdf')] }));
  assert.ok(!signedCopyIn({ text: 'We signed off on the script.', attachments: [] }));
  // Panda x Chris, Nov 5: Chris's team forwarded the unsigned agreement to noocapcollab; that is not a signed copy
  assert.ok(!signedCopyIn({ subject: 'Fwd: Paid campaign with Panda Security - thechriscordero', to: 'noocapcollab@gmail.com', text: 'Please find the contract attached for your signature.', attachments: [pdf('Numucorp_Panda_Security_Chris_Cordero_Agreement_EN.docx.pdf')] }));
  assert.ok(!signedCopyIn({ subject: 'Re: Panda', to: 'noocapcollab@gmail.com', text: 'signed contract attached', attachments: [pdf('Agreement signed.pdf')] }));
  assert.ok(signedCopyIn({ subject: 'Re: Panda', to: 'camila.molares@luagroup.com', cc: 'noocapcollab@gmail.com', text: 'signed contract attached', attachments: [pdf('Agreement signed.pdf')] }));
});

test('morning lines say how long each contract has waited', () => {
  const now = Date.parse('2026-11-14T04:00:00Z');
  const lines = briefLines([{ title: 'CapCut × Lindsay', received: '2026-11-12T00:27:00Z', status: 'Needs signing', deadline: '2026-11-27' }, { title: 'Panda Security × Chris', received: '2026-11-14T01:00:00Z', status: 'Sent to creator' }], now);
  assert.equal(lines[0], 'CapCut × Lindsay · waiting 2 days · brand deadline 2026-11-27');
  assert.equal(lines[1], 'Panda Security × Chris · waiting since today · with the creator');
  assert.equal(ageDays('2026-11-12T00:27:00Z', now), 2);
});
