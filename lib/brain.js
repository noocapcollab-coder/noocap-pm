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

// ---------- live activity for Agency HQ's Brain tab ----------
export async function brainLog(text) {
  await notion('POST', '/pages', { parent: { data_source_id: DS.agentLog }, properties: { Event: { title: [{ type: 'text', text: { content: `Brain · ${String(text)}`.slice(0, 200) } }] }, Time: { date: { start: new Date().toISOString() } }, Area: { select: { name: 'System' } } } });
}
export async function brainActivity() {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const log = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 60, sorts: [{ timestamp: 'created_time', direction: 'descending' }], filter: { and: [{ timestamp: 'created_time', created_time: { on_or_after: since } }, { or: ['Brain · ', 'Decision · ', 'Brain gap · '].map((x) => ({ property: 'Event', title: { starts_with: x } })) }] } }).catch(() => ({ results: [] }));
  const les = await notion('POST', `/data_sources/${LESSONS_DS}/query`, { page_size: 40, sorts: [{ timestamp: 'created_time', direction: 'descending' }], filter: { timestamp: 'created_time', created_time: { on_or_after: since } } }).catch(() => ({ results: [] }));
  const rep = await notion('POST', `/data_sources/${LESSONS_DS}/query`, { page_size: 50, filter: { and: [{ property: 'Active', checkbox: { equals: true } }, { property: 'Times Seen', number: { greater_than_or_equal_to: 3 } }] } }).catch(() => ({ results: [] }));
  const events = [];
  const count = { pages: 0, cards: 0, decisions: 0, gaps: 0, lessons: (les.results || []).length, repeats: (rep.results || []).length };
  for (const p of log.results || []) {
    const e = plain(p.properties?.Event) || '';
    let kind = 'brain', text = e.replace(/^Brain · /, '');
    if (e.startsWith('Decision · ')) { kind = 'decision'; count.decisions++; text = `Your answer saved as a rule: ${e.replace(/^Decision · /, '')}`; }
    else if (e.startsWith('Brain gap · ')) { kind = 'gap'; count.gaps++; text = `Could not answer: "${e.replace(/^Brain gap · /, '')}"`; }
    else if (/^Brand pages updated/.test(text)) { kind = 'pages'; count.pages += (text.split(':')[1] || '').split(',').filter((x) => x.trim()).length; }
    else if (/^Script card/.test(text)) { kind = 'card'; count.cards++; }
    events.push({ at: p.created_time, kind, text: noMoney(text).slice(0, 220) });
  }
  for (const p of les.results || []) events.push({ at: p.created_time, kind: 'lesson', text: `New lesson: ${noMoney(plain(p.properties?.Lesson) || '').slice(0, 200)}` });
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { count, events: events.slice(0, 40), repeats: (rep.results || []).map((p) => ({ lesson: noMoney(plain(p.properties?.Lesson) || '').slice(0, 160), seen: p.properties?.['Times Seen']?.number || 3 })).sort((a, b) => b.seen - a.seen).slice(0, 8) };
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

// ---------- performance, scripts, brand feedback ----------
const CONTENT_STATS = 'e8265c69-3e3e-451b-8fe0-9b4bfcbe8960';
const EDIT_TRACKER = '8fceee86-cd0d-4045-9b4f-33363fcd25c1';
const n0 = (x) => Math.round(Number(x) || 0);
// The export reads hundreds of pages: pause between them so n8n's Notion calls (editor alerts) never hit the rate limit
const gentle = () => new Promise((r) => setTimeout(r, 350));
const cut = (x, n) => Array.from(String(x || '')).slice(0, n).join(''); // never splits an emoji in half
const fmt = (x) => n0(x).toLocaleString('en-US');
const brandIn = (text, brands) => { const t = flat2(text); for (const [k, b] of brands) if (k.length >= 4 && t.includes(k)) return b.name; return ''; };
const flat2 = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function exportPerformance(brands) {
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const rows = (await queryAll(CONTENT_STATS, { property: 'Posted', date: { on_or_after: since } }, { useCache: false })).map(flatten);
  const by = new Map();
  for (const r of rows) { const c = r.Client || 'Unknown'; if (!by.has(c)) by.set(c, []); by.get(c).push(r); }
  const out = {};
  for (const [creator, list] of by) {
    const avg = (xs) => (xs.length ? xs.reduce((a, r) => a + n0(r.Views), 0) / xs.length : 0);
    const all = avg(list);
    const group = (key) => {
      const m = new Map();
      for (const r of list) for (const v of [].concat(r[key] || []).filter(Boolean)) { if (!m.has(v)) m.set(v, []); m.get(v).push(r); }
      return [...m].filter(([, xs]) => xs.length >= 2).map(([v, xs]) => [v, avg(xs), xs.length]).sort((a, b) => b[1] - a[1]);
    };
    const top = [...list].sort((a, b) => n0(b.Views) - n0(a.Views)).slice(0, 25);
    const lines = [`# ${creator} - what performs`, '', `Content OS, videos posted since ${since}: ${list.length} posts across platforms, average ${fmt(all)} views. Creator: [[${creator === 'Valeri' ? 'Valeri' : creator}]].`, '',
      ...((h) => (h.length ? ['## Hook types by average views', ...h.map(([v, a, n]) => `- ${v}: ${fmt(a)} average over ${n} posts (${all ? Math.round((a / all) * 100) : 0}% of this creator's average)`), ''] : []))(group('Hook Type')),
      ...((t) => (t.length ? ['## Topics by average views', ...t.map(([v, a, n]) => `- ${v}: ${fmt(a)} average over ${n} posts`)] : []))(group('Topic'))];
    for (const r of top) {
      const brand = brandIn(`${r.Video} ${r['Hook Line']}`, brands);
      lines.push('', `## ${day(r.Posted)} ${cut(String(r.Video || 'Untitled').replace(/\s+/g, ' '), 70)}`,
        `${r.Platform || ''} ${r.Format || ''}: ${fmt(r.Views)} views, ${fmt(r.Likes)} likes, ${fmt(r.Comments)} comments, ${fmt(r.Shares)} shares, ${fmt(r.Saves)} saves.${brand ? ` Brand: [[${brand}]].` : ''}`,
        r['Hook Line'] ? `Hook: "${cut(r['Hook Line'], 240)}" (${r['Hook Type'] || 'unclassified'})` : '',
        r.Topic?.length ? `Topic: ${[].concat(r.Topic).join(', ')}` : '',
        r['Why It Worked'] ? `Why it worked: ${cut(r['Why It Worked'], 500)}` : '',
        r.Structure ? `Structure: ${cut(r.Structure, 400)}` : '');
    }
    out[`performance/${slug(creator)}.md`] = noMoney(lines.filter((l) => l !== '').join('\n')).trim() + '\n';
  }
  return out;
}

async function exportScripts() {
  const { BOARDS } = await import('./tools.js');
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const out = {};
  for (const { creator, ds } of BOARDS) {
    const pages = (await queryAll(ds, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } }, { useCache: false }).catch(() => []))
      .filter((p) => /^12-|posted/i.test(String(flatten(p).Status || ''))).slice(0, 15);
    const parts = [];
    for (const p of pages) {
      await gentle();
      const lines = await blocksMd(p.id, 2).catch(() => []); // top level only: the brief toggle is not read
      const md = lines.join('\n');
      // the final script: the last "SCRIPT DRAFT" section (routines) or the part under the "Script" heading (sponsor cards)
      const i = Math.max(md.lastIndexOf('SCRIPT DRAFT'), md.search(/\n#{2,3} Script\s*\n/));
      if (i < 0) continue;
      const script = md.slice(i).split('\n').slice(1).filter((l) => !/^#{2,3} (?!Hook|Body|CTA)/.test(l) || /Hook|Body|CTA/.test(l)).join('\n').trim(); const scriptCut = cut(script, 1800);
      if (scriptCut.length < 80) continue;
      const f = flatten(p);
      parts.push(`## ${day(f['POST DATE'] || p.last_edited_time)} ${cut(titleOf(p) || 'Untitled', 70)}\n${f.Type || f.TYPE ? `Type: ${f.Type || f.TYPE}. ` : ''}Creator: [[${creator}]].\n${scriptCut}`);
    }
    if (parts.length) out[`scripts/${slug(creator)}.md`] = noMoney(`# ${creator} - posted scripts\n\nThe final scripts of videos posted in the last 60 days, as filmed.\n\n${parts.join('\n\n')}`).trim() + '\n';
  }
  return out;
}

async function exportFeedback(brands) {
  const rows = (await queryAll(EDIT_TRACKER, { property: 'Brand Feedback', rich_text: { is_not_empty: true } }, { useCache: false })).map((p) => ({ f: flatten(p), t: titleOf(p), at: p.last_edited_time }));
  const by = new Map();
  for (const r of rows) { const c = r.f.Creator === 'Valerie' ? 'Valeri' : r.f.Creator === 'EmTech' ? 'Emtech' : r.f.Creator || 'Unknown'; if (!by.has(c)) by.set(c, []); by.get(c).push(r); }
  const out = {};
  for (const [creator, list] of by) {
    const parts = list.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 40).map((r) => {
      const brand = brandIn(r.t, brands);
      return `## ${day(r.f['Changes Requested At'] || r.at)} ${cut(r.t || 'Untitled', 70)}\n${brand ? `Brand: [[${brand}]]. ` : ''}Creator: [[${creator}]]. Editor: ${r.f.Editor || '-'}. Revisions: ${r.f.Revisions || 0}.\n${cut(r.f['Brand Feedback'], 1500)}`;
    });
    out[`feedback/${slug(creator)}.md`] = noMoney(dropMoneySections(`# ${creator} - brand feedback on our cuts\n\nWhat brands asked us to change after seeing a cut. Read before editing the next video for the same brand.\n\n${parts.join('\n\n')}`)).trim() + '\n';
  }
  return out;
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
    await gentle();
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

  // What performs: CONTENT STATS (Content OS) per creator, last 120 days. Views are not money, so they stay.
  try { Object.assign(files, await exportPerformance(brands)); } catch (e) { files['performance/_error.md'] = `Could not export performance: ${String(e.message).slice(0, 200)}\n`; }
  // What we actually posted: the final script on each posted video card, last 60 days
  try { Object.assign(files, await exportScripts()); } catch (e) { files['scripts/_error.md'] = `Could not export scripts: ${String(e.message).slice(0, 200)}\n`; }
  // What brands asked us to change on cuts: EDIT TRACKER Brand Feedback
  try { Object.assign(files, await exportFeedback(brands)); } catch (e) { files['feedback/_error.md'] = `Could not export feedback: ${String(e.message).slice(0, 200)}\n`; }
  // Questions the PM's brain search could not answer: the gaps to fill
  try {
    const gaps = await queryAll(DS.agentLog, { property: 'Event', title: { starts_with: 'Brain gap · ' } }, { useCache: false });
    if (gaps.length) put('rules/brain-gaps.md', ['# Brain gaps: questions the brain could not answer', '', ...gaps.slice(0, 200).map((g) => `- ${day(g.created_time)}: ${plain(g.properties?.Event).replace(/^Brain gap · /, '')}`)].join('\n'));
  } catch { /* optional */ }
  return { at: new Date().toISOString(), count: Object.keys(files).length, files };
}
