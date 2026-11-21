// Harsh's own board (HARSH - NOOCAP IP, the old Cindy board) uses its own statuses (SCRIPTING, TO FILM, TO EDIT, READY,
// POSTED), so the Notion automation that pings an editor on the creator boards ("7- In Edit") never fires for it
// (Harsh, Nov 21: "I want to send a video to edit to Prabal"). The heartbeat does it instead: a row at TO EDIT with an
// editor and no EDIT TRACKER row is sent to the same n8n editor ping the other boards use, once.
import { notion } from './notion.js';
import { DS } from './tools.js';

export const HARSH_DS = '340508e9-9dda-80ae-9625-000b82f42207';
export const EDIT_STATUSES = ['TO EDIT'];
const PING = () => process.env.N8N_EDITOR_PING || 'https://n8n-production-cd10f.up.railway.app/webhook/noocap-editor-ping';

const statusOf = (p) => p?.properties?.Status?.status?.name || p?.properties?.Status?.select?.name || '';
const editorOf = (p) => p?.properties?.Editor?.select?.name || '';
export const wantsEditor = (p) => EDIT_STATUSES.includes(statusOf(p)) && !!editorOf(p);

async function tracked(pageId) {
  const id = String(pageId).replace(/-/g, '');
  const r = await notion('POST', `/data_sources/${DS.tracker}/query`, { page_size: 1, filter: { property: 'Video ID', rich_text: { equals: id } } });
  return (r.results || []).length > 0;
}

export async function harshBoardToEditors({ dry = false } = {}) {
  const r = await notion('POST', `/data_sources/${HARSH_DS}/query`, { page_size: 50, filter: { property: 'Status', status: { equals: 'TO EDIT' } } });
  const sent = [];
  for (const p of (r.results || []).filter(wantsEditor)) {
    if (await tracked(p.id)) continue;
    const title = (p.properties?.IDEA?.title || []).map((t) => t.plain_text).join('') || 'Untitled video';
    const { claimOnce } = await import('./briefs.js');
    if (!dry && !(await claimOnce(`Editor ping · ${p.id}`, 24 * 30).catch(() => false))) continue;
    if (!dry) {
      const res = await fetch(PING(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: p }) });
      if (!res.ok) throw new Error(`editor ping ${res.status} for ${title}`);
    }
    sent.push(`${title} → ${editorOf(p)}`);
  }
  return sent;
}
