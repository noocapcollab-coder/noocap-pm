// Drive folders for videos. When a card reaches 6- To Film, the PM makes:
//   <Root> / <Creator> / <MONTH> / <Video title> / Assets         (anyone with the link can view)
//                                               / Edited Videos  (anyone with the link can edit)
// and writes the links back to the card (Assets field + Edited Vid field).
// Google Drive is reached through the n8n "PM · Drive" workflow, which holds the Google login.
import { notion, queryAll, plain, titleOf, clearCache } from './notion.js';
import { BOARDS, DS, todayIST, LATE_WINDOW } from './tools.js';

const FOLDER = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const MAX_PER_RUN = 4;
const lc = (s) => String(s || '').toLowerCase().trim();
const norm = (s) => lc(s).replace(/[^a-z0-9]+/g, '');
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

export const rootFolderId = () => {
  const v = String(process.env.DRIVE_ROOT_FOLDER || '').trim();
  return (v.match(/folders\/([\w-]{10,})/) || v.match(/^([\w-]{10,})$/) || [])[1] || null;
};

async function drive(method, path, body) {
  const hook = process.env.N8N_DRIVE_WEBHOOK;
  if (!hook) throw new Error('N8N_DRIVE_WEBHOOK is not set in Vercel.');
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hook-secret': process.env.PM_HOOK_SECRET || '' },
    body: JSON.stringify({ method, url: API + path, body: body || null }),
  });
  let j = {};
  try { j = await res.json(); } catch { /* empty */ }
  if (!res.ok || j.ok === false) throw new Error('Drive: ' + (j.error || `n8n returned ${res.status}`));
  return j.data ?? j;
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

async function listFolders(parent) {
  const query = encodeURIComponent(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`);
  const r = await drive('GET', `/files?q=${query}&fields=files(id,name,webViewLink)&pageSize=200&${ALL}`);
  return r.files || [];
}

async function createFolder(parent, name) {
  return drive('POST', `/files?fields=id,name,webViewLink&${ALL}`, { name, mimeType: FOLDER, parents: [parent] });
}

// Find a folder whose name matches (case and punctuation ignored), else create it
async function ensureFolder(parent, name, match) {
  const kids = await listFolders(parent);
  const hit = kids.find(match || ((f) => norm(f.name) === norm(name)));
  return hit || createFolder(parent, name);
}

async function shareAnyone(id, role) {
  try { await drive('POST', `/files/${id}/permissions?${ALL}`, { role, type: 'anyone' }); return true; } catch { return false; }
}

// Card fields we write to
function fieldsOf(page) {
  let assets = null, edited = null, month = null, raw = null;
  for (const [name, p] of Object.entries(page.properties || {})) {
    const n = lc(name);
    if ((n === 'assets' || n === 'asset') && (p.type === 'rich_text' || p.type === 'url') && !assets) assets = [name, p.type, plain(p)];
    if (/^edited ?vid/.test(n) && (p.type === 'url' || p.type === 'rich_text')) edited = [name, p.type, plain(p)];
    if (/^raw ?footage/.test(n) && (p.type === 'url' || p.type === 'rich_text')) raw = [name, p.type, plain(p)];
    if (n === 'month' && p.type === 'select') month = p.select?.name || null;
  }
  return { assets, edited, month, raw };
}
const val = (type, url) => (type === 'url' ? { url } : { rich_text: [{ type: 'text', text: { content: url, link: { url } } }] });

// MONTH tabs like SEPTEMBER, SEPT-OCT, AUGUST-SEPT count as current if they mention this month or next month
export function isCurrentMonthTab(label, today = todayIST()) {
  const m = Number(today.slice(5, 7)) - 1;
  const want = [MONTHS[m], MONTHS[(m + 1) % 12]].map((x) => x.slice(0, 3));
  return String(label).toUpperCase().split(/[^A-Z]+/).some((t) => want.some((w) => t.startsWith(w)));
}

// Which cards need folders: status 6 to 11, has a title, no links yet, not a stale old card
export async function cardsNeedingFolders() {
  const today = todayIST();
  const stale = new Date(new Date(today + 'T00:00:00Z').getTime() - LATE_WINDOW * 864e5).toISOString().slice(0, 10);
  const out = [];
  for (const b of BOARDS) {
    let pages = [];
    try { pages = await queryAll(b.ds, undefined, { useCache: false }); } catch { continue; }
    for (const page of pages) {
      const status = Object.entries(page.properties || {}).find(([n, p]) => lc(n) === 'status' && (p.type === 'select' || p.type === 'status'));
      const num = parseInt(plain(status?.[1]) || '', 10);
      // Only cards that are at To Film now, or moved past it in the last 2 days. Old cards that were already
      // further along before this feature existed are left alone.
      const fresh = Date.now() - new Date(page.last_edited_time || 0).getTime() < 2 * 864e5;
      if (!(num === 6 || (num >= 7 && num <= 11 && fresh))) continue;
      const title = titleOf(page);
      if (!title || title === 'Untitled') continue;
      const f = fieldsOf(page);
      if (!f.edited && !f.assets && !f.raw) continue;  // board has nowhere to put the links
      const postDate = Object.entries(page.properties).find(([n, p]) => p.type === 'date' && /post/i.test(n))?.[1]?.date?.start || null;
      const dueDate = Object.entries(page.properties).find(([n, p]) => p.type === 'date' && /due/i.test(n))?.[1]?.date?.start || null;
      // A card still being worked on counts even when its post date slipped into the past: a due date coming up,
      // or someone touched the card this week. Only untouched old backlog is skipped.
      const active = (dueDate && dueDate.slice(0, 10) >= stale) || Date.now() - new Date(page.last_edited_time || 0).getTime() < 7 * 864e5;
      if (postDate && postDate.slice(0, 10) < stale && !active) continue;
      // Old backlog: skip unless the MONTH tab is this/next month or the post date is coming up
      if (f.month && !isCurrentMonthTab(f.month) && !(postDate && postDate.slice(0, 10) >= stale) && !active) continue;
      const hasLinks = (f.edited && f.edited[2]) || (f.assets && /drive\.google/.test(f.assets[2] || ''));
      if (hasLinks) {
        // folders exist already; only the Raw Footage link (the video folder) is missing
        const src = (f.edited && driveId(f.edited[2])) || (f.assets && driveId(f.assets[2]));
        if (f.raw && !f.raw[2] && src) out.push({ page, title, creator: b.creator, fields: f, rawOnly: src });
        continue;
      }
      if (!f.edited && f.assets && f.assets[2]) continue;
      out.push({ page, title, creator: b.creator, month: f.month, fields: f, postDate });
    }
  }
  return out;
}

const driveId = (u) => (String(u || '').match(/folders\/([\w-]{10,})/) || [])[1] || null;
const folderLink = (id) => `https://drive.google.com/drive/folders/${id}`;

// Card already has Assets / Edited Video links: fill Raw Footage with their parent (the video folder)
async function fillRawFootage({ page, title, creator, fields, rawOnly }) {
  const r = await drive('GET', `/files/${rawOnly}?fields=parents&${ALL}`);
  const parent = r.parents?.[0];
  if (!parent) throw new Error('could not find the video folder');
  await notion('PATCH', `/pages/${page.id}`, { properties: { [fields.raw[0]]: val(fields.raw[1], folderLink(parent)) } });
  return { title, creator, folder: folderLink(parent), rawOnly: true };
}

export async function makeVideoFolders(card) {
  if (card.rawOnly) return fillRawFootage(card);
  const { page, title, creator, month, fields, postDate } = card;
  const root = rootFolderId();
  if (!root) throw new Error('DRIVE_ROOT_FOLDER is not set in Vercel.');
  const monthName = month || MONTHS[Number((postDate || todayIST()).slice(5, 7)) - 1];
  const ck = norm(creator).slice(0, 4);
  const creatorF = await ensureFolder(root, creator, (f) => norm(f.name).startsWith(ck) || norm(f.name).includes(norm(creator)));
  const monthF = await ensureFolder(creatorF.id, monthName, (f) => norm(f.name).includes(norm(monthName)) || norm(f.name) === norm(monthName).slice(0, 3));
  const videoF = await ensureFolder(monthF.id, title.slice(0, 120));
  const assetsF = await ensureFolder(videoF.id, 'Assets');
  const editedF = await ensureFolder(videoF.id, 'Edited Videos');
  const shared = (await shareAnyone(assetsF.id, 'reader')) && (await shareAnyone(editedF.id, 'writer'));
  const link = (f) => f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`;

  const props = {};
  // never overwrite something the team already typed
  if (fields.assets && !fields.assets[2]) props[fields.assets[0]] = val(fields.assets[1], link(assetsF));
  if (fields.edited && !fields.edited[2]) props[fields.edited[0]] = val(fields.edited[1], link(editedF));
  if (fields.raw && !fields.raw[2]) props[fields.raw[0]] = val(fields.raw[1], link(videoF));
  if (Object.keys(props).length) await notion('PATCH', `/pages/${page.id}`, { properties: props });
  return { title, creator, month: monthName, folder: link(videoF), assets: link(assetsF), edited: link(editedF), shared };
}

// Called from the heartbeat
export async function runDriveFolders() {
  if (!process.env.N8N_DRIVE_WEBHOOK || !rootFolderId()) return { skipped: 'Drive not set up' };
  const todo = (await cardsNeedingFolders()).slice(0, MAX_PER_RUN);
  const made = [], errors = [];
  for (const c of todo) {
    try { made.push(await makeVideoFolders(c)); } catch (e) { errors.push(`${c.creator} · ${c.title}: ${String(e.message).slice(0, 150)}`); }
  }
  if (made.length) clearCache();
  // one AGENT LOG line per run that did something, so the Flow tab can show this automation's health
  if (made.length || errors.length) {
    const rt = (x) => [{ type: 'text', text: { content: String(x).slice(0, 1900) } }];
    try {
      await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: DS.agentLog }, properties: {
        Event: { title: rt(made.length ? `Drive folders: ${made.map((m) => m.title).join(', ')}`.slice(0, 120) : 'Drive folders failed') },
        Time: { date: { start: new Date().toISOString() } }, Area: { select: { name: 'Drive' } },
        Outcome: { select: { name: errors.length && !made.length ? 'Error' : 'Rule' } }, Source: { select: { name: 'Schedule' } },
        Model: { select: { name: 'None' } }, Details: { rich_text: rt([...made.map((m) => `${m.creator} · ${m.title}: ${m.rawOnly ? 'Raw Footage link added ' + m.folder : m.edited}`), ...errors].join('\n')) },
      } });
    } catch { /* logging is best-effort */ }
  }
  return { made, errors };
}
