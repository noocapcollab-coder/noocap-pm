// Changes the PM can make in Notion. Nothing is written until a person confirms.
// Flow: propose_update (tool) -> signed proposal shown with Confirm/Cancel -> executeProposal on confirm.
import crypto from 'node:crypto';
import { notion, plain, titleOf } from './notion.js';
import { BOARDS, DS, todayIST } from './tools.js';

const lc = (s) => String(s ?? '').toLowerCase().trim();
const MAX_PAGES = 10;
const TTL_MS = 60 * 60 * 1000; // a proposal can be confirmed for 1 hour

export const CREATOR_KEY = (s) => {
  const k = lc(s);
  if (k.startsWith('valer')) return 'valeri';
  if (k.startsWith('david')) return 'david iya';
  if (k.startsWith('emtech')) return 'emtech';
  return k;
};

// Where each kind of thing lives
function sourcesFor(target, creator) {
  switch (target) {
    case 'video':
      return BOARDS.filter((b) => !creator || CREATOR_KEY(b.creator) === CREATOR_KEY(creator)).map((b) => ({ ds: b.ds, label: b.creator + ' board', creator: b.creator }));
    case 'intake': return [{ ds: DS.intake, label: 'Video Intake', filterCreator: creator }];
    case 'deal': return [{ ds: DS.deals, label: 'Brand Deals', filterCreator: creator }];
    case 'revenue': return [{ ds: DS.revenue, label: 'Sponsor Video Revenue', filterCreator: creator }];
    default: return [];
  }
}

// Properties the PM must never touch
const BLOCKED = /thread id|message id|deal id|log id|memory id|^data$|video page id|board|change id/i;
const WRITABLE = ['select', 'status', 'checkbox', 'date', 'number', 'rich_text', 'url', 'email', 'title'];

// ---------- schema ----------
const schemaCache = new Map();
export async function schemaOf(ds) {
  const hit = schemaCache.get(ds);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.props;
  const res = await notion('GET', `/data_sources/${ds}`);
  schemaCache.set(ds, { at: Date.now(), props: res.properties || {} });
  return res.properties || {};
}

const ALIASES = {
  status: ['status', 'deal stage'],
  stage: ['deal stage', 'status'],
  editor: ['editor'],
  'post date': ['post date', 'post due'],
  'post due': ['post due', 'post date'],
  posted: ['posted at'],
  paid: ['paid'],
  'cut collected': ['cut collected'],
  amount: ['amount usd', 'final rate usd', 'invoice amount'],
  rate: ['final rate usd'],
  note: ['notes'],
  notes: ['notes'],
  'next action': ['next action'],
  'next action date': ['next action date'],
};

export function findProp(schema, wanted) {
  const w = lc(wanted);
  const entries = Object.entries(schema).filter(([name, p]) => WRITABLE.includes(p.type) && !BLOCKED.test(name));
  if ((w === 'status' || w === 'stage') && schema['Deal Stage']) return ['Deal Stage', schema['Deal Stage']];
  const exact = entries.find(([n]) => lc(n) === w);
  if (exact) return exact;
  for (const alias of ALIASES[w] || []) {
    const hit = entries.find(([n]) => lc(n) === alias);
    if (hit) return hit;
  }
  if (/^(title|name|rename)$/.test(w)) { const t = entries.find(([, p]) => p.type === 'title'); if (t) return t; }
  const partial = w.length >= 3 ? entries.filter(([n, p]) => p.type !== 'title' && lc(n).includes(w)) : [];
  if (partial.length === 1) return partial[0];
  if (w.includes('post') && w.includes('date')) {
    const d = entries.find(([n, p]) => p.type === 'date' && lc(n).includes('post'));
    if (d) return d;
  }
  return null;
}

// ---------- value conversion ----------
function toDate(v) {
  if (v === null || v === '' || lc(v) === 'none' || lc(v) === 'clear') return null;
  const s = lc(v);
  const base = new Date(todayIST() + 'T00:00:00Z');
  if (s === 'today') return todayIST();
  if (s === 'tomorrow') return new Date(base.getTime() + 864e5).toISOString().slice(0, 10);
  if (s === 'yesterday') return new Date(base.getTime() - 864e5).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, String(v).length > 10 ? 25 : 10);
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`"${v}" is not a date. Use YYYY-MM-DD.`);
}

function matchOption(options, v) {
  const names = options.map((o) => o.name);
  const w = lc(v);
  const exact = names.find((n) => lc(n) === w);
  if (exact) return exact;
  const num = parseInt(w, 10);
  if (!Number.isNaN(num) && /^\d+$/.test(w)) {
    const byNum = names.filter((n) => parseInt(n, 10) === num);
    if (byNum.length === 1) return byNum[0];
  }
  const contains = names.filter((n) => lc(n).includes(w));
  if (contains.length === 1) return contains[0];
  const words = names.filter((n) => lc(n).replace(/^\d+-\s*/, '') === w);
  if (words.length === 1) return words[0];
  throw new Error(`"${v}" is not an option. Options: ${names.join(', ')}`);
}

export function buildValue(prop, value) {
  switch (prop.type) {
    case 'select': {
      if (value === null || value === '') return { select: null };
      return { select: { name: matchOption(prop.select?.options || [], value) } };
    }
    case 'status': return { status: { name: matchOption(prop.status?.options || [], value) } };
    case 'checkbox': return { checkbox: value === true || /^(true|yes|y|1|done|tick|ticked|checked)$/i.test(String(value)) };
    case 'date': { const d = toDate(value); return { date: d ? { start: d } : null }; }
    case 'number': {
      if (value === null || value === '') return { number: null };
      const n = Number(String(value).replace(/[$,₹\s]/g, ''));
      if (Number.isNaN(n)) throw new Error(`"${value}" is not a number`);
      return { number: n };
    }
    case 'rich_text': return { rich_text: value ? [{ type: 'text', text: { content: String(value).slice(0, 1900) } }] : [] };
    case 'title': return { title: [{ type: 'text', text: { content: String(value).slice(0, 200) } }] };
    case 'url': return { url: value ? String(value) : null };
    case 'email': return { email: value ? String(value) : null };
    default: throw new Error('Cannot change this kind of field');
  }
}

const show = (v) => (v === null || v === undefined || v === '' ? '(empty)' : v === true ? 'yes' : v === false ? 'no' : String(v));
function displayNew(propPayload) {
  const [type, val] = Object.entries(propPayload)[0];
  if (val === null) return '(empty)';
  if (type === 'select' || type === 'status') return val.name;
  if (type === 'date') return val.start;
  if (type === 'rich_text' || type === 'title') return val.map((t) => t.text.content).join('') || '(empty)';
  return show(val);
}

// ---------- finding pages ----------
async function findPages(target, search, creator) {
  const sources = sourcesFor(target, creator);
  if (!sources.length) throw new Error(`Unknown target "${target}". Use video, intake, deal or revenue.`);
  const found = [];
  for (const src of sources) {
    const schema = await schemaOf(src.ds);
    const titleName = Object.entries(schema).find(([, p]) => p.type === 'title')?.[0];
    const body = { page_size: 25 };
    if (search) body.filter = { property: titleName, title: { contains: search } };
    const res = await notion('POST', `/data_sources/${src.ds}/query`, body);
    for (const page of res.results || []) {
      if (page.in_trash) continue;
      if (src.filterCreator) {
        const c = Object.entries(page.properties || {}).find(([n]) => lc(n) === 'creator');
        if (c && CREATOR_KEY(plain(c[1])) !== CREATOR_KEY(src.filterCreator)) continue;
      }
      found.push({ page, schema, src });
    }
  }
  return found;
}

// ---------- signing ----------
const secret = () => process.env.PM_ACTION_SECRET || crypto.createHash('sha256').update('pm-actions:' + (process.env.NOTION_TOKEN || '')).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + mac;
}
export function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) throw new Error('Bad confirmation token');
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) throw new Error('Confirmation token was tampered with');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (Date.now() > data.exp) throw new Error('This change expired. Ask again.');
  return data;
}

// ---------- the tool ----------
export async function proposeUpdate({ target, search, creator, changes = {}, append_note, apply_to_all = false }) {
  if (!search && !apply_to_all) return { error: 'Say which item to change (part of its title or brand name).' };
  const hits = await findPages(target, search, creator);
  if (!hits.length) return { error: `Nothing found in ${target} matching "${search}"${creator ? ' for ' + creator : ''}.` };
  if (hits.length > 1 && !apply_to_all) {
    return {
      needs_choice: true,
      message: `${hits.length} items match "${search}". Ask the user which one, or retry with a more exact title.`,
      matches: hits.slice(0, 12).map(({ page, src }) => ({ title: titleOf(page), where: src.label, status: plain(Object.entries(page.properties).find(([n]) => /^(status|deal stage)$/i.test(n))?.[1]) || null })),
    };
  }
  if (hits.length > MAX_PAGES) return { error: `That would change ${hits.length} items. The limit is ${MAX_PAGES} at once.` };

  const pages = [];
  const lines = [];
  for (const { page, schema, src } of hits) {
    const props = {};
    const title = titleOf(page);
    for (const [field, value] of Object.entries(changes || {})) {
      const found = findProp(schema, field);
      if (!found) return { error: `"${field}" is not a field I can change on ${src.label}. Fields: ${Object.entries(schema).filter(([n, p]) => WRITABLE.includes(p.type) && !BLOCKED.test(n)).map(([n]) => n).join(', ')}` };
      const [name, prop] = found;
      try {
        props[name] = buildValue(prop, value);
      } catch (e) {
        return { error: `${name}: ${e.message}` };
      }
      const before = show(plain(page.properties?.[name]));
      const after = displayNew(props[name]);
      if (before === after) { delete props[name]; continue; }
      lines.push(`${title} (${src.label}): ${name} ${before} → ${after}`);
    }
    if (append_note) {
      const noteEntry = Object.entries(schema).find(([n, p]) => p.type === 'rich_text' && /^notes$/i.test(n)) || Object.entries(schema).find(([n, p]) => p.type === 'rich_text' && /note/i.test(n));
      if (!noteEntry) return { error: `${src.label} has no Notes field.` };
      const [name] = noteEntry;
      const old = plain(page.properties?.[name]) || '';
      const stamp = todayIST();
      const text = (old ? old + '\n' : '') + `[${stamp}] ${append_note}`;
      props[name] = { rich_text: [{ type: 'text', text: { content: text.slice(-1900) } }] };
      lines.push(`${title} (${src.label}): add note "${append_note}"`);
    }
    if (Object.keys(props).length) pages.push({ id: page.id, title, where: src.label, properties: props });
  }
  if (!pages.length) return { nothing_to_change: true, message: 'Those values are already set. Nothing to change.' };

  const summary = lines.join('\n');
  const token = sign({ pages, summary, exp: Date.now() + TTL_MS });
  return {
    proposal: { token, summary },
    note_for_you: 'NOT DONE YET. The user now sees Confirm and Cancel buttons. Tell them in one short line what will change and that it happens when they confirm. Do not say it is done.',
  };
}

export async function executeProposal(token) {
  const data = verify(token);
  const done = [];
  const failed = [];
  for (const p of data.pages || []) {
    try {
      await notion('PATCH', `/pages/${p.id}`, { properties: p.properties });
      done.push(p);
    } catch (e) {
      failed.push({ title: p.title, error: String(e.message).slice(0, 200) });
    }
  }
  for (const c of data.creates || []) {
    try {
      const { placeCard } = await import('./briefs.js');
      const schema = await schemaOf(c.ds);
      const titleName = Object.keys(schema).find((n) => schema[n].type === 'title');
      const page = await placeCard({ ds: c.ds, schema, titleName, props: { ...c.properties }, body: c.children || [] });
      done.push({ title: c.title, url: page?.url });
    } catch (e) {
      failed.push({ title: c.title, error: String(e.message).slice(0, 200) });
    }
  }
  const links = done.filter((d) => d.url).map((d) => `[Open ${d.title} in Notion](${d.url})`);
  return { summary: data.summary + (links.length ? '\n' + links.join('\n') : ''), done, failed };
}


// ---------- creating a new video card ----------
export function briefBlocks(text) {
  const blocks = [];
  const rt = (t) => {
    const out = [];
    for (let i = 0; i < t.length; i += 1900) out.push({ type: 'text', text: { content: t.slice(i, i + 1900) } });
    return out;
  };
  blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: rt('Brief') } });
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^#{1,3}\s+(.*)$/))) blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt(m[1]) } });
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(m[1]) } });
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rt(m[1]) } });
    else blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(line) } });
    if (blocks.length >= 95) break;
  }
  return blocks;
}

export async function proposeCreate({ creator, title, brief, fields = {} }) {
  if (!creator) return { error: 'Which creator board should the video go on?' };
  if (!title || !String(title).trim()) return { error: 'The video needs a title.' };
  const board = BOARDS.find((b) => CREATOR_KEY(b.creator) === CREATOR_KEY(creator));
  if (!board) return { error: `No board for "${creator}". Boards: ${BOARDS.map((b) => b.creator).join(', ')}` };
  const schema = await schemaOf(board.ds);
  const titleName = Object.entries(schema).find(([, p]) => p.type === 'title')?.[0];
  const cleanTitle = String(title).trim().slice(0, 200);

  // stop accidental duplicates
  const dupe = await notion('POST', `/data_sources/${board.ds}/query`, { page_size: 5, filter: { property: titleName, title: { equals: cleanTitle } } });
  if ((dupe.results || []).some((p) => !p.in_trash)) return { error: `"${cleanTitle}" already exists on ${board.creator}'s board. Use propose_update to change it instead.` };

  const properties = { [titleName]: { title: [{ type: 'text', text: { content: cleanTitle } }] } };
  const lines = [`New video on ${board.creator}'s board: "${cleanTitle}"`];
  const wanted = { ...fields };
  const statusProp = findProp(schema, 'status');
  if (statusProp && !Object.keys(wanted).some((k) => /status|stage/i.test(k))) {
    const opts = statusProp[1].select?.options || statusProp[1].status?.options || [];
    const first = opts.find((o) => parseInt(o.name, 10) === 1);
    if (first) wanted.status = first.name;
  }
  for (const [field, value] of Object.entries(wanted)) {
    if (value === undefined || value === null || value === '') continue;
    const found = findProp(schema, field);
    if (!found) return { error: `"${field}" is not a field on ${board.creator}'s board. Fields: ${Object.entries(schema).filter(([n, p]) => WRITABLE.includes(p.type) && !BLOCKED.test(n) && p.type !== 'title').map(([n]) => n).join(', ')}` };
    const [name, prop] = found;
    if (prop.type === 'title') continue;
    try { properties[name] = buildValue(prop, value); } catch (e) { return { error: `${name}: ${e.message}` }; }
    lines.push(`${name}: ${displayNew(properties[name])}`);
  }

  let children = [];
  const briefText = brief ? String(brief).trim().slice(0, 12000) : '';
  if (briefText) {
    const briefProp = Object.entries(schema).find(([n]) => lc(n) === 'brief');
    if (/^https?:\/\/\S+$/.test(briefText) && briefProp && briefProp[1].type === 'url') {
      properties[briefProp[0]] = { url: briefText };
      lines.push(`Brief link: ${briefText}`);
    } else if (briefProp && briefProp[1].type === 'rich_text' && briefText.length <= 1900) {
      properties[briefProp[0]] = { rich_text: [{ type: 'text', text: { content: briefText } }] };
      lines.push(`Brief: ${briefText.slice(0, 160)}${briefText.length > 160 ? '…' : ''}`);
    } else {
      children = briefBlocks(briefText);
      lines.push(`Brief written into the page (${briefText.split(/\s+/).length} words): ${briefText.slice(0, 160).replace(/\n/g, ' ')}${briefText.length > 160 ? '…' : ''}`);
    }
  }
  const summary = lines.join('\n');
  const token = sign({ creates: [{ ds: board.ds, title: cleanTitle, properties, children }], summary, exp: Date.now() + TTL_MS });
  return {
    proposal: { token, summary },
    note_for_you: 'NOT CREATED YET. The user sees Confirm and Cancel. If you wrote the brief yourself, show the full brief in your reply so they can read it before confirming. Do not say it is done.',
  };
}

export const CREATE_TOOL = {
  name: 'propose_create',
  description: 'Add a new video card to a creator board with its title and brief. Use when the user asks to add, create or plan a video. If the user gives only an idea, write a clear brief yourself (hook, key points, call to action, references) unless they asked for the title only. A brief given as a link goes in the Brief link field; text goes into the page body. Status defaults to "1- Idea Assigned" unless the user says otherwise. Optional fields like post date, type (SPONSOR / PERSONAL), editor, format, priority. Nothing is created until the user taps Confirm.',
  input_schema: {
    type: 'object',
    properties: {
      creator: { type: 'string', description: 'Brad, Chris, Lindsay, Emtech, Duncan, Valeri, David Iya or Nicole' },
      title: { type: 'string', description: 'Video title' },
      brief: { type: 'string', description: 'The brief as text (can use lines, "- " bullets and "## " headings) or a link to a brief doc' },
      fields: { type: 'object', description: 'Other fields, e.g. {"post date": "2026-10-02", "type": "SPONSOR", "editor": "Prateek", "status": "4"}', additionalProperties: true },
    },
    required: ['creator', 'title'],
  },
};

export const PROPOSE_TOOL = {
  name: 'propose_update',
  description: 'Change something in Notion when the user asks: a video status, editor or post date on a creator board (target "video"), a Video Intake row (target "intake": Status, Editor, Post Due, Posted At, Revisions, Priority), a brand deal (target "deal": Deal Stage, Paused, Needs Check, Next Action, Next Action Date, Final Rate USD, Deadline, Invoice Amount, Invoice Sent Date, Invoice Due Date, Paid Date, Posted Links), or a sponsor revenue row (target "revenue": Paid, Cut Collected, Payment Received, Amount USD). Nothing is written until the user taps Confirm. Values can be loose ("changes", "8", "tomorrow", "yes"); they are matched to the real options.',
  input_schema: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['video', 'intake', 'deal', 'revenue'] },
      search: { type: 'string', description: 'Part of the video title or brand name' },
      creator: { type: 'string', description: 'Creator, to narrow the search' },
      changes: { type: 'object', description: 'Field name → new value, e.g. {"status": "8- Changes", "post date": "2026-09-30"} or {"paused": true}', additionalProperties: true },
      append_note: { type: 'string', description: 'Add a dated line to the Notes field' },
      apply_to_all: { type: 'boolean', description: 'Change every match (max 10). Only when the user clearly asked for all of them.' },
    },
    required: ['target'],
  },
};
