// The PM's tools. Every number the bot quotes is computed here, never by the model.
import { notion, queryAll, flatten, plain, titleOf } from './notion.js';

export const DS = {
  deals: '70d26268-6d57-4d45-abf7-a599c6f8e0f4',
  revenue: '9f799a64-92cb-4d7b-83b7-100f5bc77464',
  cuts: 'd63fb0df-db77-4cd9-9c94-0d74a36cfebf',
  history: '713e41de-cf62-45b1-8652-bc2f2ad6ea7f',
  agentLog: '4215bfda-0191-4e77-a40b-4c2d8b6e0d70',
  memory: '9e77872b-4b7d-4524-926d-e684a6e797fe',
  intake: '13cf6abc-bcfc-4a35-95d5-e130fd58e720',
};

export const BOARDS = [
  { creator: 'Brad', ds: '28b508e9-9dda-81ba-8d7f-000b84b83fbd' },
  { creator: 'Chris', ds: '2a1508e9-9dda-8125-bd63-000bb75578dd' },
  { creator: 'Lindsay', ds: '301508e9-9dda-811b-83c7-000b46be09b1' },
  { creator: 'Emtech', ds: '328508e9-9dda-8000-b3c9-000b0d791507' },
  { creator: 'Duncan', ds: '328508e9-9dda-8186-b4ca-000bd212e84b' },
  { creator: 'Valeri', ds: 'f0dbec00-505d-4e16-8e51-b2fcfea21445' },
  { creator: 'David Iya', ds: '898508e9-9dda-8383-ad90-070f01618f5a' },
  { creator: 'Nicole', ds: '25b449d2-35ba-4026-992e-39af9974b158' },
];

const EDITORS = ['Abhishek', 'Prateek', 'Sumith', 'Prabal', 'Parvez'];
const CLOSED_DEAL = ['Paid', 'Lost'];
export const LATE_WINDOW = 7; // days a past post date still counts as late

// ---------- small helpers ----------
export const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 5.5 * 36e5 - n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const money = (n) => Math.round((n || 0) * 100) / 100;
const lc = (s) => String(s || '').toLowerCase().trim();
const matches = (value, wanted) => !wanted || lc(value).includes(lc(wanted));
const creatorKey = (s) => {
  const k = lc(s);
  if (k.startsWith('valer')) return 'valeri';
  if (k.startsWith('david')) return 'david iya';
  if (k.startsWith('dym') || k.startsWith('dmy')) return 'dymtro';
  return k;
};
const sameCreator = (a, b) => !b || creatorKey(a) === creatorKey(b);
const inRange = (d, from, to) => (!from || (d && d.slice(0, 10) >= from)) && (!to || (d && d.slice(0, 10) <= to));

function stageOf(status) {
  const s = lc(status);
  const intake = { assigned: 'Editing', editing: 'Editing', 'in review': 'Review', changes: 'Review', 'to post': 'Ready', posted: 'Posted' };
  if (intake[s]) return intake[s];
  const num = parseInt(s, 10);
  if (s.includes('archive') || num === 13) return 'Archived';
  if (s.includes('scheduled')) return 'Ready';
  if (s.includes('idea bank')) return 'Scripting';
  if (!Number.isNaN(num)) {
    if (num <= 5) return 'Scripting';
    if (num === 6) return 'Filming';
    if (num === 7) return 'Editing';
    if (num === 8 || num === 9) return 'Review';
    if (num === 10 || num === 11) return 'Ready';
    if (num === 12) return 'Posted';
  }
  return 'Other';
}

function readVideo(page, creator) {
  const props = page.properties || {};
  let status = '', editorRaw = '', postDate = null, sponsor = false, rate = null;
  for (const [name, p] of Object.entries(props)) {
    const n = lc(name);
    if (n === 'status' && (p.type === 'select' || p.type === 'status')) status = plain(p) || '';
    if (n.includes('editor') && !n.includes('thread') && !editorRaw) editorRaw = String(plain(p) || '');
    if (p.type === 'date' && n.includes('post') && (!postDate || n.includes('date'))) postDate = p.date?.start || postDate;
    if ((n === 'type' || n.includes('sponsor')) && /sponsor/i.test(String(plain(p) || ''))) sponsor = true;
    if (p.type === 'checkbox' && n.includes('sponsor') && p.checkbox) sponsor = true;
    if (p.type === 'number' && /\b(rate|amount|price|fee)\b/.test(n) && !/com|cut|%/.test(n) && p.number) rate = p.number;
  }
  const editor = EDITORS.find((e) => lc(editorRaw).includes(lc(e))) || (editorRaw ? editorRaw : null);
  return { creator, title: titleOf(page), status, stage: stageOf(status), editor, post_date: postDate, sponsor, url: page.url, id: page.id, rate, edited: page.last_edited_time };
}

// ---------- tool implementations ----------
async function moneySummary({ creator, from, to, include_items = false }) {
  const [revPages, cutPages] = await Promise.all([queryAll(DS.revenue), queryAll(DS.cuts)]);
  const cutPct = {};
  for (const p of cutPages) {
    const r = flatten(p);
    if (r.Creator != null) cutPct[creatorKey(r.Creator)] = r['Cut Percent'] ?? null;
  }
  const by = {};
  const unpaid = [];
  const items = [];
  for (const p of revPages) {
    const r = flatten(p);
    if (!sameCreator(r.Creator, creator)) continue;
    const when = r['Payment Received'] || r['Posted Date'] || r._created;
    if (!inRange(when, from, to)) continue;
    const key = r.Creator || '(no creator)';
    const pct = cutPct[creatorKey(key)];
    const amount = Number(r['Amount USD'] || 0);
    const cut = pct != null ? (amount * pct) / 100 : 0;
    const b = (by[key] ||= { creator: key, videos: 0, gross_usd: 0, paid_usd: 0, unpaid_usd: 0, cut_percent: pct ?? 'MISSING', noocap_cut_usd: 0, cut_collected_usd: 0, cut_not_collected_usd: 0 });
    b.videos++;
    b.gross_usd += amount;
    if (r.Paid === true) b.paid_usd += amount; else b.unpaid_usd += amount;
    b.noocap_cut_usd += cut;
    if (r['Cut Collected'] === true) b.cut_collected_usd += cut; else b.cut_not_collected_usd += cut;
    if (r.Paid !== true) unpaid.push({ creator: key, brand: r.Brand || null, video: r['Video Title'] || null, amount_usd: amount });
    if (include_items) items.push({ creator: key, brand: r.Brand || null, video: r['Video Title'] || null, amount_usd: amount, paid: r.Paid === true, payment_received: r['Payment Received'] || null, cut_usd: money(cut), cut_collected: r['Cut Collected'] === true });
  }
  const creators = Object.values(by).map((b) => {
    for (const k of Object.keys(b)) if (k.endsWith('_usd')) b[k] = money(b[k]);
    return b;
  }).sort((a, b) => b.gross_usd - a.gross_usd);
  const totals = { videos: 0, gross_usd: 0, paid_usd: 0, unpaid_usd: 0, noocap_cut_usd: 0, cut_collected_usd: 0, cut_not_collected_usd: 0 };
  for (const c of creators) for (const k of Object.keys(totals)) totals[k] += c[k];
  for (const k of Object.keys(totals)) if (k.endsWith('_usd')) totals[k] = money(totals[k]);
  return {
    source: 'Sponsor Video Revenue joined with Creator Cut. NOOCAP cut = Amount USD x Cut Percent.',
    period: { from: from || 'all time', to: to || 'today', date_used: 'Payment Received, else row created date' },
    totals, creators, unpaid_videos: unpaid.slice(0, 40),
    ...(include_items ? { items: items.slice(0, 80) } : {}),
  };
}

async function deals({ creator, stage, brand, open_only = true }) {
  const pages = await queryAll(DS.deals);
  const today = todayIST();
  const rows = [];
  const byStage = {};
  for (const p of pages) {
    const r = flatten(p);
    if (!sameCreator(r.Creator, creator)) continue;
    if (!matches(r['Deal Stage'], stage)) continue;
    if (!matches(r['Brand Name'], brand)) continue;
    const st = r['Deal Stage'] || '(no stage)';
    if (open_only && CLOSED_DEAL.includes(st) && !stage) continue;
    const s = (byStage[st] ||= { deals: 0, value_usd: 0 });
    s.deals++;
    s.value_usd = money(s.value_usd + Number(r['Final Rate USD'] || 0));
    const due = r['Invoice Due Date'];
    const invoiceOverdue = due && st !== 'Paid' && due < today ? daysBetween(due, today) : null;
    const brandSilent = r['Last Our Reply'] && (!r['Last Brand Reply'] || r['Last Brand Reply'] < r['Last Our Reply']) ? daysBetween(r['Last Our Reply'].slice(0, 10), today) : null;
    rows.push({
      brand: r['Brand Name'] || 'Untitled', creator: r.Creator || null, stage: st,
      final_rate_usd: r['Final Rate USD'] ?? null, offer: r['Offer Amount'] != null ? `${r['Offer Amount']} ${r['Offer Currency'] || ''}`.trim() : null,
      deliverables: r.Deliverables || null, deadline: r.Deadline || null, deadline_type: r['Deadline Type'] || null,
      next_action: r['Next Action'] || null, next_action_date: r['Next Action Date'] || null,
      follow_ups_sent: r['Follow-ups Sent'] ?? 0, paused: r.Paused === true, needs_check: r['Needs Check'] === true,
      last_brand_reply: r['Last Brand Reply'] || null, last_our_reply: r['Last Our Reply'] || null,
      days_waiting_on_brand: brandSilent,
      script_sent: r['Script Sent Date'] || null, script_approved: r['Script Approved Date'] || null,
      posted_links: r['Posted Links'] || null, links_sent: r['Links Sent Date'] || null,
      invoice_amount: r['Invoice Amount'] ?? null, invoice_sent: r['Invoice Sent Date'] || null, invoice_due: due || null,
      invoice_overdue_days: invoiceOverdue, paid_date: r['Paid Date'] || null,
      notes: (r['Agent Notes'] || r.Notes || '').slice(0, 300) || null, url: r._url,
    });
  }
  rows.sort((a, b) => (a.next_action_date || '9999').localeCompare(b.next_action_date || '9999'));
  return {
    today, count: rows.length, by_stage: byStage,
    overdue_invoices: rows.filter((d) => d.invoice_overdue_days > 0).map((d) => ({ brand: d.brand, creator: d.creator, amount: d.invoice_amount, days_overdue: d.invoice_overdue_days })),
    actions_due: rows.filter((d) => d.next_action_date && d.next_action_date.slice(0, 10) <= today && !d.paused).map((d) => ({ brand: d.brand, creator: d.creator, next_action: d.next_action, date: d.next_action_date })),
    deals: rows.slice(0, 40),
    note: rows.length > 40 ? `Showing 40 of ${rows.length}. Narrow by creator or stage for the rest.` : undefined,
  };
}

async function pipeline({ creator, stage, editor, only_overdue = false, include_posted = false }) {
  const boards = BOARDS.filter((b) => sameCreator(b.creator, creator));
  const today = todayIST();
  const results = await Promise.all(boards.map(async (b) => {
    try { return { b, pages: await queryAll(b.ds) }; } catch (e) { return { b, error: e.message }; }
  }));
  const counts = {};
  const videos = [];
  const errors = [];
  for (const { b, pages, error } of results) {
    if (error) { errors.push(`${b.creator}: ${error.slice(0, 120)}`); continue; }
    const c = (counts[b.creator] ||= {});
    for (const page of pages) {
      const v = readVideo(page, b.creator);
      if (!v.status || v.stage === 'Archived') continue;
      c[v.stage] = (c[v.stage] || 0) + 1;
      if (v.stage === 'Posted' && !include_posted && lc(stage) !== 'posted') continue;
      if (stage && lc(v.stage) !== lc(stage) && !matches(v.status, stage)) continue;
      if (editor && !matches(v.editor, editor)) continue;
      // Only the last 7 days count as late; older past-dated cards were posted but never moved on the board, so they're ignored
      const late = v.post_date && v.post_date.slice(0, 10) < today && v.post_date.slice(0, 10) >= daysAgo(LATE_WINDOW) && v.stage !== 'Posted';
      v.days_past_post_date = late ? daysBetween(v.post_date.slice(0, 10), today) : null;
      v.flag = late ? (v.stage === 'Ready' ? 'ready but post date passed (missed posting)' : 'post date passed before the edit finished') : null;
      if (only_overdue && !late) continue;
      delete v.edited;
      videos.push(v);
    }
  }
  const order = { Review: 0, Editing: 1, Ready: 2, Filming: 3, Scripting: 4, Posted: 5, Other: 6 };
  videos.sort((a, b) => (b.days_past_post_date || 0) - (a.days_past_post_date || 0) || (order[a.stage] ?? 9) - (order[b.stage] ?? 9));
  return {
    today, stage_counts_by_creator: counts, matching_videos: videos.length,
    videos: videos.slice(0, 60),
    note: videos.length > 60 ? `Showing 60 of ${videos.length}.` : undefined,
    errors: errors.length ? errors : undefined,
  };
}

// Every live video on every creator board (archived left out). Used by the HQ dashboard.
export async function allVideos() {
  const results = await Promise.all(BOARDS.map(async (b) => {
    try { return { b, pages: await queryAll(b.ds) }; } catch (e) { return { b, error: e.message }; }
  }));
  const videos = [];
  const errors = [];
  for (const { b, pages, error } of results) {
    if (error) { errors.push(`${b.creator}: ${error.slice(0, 120)}`); continue; }
    for (const page of pages) {
      const v = readVideo(page, b.creator);
      if (!v.status || v.stage === 'Archived') continue;
      videos.push(v);
    }
  }
  return { videos, errors };
}
export { readVideo, stageOf, editorOutput, deals as dealsSummary, moneySummary, agentLog };

async function teamActivity({ days = 7, from, to, person, creator }) {
  const start = from || daysAgo(days);
  const end = to || todayIST();
  const pages = await queryAll(DS.history, { property: 'Changed At', date: { on_or_after: start } });
  const people = {};
  const moves = [];
  const bump = (name, key, n = 1) => { const p = (people[name] ||= { submitted_for_review: 0, changes_received: 0, reached_ready: 0, posted: 0, scripts_drafted: 0, scripts_sent_for_approval: 0, edit_hours: [] }); p[key] = Array.isArray(p[key]) ? p[key] : p[key] + n; return p; };
  for (const page of pages) {
    const r = flatten(page);
    const when = (r['Changed At'] || '').slice(0, 10);
    if (!inRange(when, start, end)) continue;
    if (!sameCreator(r.Creator, creator)) continue;
    const who = r.Editor || null;
    const writer = r.Scriptwriter || null;
    if (person && !matches(who, person) && !matches(writer, person)) continue;
    const toS = r['To Status'] || '';
    const fromS = r['From Status'] || '';
    const toStage = r['To Stage'] || stageOf(toS);
    if (who) {
      const intakeSubmit = r.Source === 'Video Intake' && fromS === '(intake form)';
      if (intakeSubmit || (toStage === 'Review' && !/change/i.test(toS) && stageOf(fromS) === 'Editing')) {
        const p = bump(who, 'submitted_for_review');
        if (r['Hours In Previous'] != null && stageOf(fromS) === 'Editing') p.edit_hours.push(r['Hours In Previous']);
      }
      if (/change/i.test(toS)) bump(who, 'changes_received');
      if (toStage === 'Ready') bump(who, 'reached_ready');
      if (toStage === 'Posted') bump(who, 'posted');
    }
    if (writer) {
      const n = parseInt(toS, 10);
      if (n === 4) bump(writer, 'scripts_drafted');
      if (n === 5) bump(writer, 'scripts_sent_for_approval');
    }
    moves.push({ when: r['Changed At'], video: r.Video || 'Untitled', creator: r.Creator || null, from: fromS, to: toS, editor: who, source: r.Source || null, hours_in_previous: r['Hours In Previous'] ?? null });
  }
  const summary = Object.entries(people).map(([name, p]) => {
    const hrs = p.edit_hours;
    const out = { person: name, ...p, avg_hours_in_edit: hrs.length ? Math.round((hrs.reduce((a, b) => a + b, 0) / hrs.length) * 10) / 10 : null };
    delete out.edit_hours;
    return out;
  });
  moves.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  return {
    period: { from: start, to: end },
    tracking_started: '2026-09-25 (STATUS HISTORY has no data before this, so earlier periods look empty)',
    people: summary, total_moves: moves.length, recent_moves: moves.slice(0, 40),
  };
}

async function agentLog({ days = 7, area, outcome }) {
  const start = daysAgo(days);
  const pages = await queryAll(DS.agentLog, { property: 'Time', date: { on_or_after: start } });
  const byOutcome = {};
  let cost = 0, tokIn = 0, tokOut = 0;
  const rows = [];
  for (const page of pages) {
    const r = flatten(page);
    if (!matches(r.Area, area) || !matches(r.Outcome, outcome)) continue;
    byOutcome[r.Outcome || '(none)'] = (byOutcome[r.Outcome || '(none)'] || 0) + 1;
    cost += Number(r['Cost USD'] || 0); tokIn += Number(r['Tokens In'] || 0); tokOut += Number(r['Tokens Out'] || 0);
    rows.push({ time: r.Time, event: r.Event, area: r.Area || null, outcome: r.Outcome || null, creator: r.Creator || null, person: r.Person || null, details: (r.Details || '').slice(0, 200) || null });
  }
  rows.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return { period_from: start, events: rows.length, by_outcome: byOutcome, ai_cost_usd: money(cost), tokens_in: tokIn, tokens_out: tokOut, recent: rows.slice(0, 30) };
}

async function searchNotion({ query }) {
  const res = await notion('POST', '/search', { query, page_size: 10 });
  return {
    results: (res.results || []).map((r) => ({
      id: r.id, type: r.object, title: r.object === 'page' ? titleOf(r) : (r.title || []).map((t) => t.plain_text).join('') || r.name || 'Untitled',
      url: r.url, last_edited: r.last_edited_time,
    })),
  };
}

async function readPage({ page_id }) {
  const id = String(page_id).replace(/^.*?([0-9a-f]{32}|[0-9a-f-]{36}).*$/i, '$1');
  const page = await notion('GET', `/pages/${id}`);
  const blocks = await notion('GET', `/blocks/${id}/children?page_size=100`);
  const lines = [];
  for (const b of blocks.results || []) {
    const rt = b[b.type]?.rich_text;
    if (!rt) continue;
    const text = rt.map((t) => t.plain_text).join('');
    if (!text.trim()) continue;
    const prefix = b.type.startsWith('heading') ? '## ' : b.type.includes('list') ? '- ' : b.type === 'to_do' ? (b.to_do.checked ? '[x] ' : '[ ] ') : '';
    lines.push(prefix + text);
  }
  const content = lines.join('\n');
  return { properties: flatten(page), content: content.slice(0, 6000), truncated: content.length > 6000 || !!blocks.has_more };
}



// Video Intake = every video an editor delivered through the Editor Handoff Form (full history)
const istDate = (iso) => (iso ? (iso.length <= 10 ? iso : new Date(new Date(iso).getTime() + 5.5 * 36e5).toISOString().slice(0, 10)) : null);
const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
const niceName = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const INTAKE_CREATOR = { valerie: 'Valeri', david: 'David Iya', nicole: 'Nicole', emtech: 'Emtech' };

async function editorOutput({ from, to, days = 7, editor, creator, include_videos = true }) {
  const start = from || daysAgo(days);
  const end = to || todayIST();
  const pages = await queryAll(DS.intake, {
    or: [
      { timestamp: 'created_time', created_time: { on_or_after: new Date(new Date(start + 'T00:00:00+05:30')).toISOString() } },
      { property: 'Posted At', date: { on_or_after: start } },
      { property: 'Changes Requested At', date: { on_or_after: start } },
    ],
  });
  const people = {};
  const byCreator = {};
  const videos = [];
  const statusNow = {};
  for (const page of pages) {
    const r = flatten(page);
    const ed = niceName(r.Editor) || '(no editor)';
    const cr = INTAKE_CREATOR[lc(r.Creator)] || r.Creator || '(no creator)';
    if (editor && !matches(ed, editor)) continue;
    if (creator && !sameCreator(cr, creator)) continue;
    const submitted = istDate(page.created_time);
    const posted = istDate(r['Posted At']);
    const changesAt = istDate(r['Changes Requested At']);
    const inSub = inRange(submitted, start, end);
    const p = (people[ed] ||= { editor: ed, delivered: 0, short_form: 0, long_form: 0, sponsor: 0, revision_rounds: 0, changes_requested_in_period: 0, posted_in_period: 0, _edit: [], _rev: [], _cycle: [], draft_sla: {} });
    if (inSub) {
      p.delivered++;
      if (/long/i.test(r['CONTENT TYPE'] || r.Format || '')) p.long_form++; else p.short_form++;
      if (/sponsor/i.test(r.TYPE || '')) p.sponsor++;
      p.revision_rounds += Number(r.Revisions || 0);
      if (typeof r['Edit Time (hrs)'] === 'number') p._edit.push(r['Edit Time (hrs)']);
      if (typeof r['Revision Time (hrs)'] === 'number') p._rev.push(r['Revision Time (hrs)']);
      if (typeof r['Total Cycle (hrs)'] === 'number') p._cycle.push(r['Total Cycle (hrs)']);
      if (r['Draft SLA'] != null && r['Draft SLA'] !== '') { const k = String(r['Draft SLA']); p.draft_sla[k] = (p.draft_sla[k] || 0) + 1; }
      byCreator[cr] = (byCreator[cr] || 0) + 1;
      statusNow[r.Status || 'In Review'] = (statusNow[r.Status || 'In Review'] || 0) + 1;
      videos.push({ title: r['Video Title'] || 'Untitled', editor: ed, creator: cr, submitted, status: r.Status || 'In Review', type: r.TYPE || null, format: r['CONTENT TYPE'] || r.Format || null, revisions: r.Revisions ?? 0, posted: posted || null, post_due: istDate(r['Post Due']) });
    }
    if (inRange(changesAt, start, end)) p.changes_requested_in_period++;
    if (inRange(posted, start, end)) p.posted_in_period++;
  }
  const editors = Object.values(people).map((p) => {
    const out = { ...p, avg_edit_hours: avg(p._edit), avg_revision_hours: avg(p._rev), avg_cycle_hours: avg(p._cycle) };
    delete out._edit; delete out._rev; delete out._cycle;
    return out;
  }).filter((p) => p.delivered || p.posted_in_period || p.changes_requested_in_period)
    .sort((a, b) => b.delivered - a.delivered);
  const totals = { delivered: 0, posted_in_period: 0, changes_requested_in_period: 0, revision_rounds: 0 };
  for (const e of editors) for (const k of Object.keys(totals)) totals[k] += e[k];
  videos.sort((a, b) => String(b.submitted).localeCompare(String(a.submitted)));
  return {
    source: 'Video Intake (Editor Handoff Form). delivered = videos editors submitted in the period (form submission date, IST).',
    period: { from: start, to: end },
    totals, editors, delivered_by_creator: byCreator, current_status_of_delivered: statusNow,
    ...(include_videos ? { videos: videos.slice(0, 60) } : {}),
  };
}

// ---------- memory (PM MEMORY in Notion) ----------
const MEMORY_CATEGORIES = ['Rule', 'Fact', 'Preference', 'Correction', 'Person', 'Money'];
const SOURCE_NAME = { whatsapp: 'WhatsApp', discord: 'Discord', dashboard: 'Dashboard chat' };

// Every remembered note that has not been ticked "Forget", oldest first
export async function loadMemory() {
  const pages = await queryAll(DS.memory, { property: 'Forget', checkbox: { equals: false } }, { useCache: false });
  return pages
    .map((p) => { const r = flatten(p); return { id: r['Memory ID'] || null, category: r.Category || 'Fact', note: r.Note || '', added: r.Added || r._created, pageId: p.id }; })
    .filter((m) => m.note)
    .sort((a, b) => String(a.added).localeCompare(String(b.added)));
}

export function memoryBlock(memories) {
  if (!memories.length) return 'PM MEMORY: nothing saved yet.';
  return 'PM MEMORY (what Harsh and Pratham have taught you, oldest first):\n' +
    memories.map((m) => `- [${m.id}] (${m.category}) ${m.note}`).join('\n');
}

async function remember({ note, category = 'Fact' }, ctx = {}) {
  const text = String(note || '').trim().slice(0, 600);
  if (!text) return { error: 'Empty note' };
  const existing = await loadMemory();
  const dupe = existing.find((m) => lc(m.note) === lc(text));
  if (dupe) return { saved: false, reason: 'Already remembered', id: dupe.id };
  const cat = MEMORY_CATEGORIES.includes(category) ? category : 'Fact';
  const res = await notion('POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: DS.memory },
    properties: {
      Note: { title: [{ type: 'text', text: { content: text } }] },
      Category: { select: { name: cat } },
      Added: { date: { start: new Date().toISOString() } },
      Source: { select: { name: SOURCE_NAME[ctx.channel] || 'Dashboard chat' } },
    },
  });
  const id = res?.properties?.['Memory ID'] ? plain(res.properties['Memory ID']) : null;
  return { saved: true, id, note: text, category: cat };
}

async function forget({ memory_id, text }) {
  const existing = await loadMemory();
  const want = lc(memory_id).replace(/\s/g, '');
  const hits = existing.filter((m) => (want && lc(m.id) === want) || (!want && text && lc(m.note).includes(lc(text))));
  if (!hits.length) return { forgotten: 0, reason: 'No matching memory. Check the id in the PM MEMORY list.' };
  if (hits.length > 1 && !want) return { forgotten: 0, reason: 'Several memories match; pass memory_id instead', matches: hits.map((m) => ({ id: m.id, note: m.note })) };
  for (const m of hits) await notion('PATCH', `/pages/${m.pageId}`, { properties: { Forget: { checkbox: true } } });
  return { forgotten: hits.length, notes: hits.map((m) => ({ id: m.id, note: m.note })) };
}

// ---------- tool definitions for Claude ----------
export const TOOL_DEFS = [
  {
    name: 'money_summary',
    description: 'Sponsor revenue and NOOCAP\'s cut per creator, computed in code from Sponsor Video Revenue x Creator Cut. Use for anything about money earned, NOOCAP cut or commission, what creators were paid, unpaid sponsor videos, or cut not yet collected. Dates filter on Payment Received (or created date when blank).',
    input_schema: {
      type: 'object',
      properties: {
        creator: { type: 'string', description: 'Optional creator name, e.g. Brad, Duncan, Valeri' },
        from: { type: 'string', description: 'Optional start date YYYY-MM-DD' },
        to: { type: 'string', description: 'Optional end date YYYY-MM-DD' },
        include_items: { type: 'boolean', description: 'Also return each sponsor video row' },
      },
    },
  },
  {
    name: 'deals',
    description: 'Brand Deals Pipeline: every brand deal with stage, rate, deadlines, follow-ups, script/links/invoice dates. Also returns overdue invoices and deals whose next action is due. Use for brand deals, follow-ups, invoices, what is waiting on a brand, deadlines.',
    input_schema: {
      type: 'object',
      properties: {
        creator: { type: 'string' },
        stage: { type: 'string', description: 'One of Inbound, Negotiating, Price Agreed, Signed, Brief Received, Script Sent, Script Approved, In Production, Submitted, Approved, Posted, Invoiced, Paid, Lost' },
        brand: { type: 'string', description: 'Part of the brand name' },
        open_only: { type: 'boolean', description: 'Default true: hides Paid and Lost unless a stage is given' },
      },
    },
  },
  {
    name: 'pipeline',
    description: 'Live video pipeline across the 8 creator REELS boards: stage counts per creator and matching videos with status, editor, post date, sponsor flag, and a flag when the post date has passed. Stages: Scripting, Filming, Editing, Review, Ready, Posted.',
    input_schema: {
      type: 'object',
      properties: {
        creator: { type: 'string' },
        stage: { type: 'string', description: 'Scripting, Filming, Editing, Review, Ready or Posted (or a raw status like "8- Changes")' },
        editor: { type: 'string', description: 'Abhishek, Prateek, Sumith, Prabal or Parvez' },
        only_overdue: { type: 'boolean', description: 'Only videos whose post date passed in the last 7 days and are not posted (older past-dated cards are treated as already posted)' },
        include_posted: { type: 'boolean' },
      },
    },
  },
  {
    name: 'editor_output',
    description: 'How many videos the editors delivered, from the Video Intake database (every Editor Handoff Form submission, full history, not limited to recent tracking). Per editor: videos delivered in the period, short vs long form, sponsor count, revision rounds, changes requested, posted, average edit / revision / total cycle hours, draft SLA results. Also delivered per creator and a list of the videos. Use this for any question about how many videos were edited, delivered or submitted, or how an editor is performing.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD start (inclusive, IST)' },
        to: { type: 'string', description: 'YYYY-MM-DD end (inclusive, IST)' },
        days: { type: 'number', description: 'Look-back in days when from is not given, default 7' },
        editor: { type: 'string' },
        creator: { type: 'string' },
        include_videos: { type: 'boolean', description: 'Default true' },
      },
    },
  },
  {
    name: 'team_activity',
    description: 'Status moves on the creator boards from STATUS HISTORY (only since 2026-09-25). For editor delivery counts use editor_output instead. Covers: per editor videos submitted for review, changes received, reached ready, posted, average hours in edit; for Shreya scripts drafted and sent for approval; plus the recent moves. Use for Shreya script output and recent board moves.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look-back window in days, default 7' },
        from: { type: 'string', description: 'Optional YYYY-MM-DD, overrides days' },
        to: { type: 'string', description: 'Optional YYYY-MM-DD' },
        person: { type: 'string', description: 'Editor or scriptwriter name' },
        creator: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_log',
    description: 'What the AI project manager itself has done: AGENT LOG events (emails sent, alerts, skipped, blocked, needs approval, errors) with AI cost and tokens.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Default 7' },
        area: { type: 'string', description: 'Brand deals, Production, Team, Inboxes, Briefs or System' },
        outcome: { type: 'string' },
      },
    },
  },
  {
    name: 'search_notion',
    description: 'Search the NOOCAP Notion workspace by title. Use to find a specific page (a brief, a script, an SOP) when the other tools do not cover it.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'read_page',
    description: 'Read one Notion page: its properties and first ~100 blocks of text. Pass a page id or URL from another tool.',
    input_schema: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] },
  },
  {
    name: 'remember',
    description: 'Save one lasting thing to PM MEMORY so you know it in every future chat. Use when the user says remember, corrects you, or states a lasting fact, rule, preference or definition about the agency. Write one clear self-contained sentence with names and numbers, e.g. "Brad\'s invoices are net 30." Do not save one-off questions, current numbers or statuses that live in Notion, or your own guesses.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'One self-contained sentence' },
        category: { type: 'string', enum: ['Rule', 'Fact', 'Preference', 'Correction', 'Person', 'Money'] },
      },
      required: ['note'],
    },
  },
  {
    name: 'forget',
    description: 'Stop using a saved memory (ticks Forget in PM MEMORY). Use when the user says to forget something, or before saving a memory that replaces an older one. Prefer memory_id like MEM-3 from the PM MEMORY list.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'e.g. MEM-3' },
        text: { type: 'string', description: 'Part of the note, if no id' },
      },
    },
  },
];

const IMPL = {
  money_summary: moneySummary,
  deals,
  pipeline,
  team_activity: teamActivity,
  editor_output: editorOutput,
  agent_log: agentLog,
  search_notion: searchNotion,
  read_page: readPage,
  remember,
  forget,
};

export async function runTool(name, input, ctx = {}) {
  const fn = IMPL[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try {
    return await fn(input || {}, ctx);
  } catch (e) {
    return { error: String(e.message || e).slice(0, 400) };
  }
}
