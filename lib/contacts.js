// Brand Contacts: the key that says who a brand email address speaks for and which creators it handles.
// One row per address (rajeshwari@jeevmedia.net → Tripo 3D → Lindsay). An agency that runs deals for several
// creators gets several creators on one row and the Agency tick.
//
// The PM checks this before letting an email land on a deal: a contact can only move a deal of a creator it is known
// to handle, unless the thread itself or a creator's own address/handle on the email says otherwise.
// Rows are learned automatically from confirmed brand emails, and can be edited by hand in Notion (Source: Manual).
import { notion, queryAll, plain } from './notion.js';

export const CONTACTS_DS = process.env.CONTACTS_DS || 'c932778f-b0e2-4523-88de-17fb073f5bff';
const OURS = String(process.env.CREATOR_DOMAINS || 'buildroom.ai:Duncan,chriscordero.net:Chris,valchy.ai:Valeri,automateaiconsulting.com:Lindsay')
  .split(',').map((p) => p.split(':')[0].trim().toLowerCase()).filter(Boolean);
const lc = (s) => String(s || '').toLowerCase().trim();
export const addrOf = (s) => lc((String(s || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '');
const ourSide = (a) => { const d = a.split('@')[1] || ''; return /noocapcollab@/i.test(a) || OURS.some((x) => d === x || d.endsWith('.' + x)); };
const rt = (t) => [{ type: 'text', text: { content: String(t || '').slice(0, 1900) } }];
const today = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

let mem = null;
export async function loadContacts({ fresh = false } = {}) {
  if (!fresh && mem && Date.now() - mem.at < 5 * 60e3) return mem.map;
  const rows = await queryAll(CONTACTS_DS, undefined, { useCache: false });
  const map = new Map();
  let seeded = false;
  for (const p of rows) {
    const g = (n) => plain(p.properties?.[n]);
    if (g('Email') === SEED_MARK) { seeded = true; continue; }
    const email = addrOf(g('Email'));
    if (!email) continue;
    map.set(email, {
      id: p.id, url: p.url, email, brand: g('Brand') || '',
      creators: (p.properties?.Creators?.multi_select || []).map((o) => o.name),
      agency: g('Agency') === true, source: g('Source') || 'Auto', lastSeen: g('Last Seen'),
    });
  }
  map.seeded = seeded;
  mem = { at: Date.now(), map };
  return map;
}

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail|gmx|zoho)\./i;
// Who this sender speaks for: their own row (exact), else everyone known at the same company domain (not free mail).
// Returns { exact, creators, brand, rows } or null when nobody from there is known yet.
export async function contactOf(from) {
  const a = addrOf(from);
  if (!a || ourSide(a)) return null;
  let map;
  try { map = await loadContacts(); } catch { return null; }
  const row = map.get(a);
  if (row) return { exact: true, creators: row.creators, brand: row.brand, rows: [row] };
  const dom = a.split('@')[1] || '';
  if (!dom || FREE_MAIL.test(dom)) return null;
  const rows = [...map.values()].filter((r) => r.email.split('@')[1] === dom);
  if (!rows.length) return null;
  return { exact: false, creators: [...new Set(rows.flatMap((r) => r.creators))], brand: rows[0].brand, rows };
}
export const handles = (contact, creator) => !!contact && !!creator && contact.creators.some((c) => lc(c) === lc(creator));

// Remember that this address spoke for `brand` on a `creator` deal. Only call it once ownership is confirmed
// (same thread as the deal, or the creator's own address/handle on the email): learning from a guess would teach
// the key the same mistake it exists to stop.
export async function learnContact({ from, brand, creator, note }) {
  const a = addrOf(from);
  if (!a || !creator || ourSide(a)) return null;
  const map = await loadContacts();
  const row = map.get(a);
  const day = today();
  if (row) {
    const props = {};
    const has = row.creators.some((c) => lc(c) === lc(creator));
    if (!has) {
      const creators = [...row.creators, creator];
      props.Creators = { multi_select: creators.map((name) => ({ name })) };
      if (creators.length > 1) props.Agency = { checkbox: true };
      row.creators = creators;
    }
    if (!row.brand && brand) { props.Brand = { rich_text: rt(brand) }; row.brand = brand; }
    if (row.lastSeen !== day) { props['Last Seen'] = { date: { start: day } }; row.lastSeen = day; }
    if (Object.keys(props).length) await notion('PATCH', `/pages/${row.id}`, { properties: props });
    return row;
  }
  const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: CONTACTS_DS }, properties: {
    Email: { title: rt(a) }, Brand: { rich_text: rt(brand || '') }, Creators: { multi_select: [{ name: creator }] },
    Source: { select: { name: 'Auto' } }, 'Last Seen': { date: { start: day } }, ...(note ? { Notes: { rich_text: rt(note) } } : {}),
  } });
  const fresh = { id: page.id, url: page.url, email: a, brand: brand || '', creators: [creator], agency: false, source: 'Auto', lastSeen: day };
  map.set(a, fresh);
  return fresh;
}

// First run: build the key from the deals and leads we already have (brand email + creator on each row).
// Works through them a batch at a time across heartbeats, then leaves a marker row so it never runs again
// (after that only confirmed emails and hand edits change the key).
const SEED_MARK = '(seeded from deals and leads, keep this row)';
export async function seedContacts({ deals = [], leads = [], batch = 40 } = {}) {
  const map = await loadContacts({ fresh: true });
  if (map.seeded) return { seeded: 0, done: true };
  const pairs = [];
  for (const d of deals) if (d.brandEmail && d.creator) pairs.push({ from: d.brandEmail, brand: d.brand, creator: d.creator, note: 'Seeded from Deals' });
  for (const l of leads) if (l.brandEmail && l.creator && !['Lost', 'Not a fit'].includes(l.status)) pairs.push({ from: l.brandEmail, brand: l.brand, creator: l.creator, note: 'Seeded from Leads' });
  const todo = pairs.filter((p) => { const r = map.get(addrOf(p.from)); return !r || !r.creators.some((c) => lc(c) === lc(p.creator)); });
  let n = 0;
  for (const p of todo.slice(0, batch)) { try { if (await learnContact(p)) n++; } catch { /* keep going */ } }
  if (todo.length <= batch) {
    await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: CONTACTS_DS }, properties: { Email: { title: rt(SEED_MARK) }, Source: { select: { name: 'Auto' } }, Notes: { rich_text: rt('Marks that the first build from Deals and Leads is finished.') } } });
    map.seeded = true;
  }
  return { seeded: n, done: map.seeded, remaining: Math.max(0, todo.length - batch) };
}
