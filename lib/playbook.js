// PM Playbook: NOOCAP's standard answers, how we handle each common brand situation, and example replies, written
// from our real emails. Lives as a Notion page (NOOCAP MASTER SYSTEM → PM Playbook) so Harsh can read and edit it.
// The PM only uses it once the page's first line says "Status: Live"; edits are picked up within 10 minutes.
import { notion } from './notion.js';

export const PLAYBOOK_PAGE = process.env.PLAYBOOK_PAGE || '400508e9-9dda-81a7-a3aa-f386cc94117d';
const MAX_CHARS = 14000; // about 3.5k tokens, enough for the whole playbook without crowding the email itself
let mem = null;

const textOf = (b) => (b[b.type]?.rich_text || []).map((t) => t.plain_text).join('');
async function blocks(id, depth = 0) {
  const lines = [];
  let cursor;
  do {
    const r = await notion('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    for (const b of r.results || []) {
      const t = textOf(b);
      const pre = /^heading_/.test(b.type) ? '#'.repeat(Number(b.type.slice(-1)) + 1) + ' ' : /list_item|to_do/.test(b.type) ? '- ' : b.type === 'quote' ? '> ' : '';
      if (t.trim()) lines.push('  '.repeat(depth) + pre + t);
      if (b.has_children && depth < 2 && b.type !== 'child_page' && b.type !== 'child_database') lines.push(...(await blocks(b.id, depth + 1)));
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return lines;
}

// The playbook text, or '' while it's still a draft (or unreadable: drafting never fails because of it)
export async function playbook() {
  if (mem && Date.now() - mem.at < 10 * 60e3) return mem.text;
  let text = '';
  try {
    const lines = await blocks(PLAYBOOK_PAGE);
    const live = /status:\s*live/i.test(lines.slice(0, 3).join(' '));
    text = live ? lines.filter((l) => !/^status:/i.test(l.trim())).join('\n').slice(0, MAX_CHARS) : '';
  } catch (e) { console.error('playbook read failed', e.message); text = mem?.text || ''; }
  mem = { at: Date.now(), text };
  return text;
}
