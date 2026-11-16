import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickApproved, writable } from '../lib/cardclean.js';

const p = (t) => ({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: t }, plain_text: t }] } });
const toggle = (t) => ({ type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: t }, plain_text: t }] }, has_children: true });
const page = (t, id) => ({ type: 'child_page', id, child_page: { title: t } });

test('the newest script sub-page is the approved one (Tripo 3D: Script, then UPDATED SCRIPT)', () => {
  const top = [p('[HOOK] old inline'), toggle('📋 Brief update 2026-10-09'), page('Script', 'a'), toggle('📋 Brand feedback'), page('UPDATED SCRIPT', 'b'), toggle('📋 Brief update 2026-11-02')];
  assert.equal(pickApproved(top).page.id, 'b');
});
test('with no script sub-page the card text is the script, without brief, feedback or reminders', () => {
  const top = [{ type: 'quote', quote: { rich_text: [{ type: 'text', text: { content: '⏰ Script promised' }, plain_text: '⏰ Script promised' }] } }, p('[HOOK] hi'), toggle('📋 Brief update'), p('[CTA] go')];
  assert.deepEqual(pickApproved(top).inline.map((b) => b.paragraph.rich_text[0].plain_text), ['[HOOK] hi', '[CTA] go']);
});
test('blocks are rewritten without read-only fields', () => {
  const w = writable({ id: 'x', type: 'paragraph', has_children: false, paragraph: { rich_text: [{ type: 'text', text: { content: 'hi' }, plain_text: 'hi', annotations: { bold: true }, href: null }], color: 'default' } });
  assert.deepEqual(w, { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'hi' }, annotations: { bold: true } }], color: 'default' } });
  assert.equal(writable({ type: 'child_page', child_page: { title: 'x' } }), null);
});
