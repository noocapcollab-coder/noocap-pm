// Brand Pool: every brand that has reached out to any NOOCAP creator, one row per brand, so a creator whose deals
// slow down can be pitched to brands that wrote to someone else. Built from Leads (offers in creators' own inboxes),
// Brand Deals and Brand Contacts. One row per email domain; free-mail senders (gmail, outlook…) get a row per address.
// No AI here: it only copies and merges what is already saved. Do Not Contact, Pitched For, Last Pitched and Notes
// belong to the team and to outreach, so this sync never writes them.
import { notion, queryAll, plain } from './notion.js';
import { DS } from './tools.js';
import { CONTACTS_DS, ourSide } from './contacts.js';

export const POOL_DS = process.env.BRAND_POOL_DS || '84c90ccb-52af-44eb-8189-a0121caeb948';
const DEALS_DS = '70d26268-6d57-4d45-abf7-a599c6f8e0f4';
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail|gmx|zoho|qq|163|126|foxmail)\./i;
const CREATORS = ['Brad', 'Chris', 'Lindsay', 'Valeri', 'Duncan', 'Emtech', 'Dmytro', 'David Iya', 'Nicole', 'AI Learns'];
// Deal stages that mean the brand actually booked the creator
const BOOKED = ['Price Agreed', 'Signed', 'Brief Received', 'Script Sent', 'Script Approved', 'In Production', 'Submitted', 'Approved', 'Posted', 'Invoiced', 'Paid'];
const RANK = { 'Paid offer': 4, Unclear: 3, Affiliate: 2, Gifted: 1 };
const lc = (s) => String(s ?? '').toLowerCase().trim();
const addrOf = (s) => lc((String(s || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '');
const day = (s) => (s ? String(s).slice(0, 10) : null);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (d) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const normBrand = (s) => lc(s).replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq|co)\b/g, '').replace(/[^a-z0-9]+/g, '');

export function creatorName(s) {
  const k = lc(s).replace(/[^a-z]/g, '');
  if (!k) return null;
  if (k.startsWith('nicole')) return 'Nicole';
  if (k === 'dymtro' || k === 'dmytro') return 'Dmytro';
  if (k.startsWith('david')) return 'David Iya';
  return CREATORS.find((c) => lc(c).replace(/[^a-z]/g, '') === k) || null;
}

// The pool key for an address: its domain, or the whole address for free mail. Null for our own side.
export function poolKey(address) {
  const a = addrOf(address);
  if (!a || ourSide(a)) return null;
  const dom = a.split('@')[1] || '';
  if (!dom) return null;
  return FREE_MAIL.test(dom) ? a : baseDomain(dom);
}
// mcn.noxinfluencer.com → noxinfluencer.com, offer.tec-do.com → tec-do.com, mail.brand.com.cn → brand.com.cn
const SLD = /^(com|co|net|org|gov|edu|ac)\.[a-z]{2}$/;
export function baseDomain(dom) {
  const parts = lc(dom).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return SLD.test(last2) ? parts.slice(-3).join('.') : last2;
}
// Placeholder brand names the inbox reader writes when it could not tell the brand
const junkBrand = (s) => !s || /^<?\s*(unknown|n\/?a|none|null|brand|unclear)\s*>?$/i.test(String(s).trim()) || /brand name (not specified|unclear)|not specified|unknown brand/i.test(String(s));

// records: [{ email, brand, creator, offerType, budget, date, booked, contactName, agency }]
// Returns Map key → pool row values (what this sync owns)
export function buildPool(records) {
  const pool = new Map();
  for (const r of records) {
    const key = poolKey(r.email);
    if (!key) continue;
    const row = pool.get(key) || { key, brands: new Map(), emails: new Set(), approached: new Set(), worked: new Set(), offerType: null, budget: 0, first: null, last: null, seen: 0, contactName: null, contactAt: '', agency: false, brandAt: '', history: [] };
    pool.set(key, row);
    if (!junkBrand(r.brand)) {
      const name = String(r.brand).trim(), n = normBrand(name);
      // "Sparkols" and "Sparkols Agency" are one brand: keep the shorter key
      const same = n && [...row.brands.keys()].find((k) => k.includes(n) || n.includes(k));
      if (n && !same) row.brands.set(n, name);
      else if (same && n.length < same.length) { row.brands.delete(same); row.brands.set(n, name); }
      if ((r.date || '') >= row.brandAt) { row.brand = name; row.brandAt = r.date || ''; }
    }
    row.emails.add(addrOf(r.email));
    const c = creatorName(r.creator);
    if (c) { row.approached.add(c); if (r.booked) row.worked.add(c); }
    for (const x of r.creators || []) { const n = creatorName(x); if (n) row.approached.add(n); }
    if (r.offerType && (RANK[r.offerType] || 0) > (RANK[row.offerType] || 0)) row.offerType = r.offerType;
    if (Number(r.budget) > row.budget) row.budget = Number(r.budget);
    const d = day(r.date);
    if (d) { if (!row.first || d < row.first) row.first = d; if (!row.last || d > row.last) row.last = d; }
    if (r.count !== false) {
      row.seen += 1;
      const money = Number(r.budget) > 0 ? ' · $' + Math.round(Number(r.budget)).toLocaleString('en-US') : '';
      row.history.push({ d: d || '', line: `${d ? fmtDay(d) : 'Date unknown'} · ${c || r.creator || '?'} · ${junkBrand(r.brand) ? 'brand unclear' : String(r.brand).trim()}${r.offerType ? ' · ' + r.offerType : ''}${money}${r.kind ? ' · ' + r.kind : ''}` });
    }
    if (r.contactName && (r.date || '') >= row.contactAt) { row.contactName = r.contactName; row.contactAt = r.date || ''; }
    if (r.agency) row.agency = true;
  }
  for (const row of pool.values()) {
    if (row.brands.size > 1) row.agency = true;
    const names = [...row.brands.values()];
    row.title = row.agency ? `${row.key} (agency)` : (row.brand || names[0] || row.key);
    row.handled = row.agency ? names.slice(0, 30).join(', ') : '';
    row.reachOuts = row.history.sort((a, b) => (b.d || '').localeCompare(a.d || '')).slice(0, 25).map((h) => h.line).join('\n');
  }
  return pool;
}

const rt = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 1900) } }];
const ms = (arr) => [...arr].sort().map((name) => ({ name }));
export function poolProps(row) {
  return {
    Brand: { title: rt(row.title) },
    Key: { rich_text: rt(row.key) },
    'Contact Emails': { rich_text: rt([...row.emails].slice(0, 10).join(', ')) },
    'Contact Name': { rich_text: rt(row.contactName || '') },
    Agency: { checkbox: !!row.agency },
    'Brands Handled': { rich_text: rt(row.handled || '') },
    Approached: { multi_select: ms(row.approached) },
    'Worked With': { multi_select: ms(row.worked) },
    'Offer Type': row.offerType ? { select: { name: row.offerType } } : { select: null },
    'Top Budget USD': { number: row.budget || null },
    'Times Seen': { number: row.seen },
    'First Seen': row.first ? { date: { start: row.first } } : { date: null },
    'Last Seen': row.last ? { date: { start: row.last } } : { date: null },
    'Reach-outs': { rich_text: rt(row.reachOuts || '') },
  };
}
// A short fingerprint of what this sync owns, to skip rows that have not changed
export function poolSig(props) {
  const v = (p) => (p?.title || p?.rich_text) ? (p.title || p.rich_text).map((t) => t.text?.content ?? t.plain_text).join('')
    : p?.multi_select ? p.multi_select.map((o) => o.name).sort().join('|')
    : p?.select !== undefined ? (p.select?.name || '')
    : p?.number !== undefined ? String(p.number ?? '')
    : p?.date !== undefined ? (p.date?.start || '').slice(0, 10)
    : p?.checkbox !== undefined ? String(!!p.checkbox) : '';
  return Object.keys(props).sort().map((k) => k + '=' + v(props[k])).join(';');
}

async function records() {
  const out = [];
  const g = (p, n) => plain(p.properties?.[n]);
  for (const p of await queryAll(DS.leads, undefined, { useCache: false })) {
    out.push({ email: g(p, 'Brand Email'), brand: g(p, 'Brand'), creator: g(p, 'Creator'), offerType: g(p, 'Type'),
      budget: Math.max(...['Budget USD', 'Ask USD', 'Agreed USD', 'Quoted USD'].map((n) => Number(g(p, n)) || 0)),
      date: g(p, 'Last Brand Email') || p.created_time, booked: !!g(p, 'Agreed USD'), contactName: g(p, 'Contact Name'), kind: g(p, 'Status') ? 'lead, ' + lc(g(p, 'Status')) : 'lead' });
  }
  for (const p of await queryAll(DEALS_DS, undefined, { useCache: false })) {
    const stage = g(p, 'Deal Stage');
    out.push({ email: g(p, 'Brand Email'), brand: g(p, 'Brand Name'), creator: g(p, 'Creator'), offerType: 'Paid offer',
      budget: Number(g(p, 'Final Rate USD')) || 0, date: g(p, 'Last Brand Reply') || p.created_time, booked: BOOKED.includes(stage), kind: stage ? 'deal, ' + lc(stage) : 'deal' });
  }
  // Brand Contacts add addresses, creators and the Agency tick, but are not separate sightings
  for (const p of await queryAll(CONTACTS_DS, undefined, { useCache: false })) {
    out.push({ email: g(p, 'Email'), brand: g(p, 'Brand'), creators: (p.properties?.Creators?.multi_select || []).map((o) => o.name),
      agency: g(p, 'Agency') === true, date: g(p, 'Last Seen'), count: false });
  }
  return out;
}

// Create or update pool rows. Writes at most `limit` rows per run (the first fill spreads over a few runs).
export async function syncBrandPool({ limit = 120, late = () => false } = {}) {
  const pool = buildPool(await records());
  const existing = new Map();
  for (const p of await queryAll(POOL_DS, undefined, { useCache: false })) {
    const key = plain(p.properties?.Key);
    const pp = p.properties || {};
    const teamTouched = plain(pp['Do Not Contact']) === true || !!plain(pp['Pitched For']) || !!plain(pp['Last Pitched']) || !!plain(pp.Notes);
    if (key) existing.set(key, { id: p.id, teamTouched, sig: poolSig(p.properties ? Object.fromEntries(Object.keys(poolProps({ emails: [], approached: [], worked: [] })).map((k) => [k, toWritable(p.properties[k])])) : {}) });
  }
  let created = 0, updated = 0, same = 0, left = 0;
  for (const row of pool.values()) {
    const props = poolProps(row);
    const have = existing.get(row.key);
    if (have && have.sig === poolSig(props)) { same++; continue; }
    if (created + updated >= limit || late()) { left++; continue; }
    if (have) { await notion('PATCH', `/pages/${have.id}`, { properties: props }); updated++; }
    else { await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: POOL_DS }, properties: props }); created++; }
  }
  // Rows left over from an older way of keying (e.g. a subdomain): archive them unless the team has used them
  let archived = 0;
  for (const [key, have] of existing) {
    if (pool.has(key) || late() || created + updated + archived >= limit) continue;
    if (have.teamTouched) continue;
    await notion('PATCH', `/pages/${have.id}`, { in_trash: true }).catch(() => {});
    archived++;
  }
  return { brands: pool.size, created, updated, same, left, archived };
}

// A property as read from Notion, in the shape poolSig understands
function toWritable(p) {
  if (!p) return {};
  switch (p.type) {
    case 'title': return { title: p.title };
    case 'rich_text': return { rich_text: p.rich_text };
    case 'multi_select': return { multi_select: p.multi_select };
    case 'select': return { select: p.select };
    case 'number': return { number: p.number };
    case 'date': return { date: p.date };
    case 'checkbox': return { checkbox: p.checkbox };
    default: return {};
  }
}
