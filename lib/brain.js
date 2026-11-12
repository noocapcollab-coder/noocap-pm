// NOOCAP second brain (Harsh, 13 Nov 2026). Exports what the agency knows from Notion as plain markdown files, one per
// subject, so Graphify can build a knowledge graph of it once a week (brands, creators, rules, lessons, SOPs) and the
// PM can search it from WhatsApp. NO MONEY goes in: the brain is shown to the team, and money lives in the PM's live
// tools and the revenue dashboard. Every amount is replaced with [amount] and money-only fields and sections are left out.
import { notion, plain, queryAll, flatten, titleOf } from './notion.js';
import { DS } from './tools.js';

export const WIKI_DS = '3eddcd77-b77d-43fd-aca2-9cd19f35b7b7';
export const LESSONS_DS = process.env.LESSONS_DS || '1e7ad6d4-df5d-4c01-84aa-59cb1d2e86d8';
// Notion pages exported as they are (SOPs, client portals, playbooks). Comma list in BRAIN_PAGES adds more.
// SOP Library (and its sub-pages) and the two client design files
const DEFAULT_PAGES = ['412508e9-9dda-816d-99a8-c74448b82293', '3ed508e9-9dda-81b3-b633-e5297e0f3a33', '3ed508e9-9dda-8159-b454-fc50ca1f9cfe'];
export const PAGES = () => [...new Set([...DEFAULT_PAGES, ...String(process.env.BRAIN_PAGES || '').split(',').map((s) => s.trim()).filter(Boolean)])];

// ---------- money out ----------
const CUR = String.raw`(?:US\$|USD|INR|Rs\.?|₹|€|£|\$)`;
const NUM = String.raw`\d[\d,]*(?:\.\d+)?\s?(?:k|K|m|M|lakh|lakhs|L)?`;
const MONEY = new RegExp(String.raw`${CUR}\s?${NUM}|${NUM}\s?(?:USD|INR|dollars?|rupees?|bucks)\b`, 'g');
const MONEY_FIELD = /price|rate|amount|usd|inr|agreed|fee|budget|invoice|paid|payment|revenue|\bcut\b|offer|cost|commission|payout|spent|balance|quote/i;
export function noMoney(text) {
  return String(text || '')
    .replace(MONEY, '[amount]')
    .replace(/\b(\d{1,3}(?:,\d{3})+|\d{4,})(?=\s*(?:per|\/)\s*(?:video|reel|post|deliverable))/gi, '[amount]');
}
// Drop whole sections whose heading is about money (the brand wiki's PAYMENT section)
export function dropMoneySections(text) {
  const out = []; let skip = false;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^\s*(?:#+\s*)?([A-Z][A-Z &/]{2,30}):?\s*(.*)$/);
    if (h && /^(WHO|CONTACTS|DEALS|HOW THEY WORK|PAYMENT|WATCH OUT|OPEN NOW|RATES?|MONEY|PRICING)$/.test(h[1].trim())) skip = /PAYMENT|RATES?|MONEY|PRICING/.test(h[1]);
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

export const slug = (s) => String(s || 'untitled').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
const day = (t) => (t ? String(t).slice(0, 10) : '');

// ---------- Notion page -> markdown (two levels of children, enough for SOPs and portals) ----------
const rich = (r = []) => r.map((x) => x.plain_text || '').join('');
async function blocksMd(id, depth = 0, kids = []) {
  const lines = []; let cursor;
  do {
    const r = await notion('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`).catch(() => ({ results: [] }));
    for (const b of r.results || []) {
      const v = b[b.type] || {};
      const t = rich(v.rich_text);
      const pad = '  '.repeat(depth);
      if (/^heading_[123]$/.test(b.type)) lines.push(`\n${'#'.repeat(Number(b.type.slice(-1)) + 1)} ${t}`);
      else if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') lines.push(`${pad}- ${t}`);
      else if (b.type === 'to_do') lines.push(`${pad}- [${v.checked ? 'x' : ' '}] ${t}`);
      else if (b.type === 'child_page') { lines.push(`${pad}- Sub-page: [[${v.title}]]`); kids.push(b.id); }
      else if (b.type === 'child_database') lines.push(`${pad}- Database: ${v.title}`);
      else if (b.type === 'bookmark' || b.type === 'embed' || b.type === 'link_preview') lines.push(`${pad}- Link: ${v.url}`);
      else if (b.type === 'code') lines.push('```\n' + t + '\n```');
      else if (t) lines.push(pad + t);
      if (b.has_children && depth < 2 && !['child_page', 'child_database'].includes(b.type)) lines.push(...await blocksMd(b.id, depth + 1, kids));
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return lines;
}

// ---------- decisions: what Harsh answered when the PM asked him ----------
const SECRET = /password|passcode|\bpwd\b|\botp\b|2fa|login code|verification code|api key|token/i;
export async function logDecision({ brand, creator = '', asked = '', answer = '' }) {
  if (!brand || !answer || SECRET.test(answer)) return;
  const rt = (x) => [{ type: 'text', text: { content: String(x).slice(0, 1900) } }];
  await notion('POST', '/pages', { parent: { data_source_id: DS.agentLog }, properties: {
    Event: { title: rt(`Decision · ${brand}${creator ? ` × ${creator}` : ''}: ${asked}`.slice(0, 200)) },
    Time: { date: { start: new Date().toISOString() } }, Area: { select: { name: 'System' } }, Source: { select: { name: 'WhatsApp' } },
    Details: { rich_text: rt(`Brand asked: ${asked}\nHarsh answered: ${answer}`) } } });
}
async function decisions() {
  const r = await queryAll(DS.agentLog, { property: 'Event', title: { starts_with: 'Decision · ' } }, { useCache: false }).catch(() => []);
  return r.map((p) => ({ event: plain(p.properties?.Event) || '', details: plain(p.properties?.Details) || '', at: day(plain(p.properties?.Time) || p.created_time) }))
    .filter((d) => !SECRET.test(d.details));
}

// ---------- the export ----------
export async function exportBrain() {
  const files = {};
  const put = (path, text) => { files[path] = noMoney(text).trim() + '\n'; };

  // Brands: the brand wiki page (compiled from every email) + each deal's running memory + lead status
  const [wiki, deals, leads] = await Promise.all([
    queryAll(WIKI_DS, undefined, { useCache: false }).catch(() => []),
    queryAll(DS.deals, undefined, { useCache: false }).catch(() => []),
    queryAll(DS.leads, undefined, { useCache: false }).catch(() => []),
  ]);
  const brands = new Map();
  const { brandKey } = await import('./wiki.js');
  const brandOf = (name) => {
    const k = brandKey(name); if (!k) return null;
    if (!brands.has(k)) brands.set(k, { name: String(name).trim(), creators: new Set(), wiki: '', deals: [], leads: [] });
    return brands.get(k);
  };
  for (const p of wiki) {
    const b = brandOf(plain(p.properties?.Brand)); if (!b) continue;
    b.wiki = dropMoneySections(plain(p.properties?.Page));
    for (const c of String(plain(p.properties?.Creators) || '').split(',')) if (c.trim()) b.creators.add(c.trim());
  }
  for (const p of deals) {
    const d = flatten(p);
    const b = brandOf(d['Brand Name']); if (!b) continue;
    if (d.Creator) b.creators.add(String(d.Creator));
    b.deals.push({ creator: d.Creator || '', stage: d['Deal Stage'] || '', created: day(d._created), lastBrand: day(d['Last Brand Reply']), lastOur: day(d['Last Our Reply']), memory: dropMoneySections(d['Deal Memory'] || '') });
  }
  for (const p of leads) {
    const d = flatten(p);
    const b = brandOf(titleOf(p) || d.Brand); if (!b) continue;
    if (d.Creator) b.creators.add(String(d.Creator));
    const keep = Object.entries(d).filter(([k, v]) => !k.startsWith('_') && v !== '' && v != null && v !== false && !MONEY_FIELD.test(k) && !/\bID\b|Message|Thread At|Brand$/i.test(k) && String(v).length < 600)
      .map(([k, v]) => [k, /^\d{4}-\d\d-\d\dT/.test(String(v)) ? day(v) : v]);
    b.leads.push(keep.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · '));
  }
  for (const d of await decisions()) {
    const m = d.event.match(/^Decision · (.+?)(?: × (.+?))?: (.*)$/);
    const b = m && brandOf(m[1]); if (!b) continue;
    if (m[2]) b.creators.add(m[2]);
    (b.decisions ||= []).push(`- ${d.at}: ${d.details.replace(/\n/g, ' · ')}`);
  }
  for (const [k, b] of brands) {
    const creators = [...b.creators].filter(Boolean);
    const parts = [`# ${b.name}`, '', `Brand. Works with creators: ${creators.map((c) => `[[${c}]]`).join(', ') || 'none recorded'}.`];
    if (b.wiki) parts.push('', '## Brand wiki (from every email with them)', b.wiki);
    for (const d of b.deals) parts.push('', `## Deal with [[${d.creator || 'unknown creator'}]] (${d.stage || 'no stage'}, opened ${d.created})`, `Last brand reply ${d.lastBrand || 'none'}, our last reply ${d.lastOur || 'none'}.`, d.memory);
    if (b.leads.length) parts.push('', '## Inbound leads', ...b.leads.map((l) => `- ${l}`));
    if (b.decisions?.length) parts.push('', '## Decisions from Harsh', ...b.decisions);
    put(`brands/${slug(k)}.md`, parts.join('\n'));
  }

  // Creators: who they are to us and which brands they have worked with
  const byCreator = new Map();
  for (const b of brands.values()) for (const c of b.creators) { if (!byCreator.has(c)) byCreator.set(c, []); byCreator.get(c).push(b.name); }
  const { BOARDS } = await import('./tools.js');
  for (const { creator } of BOARDS) if (!byCreator.has(creator)) byCreator.set(creator, []);
  for (const [c, list] of byCreator) put(`creators/${slug(c)}.md`, [`# ${c}`, '', `NOOCAP creator. Brands: ${list.map((x) => `[[${x}]]`).join(', ') || 'none yet'}.`].join('\n'));

  // What Harsh and Pratham taught the PM, and the PM's lessons from its mistakes
  const mem = await queryAll(DS.memory, { property: 'Forget', checkbox: { equals: false } }, { useCache: false }).catch(() => []);
  const memRows = mem.map(flatten).filter((m) => m.Note && m.Category !== 'Money');
  put('rules/pm-memory.md', ['# PM memory: rules and facts Harsh and Pratham taught the PM', '', ...memRows.map((m) => `- (${m.Category || 'Fact'}, ${day(m.Added || m._created)}) ${m.Note}`)].join('\n'));
  const les = await queryAll(LESSONS_DS, { property: 'Active', checkbox: { equals: true } }, { useCache: false }).catch(() => []);
  const byArea = new Map();
  for (const p of les) { const l = flatten(p); const a = l.Area || 'Other'; if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(l); }
  for (const [a, list] of byArea) put(`lessons/${slug(a)}.md`, [`# PM lessons: ${a}`, '', 'Mistakes the PM made once and the rule that came out of each.', '', ...list.map((l) => `## ${l.Lesson}\nWhen: ${l.When || '-'}\nDo: ${l.Do || '-'}\nNever: ${l.Never || '-'}\nSeen ${l['Times Seen'] || 1} time(s). Source: ${l.Source || '-'}.`)].join('\n'));

  // Pages: SOPs, client portals, playbooks
  // each listed page and the sub-pages directly under it (the SOP Library's numbered SOPs)
  const seen = new Set();
  const exportPage = async (id, parent = '', depth = 0) => {
    if (seen.has(id) || seen.size > 150) return; seen.add(id);
    try {
      const page = await notion('GET', `/pages/${id}`);
      const title = titleOf(page) || id;
      const kids = [];
      const body = dropMoneySections((await blocksMd(id, 0, kids)).join('\n'));
      put(`pages/${slug(title)}.md`, `# ${title}\n\nNotion page${parent ? ` under [[${parent}]]` : ''}, last edited ${day(page.last_edited_time)}.\n\n${body}`);
      if (depth < 1) for (const k of kids) await exportPage(k, title, depth + 1);
    } catch (e) { files[`pages/_error-${slug(id)}.md`] = `Could not export ${id}: ${String(e.message).slice(0, 200)}\n`; }
  };
  for (const id of PAGES()) await exportPage(id);
  return { at: new Date().toISOString(), count: Object.keys(files).length, files };
}
