// PM · Status history. Every time a video's Status changes on a creator board (or in Video Intake), one row goes into
// the STATUS HISTORY database: from, to, when, who was editing and how long it sat in the previous status.
//
// This used to be a separate n8n workflow that re-read every board from Notion every 5 minutes. Now the board sync
// (api/boards.js) already sees every card that changed each minute and hands them here, so no extra reading is needed.
// The latest history row of a card is the memory of its last status, so nothing is logged twice.
import { notion } from './notion.js';

export const HISTORY_DS = '713e41de-cf62-45b1-8652-bc2f2ad6ea7f';
const EDITORS = ['Abhishek', 'Prateek', 'Sumith', 'Prabal', 'Parvez'];
const SCRIPTWRITER = 'Shreya';
const ALIASES = { brad: 'Brad', chris: 'Chris', lindsay: 'Lindsay', emtech: 'Emtech', duncan: 'Duncan', valeri: 'Valeri', valerie: 'Valeri', david: 'David Iya', 'david iya': 'David Iya', nicole: 'Nicole', 'nicole mccain': 'Nicole', dmytro: 'Dmytro' };

const rt = (s) => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];
function findProp(props, test) { for (const [n, p] of Object.entries(props || {})) if (test(n.toLowerCase().trim(), p)) return p; return null; }
function textOf(p) {
  if (!p) return '';
  if (p.type === 'title') return (p.title || []).map((t) => t.plain_text).join('').trim();
  if (p.type === 'rich_text') return (p.rich_text || []).map((t) => t.plain_text).join('').trim();
  if (p.type === 'select') return p.select?.name || '';
  if (p.type === 'status') return p.status?.name || '';
  if (p.type === 'multi_select') return (p.multi_select || []).map((o) => o.name).join(', ');
  if (p.type === 'people') return (p.people || []).map((u) => u.name || '').join(', ');
  return '';
}

function readCard(page, board) {
  const props = page.properties || {};
  const title = textOf(findProp(props, (n, p) => p.type === 'title')) || 'Untitled';
  let status = textOf(findProp(props, (n, p) => n === 'status' && (p.type === 'select' || p.type === 'status')));
  if (board.intake && !status) status = 'In Review'; // a fresh form submission means "ready for review"
  const editorRaw = textOf(findProp(props, (n, p) => n === 'editor' && ['select', 'multi_select', 'people', 'rich_text'].includes(p.type)) ||
    findProp(props, (n, p) => n.includes('editor') && !n.includes('thread') && ['select', 'multi_select', 'people', 'rich_text'].includes(p.type)));
  const editor = EDITORS.find((e) => editorRaw.toLowerCase().includes(e.toLowerCase())) || '';
  const dateProp = board.intake ? findProp(props, (n, p) => p.type === 'date' && n === 'post due')
    : findProp(props, (n, p) => p.type === 'date' && n.includes('post') && n.includes('date')) || findProp(props, (n, p) => p.type === 'date' && n.includes('post'));
  const creator = board.intake ? (ALIASES[textOf(findProp(props, (n) => n === 'creator')).toLowerCase().trim()] || '') : (ALIASES[String(board.creator).toLowerCase()] || board.creator);
  const frameio = findProp(props, (n, p) => p.type === 'url' && n.includes('frame'))?.url || null;
  const ct = textOf(findProp(props, (n) => n === 'content type')).toUpperCase();
  let sponsor = false;
  for (const [name, p] of Object.entries(props)) {
    const n = name.toLowerCase();
    if ((n === 'type' || n.includes('sponsor')) && /sponsor/i.test(textOf(p))) sponsor = true;
    if (p.type === 'checkbox' && n.includes('sponsor') && p.checkbox) sponsor = true;
  }
  return { id: page.id, url: page.url, title, status, editor, postDate: dateProp?.date?.start || null, sponsor, creator, frameio,
    contentType: ct.includes('LONG') ? 'LONG-FORM' : ct.includes('SHORT') ? 'SHORT-FORM' : '', edited: page.last_edited_time, created: page.created_time };
}

export function stageOf(status) {
  const s = (status || '').toLowerCase().trim();
  const intake = { assigned: 'Editing', editing: 'Editing', 'in review': 'Review', changes: 'Review', 'to post': 'Ready', posted: 'Posted' };
  if (intake[s]) return intake[s];
  const num = parseInt(s, 10);
  if (s.includes('archive') || num === 13) return 'Archived';
  if (s.includes('scheduled')) return 'Ready';
  if (s.includes('idea bank')) return 'Scripting';
  if (Number.isNaN(num)) return null;
  return num <= 5 ? 'Scripting' : num === 6 ? 'Filming' : num === 7 ? 'Editing' : num <= 9 ? 'Review' : num <= 11 ? 'Ready' : num === 12 ? 'Posted' : null;
}

// The card's last logged status, or null if it has never been logged
async function lastRow(pageId) {
  const r = await notion('POST', `/data_sources/${HISTORY_DS}/query`, { page_size: 1, filter: { property: 'Video Page ID', rich_text: { equals: pageId } }, sorts: [{ property: 'Changed At', direction: 'descending' }] });
  const p = (r.results || [])[0];
  if (!p) return null;
  return { status: textOf(p.properties?.['To Status']), at: p.properties?.['Changed At']?.date?.start };
}

// Same card and edit already looked at by this instance: skip the Notion check
const checked = new Map();

// pages: raw Notion pages that changed since the last sync, each with its board ({ creator, ds, intake? })
export async function logStatusChanges(items) {
  let logged = 0;
  for (const { page, board, old } of items) {
    if (page.in_trash || page.archived) continue;
    if (checked.get(page.id) === page.last_edited_time) continue;
    const v = readCard(page, board);
    if (!v.status) continue;
    const prev = await lastRow(v.id);
    checked.set(page.id, page.last_edited_time);
    if (prev && prev.status === v.status) continue; // edited, but the status didn't change
    // No history row yet: the sync's previous copy of the card still knows what its status was a minute ago
    const before = !prev && old ? readCard(old, board).status : null;
    if (before && before === v.status) { checked.set(page.id, page.last_edited_time); continue; }
    if (before) { await write(board, v, before, null); logged++; continue; }
    // A card the history has never seen and we can't tell its old status: a new card is logged as new, an old one
    // gets a "(first seen)" starting row (reports skip those) so its next change has something to compare against
    if (!prev && Date.now() - Date.parse(v.created) > 864e5) {
      await write(board, v, '(first seen)', null);
      logged++;
      continue;
    }
    const hours = prev?.at ? Math.round(((Date.parse(v.edited) - Date.parse(prev.at)) / 36e5) * 10) / 10 : null;
    await write(board, v, prev ? prev.status : board.intake ? '(intake form)' : '(new card)', hours);
    logged++;
  }
  if (checked.size > 5000) checked.clear();
  return logged;
}

async function write(board, v, fromStatus, hours) {
  const properties = {
    Video: { title: rt(v.title) }, 'Changed At': { date: { start: v.edited } }, 'From Status': { rich_text: rt(fromStatus) },
    'To Status': { rich_text: rt(v.status) }, Sponsor: { checkbox: !!v.sponsor }, 'Video Page ID': { rich_text: rt(v.id) },
    'Video Link': { url: v.url || null }, Board: { rich_text: rt(board.ds) }, Source: { select: { name: board.intake ? 'Video Intake' : 'Creator board' } },
  };
  if (v.creator) properties.Creator = { select: { name: v.creator } };
  if (v.frameio) properties['Frame.io Link'] = { url: v.frameio };
  if (v.contentType) properties['Content Type'] = { select: { name: v.contentType } };
  const stage = stageOf(v.status);
  if (stage) properties['To Stage'] = { select: { name: stage } };
  if (v.editor) properties.Editor = { select: { name: v.editor } };
  if (!board.intake && [4, 5].includes(parseInt(v.status, 10))) properties.Scriptwriter = { select: { name: SCRIPTWRITER } };
  if (hours !== null && hours !== undefined && Number.isFinite(hours)) properties['Hours In Previous'] = { number: hours };
  if (v.postDate) properties['Post Date'] = { date: { start: v.postDate } };
  await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: HISTORY_DS }, properties });
}
