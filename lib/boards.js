// Deals board: every open brand deal in the one column that says what has to happen next.
// Computed from Notion (deals, Outbox drafts, creator boards, Video Intake, Sponsor Video Revenue), no AI, no manual moving.
import { notion, plain } from './notion.js';
import { DS, todayIST } from './tools.js';
import { readIntake, intakeCreator } from './intake.js';

export const COLUMNS = [
  { key: 'reply', title: 'Reply needed', hint: 'The brand asked something' },
  { key: 'script', title: 'Script to send', hint: 'Brief in, script not with the brand yet' },
  { key: 'video', title: 'Video to share', hint: 'Cut being edited or ready for the brand' },
  { key: 'waiting', title: 'Waiting on brand', hint: 'We spoke last' },
  { key: 'promised', title: 'We promised', hint: 'Contract, invoice or links we said we would send' },
  { key: 'money', title: 'Payment to collect', hint: 'Invoice, payment and NOOCAP cut' },
];

const MAX_NUDGES = 3;
const DEAD_AFTER = 30; // days with no email either way: the thread is dead, keep it off the board
const day = (d) => (d ? String(d).slice(0, 10) : null);
const daysSince = (d, today) => (d ? Math.max(0, Math.round((Date.parse(today) - Date.parse(day(d))) / 864e5)) : null);
const pageId = (u) => ((String(u || '').match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1] || String(u || '').replace(/-/g, '')).toLowerCase();
const normBrand = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
const num = (s) => parseInt(s, 10) || 0;

export async function intakeRowsOpen() {
  const res = await notion('POST', `/data_sources/${DS.intake}/query`, { page_size: 100, filter: { property: 'Status', select: { does_not_equal: 'Posted' } }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] });
  return (res.results || []).map((p) => ({ ...readIntake(p), creator: plain(p.properties?.Creator) }));
}

export function buildBoard({ deals = [], drafts = [], videos = [], intake = [], chase = {}, today = todayIST() }) {
  const cols = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  const moneyDrafts = [];
  const videoById = new Map(videos.map((v) => [pageId(v.url || v.id), v]));
  const draftsByDeal = new Map();
  for (const d of drafts) if (d.dealId) { const k = d.dealId.replace(/-/g, ''); (draftsByDeal.get(k) || draftsByDeal.set(k, []).get(k)).push(d); }

  for (const d of deals) {
    if (d.paused || /^(Paid|Lost)$/.test(d.stage || '')) continue;
    const mine = draftsByDeal.get(String(d.id).replace(/-/g, '')) || [];
    const draftOf = (...kinds) => mine.find((x) => kinds.includes(x.kind));
    const lastOur = [d.lastOur, d.scriptSent, d.linksSent, d.invoiceSent, d.confirmed].map(day).filter(Boolean).sort().pop() || null;
    const theirs = day(d.lastBrand);
    const video = d.linkedVideo ? videoById.get(pageId(d.linkedVideo)) : null;
    const base = { id: d.id, brand: d.brand, creator: d.creator || '?', stage: d.stage || 'No stage', url: d.url, needsCheck: d.needsCheck };
    const put = (col, extra) => cols[col].push({ ...base, ...extra });
    const promise = /^Send /.test(d.nextAction || '');
    const lastTouch = [lastOur, theirs].filter(Boolean).sort().pop();
    const dead = !mine.length && !promise && lastTouch && daysSince(lastTouch, today) > DEAD_AFTER;
    if (dead) continue;

    // 1. The brand is waiting on an answer
    const reply = draftOf('Reply');
    if (reply || (theirs && (!lastOur || theirs > lastOur))) {
      put('reply', { tag: reply ? 'Draft ready' : 'No draft yet', tone: reply ? 'go' : 'warn', sub: theirs ? `they wrote ${daysSince(theirs, today)}d ago` : '', days: daysSince(theirs, today) ?? 0, draft: reply?.id || null });
      continue;
    }
    // 2. Something we said we'd send (or posted links the brand is expecting)
    const linksDraft = draftOf('Posted links');
    if (linksDraft && !promise) { put('promised', { tag: 'Draft ready', tone: 'go', sub: 'posted links', days: 0, draft: linksDraft.id }); continue; }
    if (promise) {
      const due = day(d.nextActionDate);
      const late = due && due < today ? daysSince(due, today) : 0;
      put('promised', { tag: late ? `${late}d late` : 'Due ' + (due === today ? 'today' : due || 'soon'), tone: late ? 'bad' : 'warn', sub: d.nextAction.replace(/^Send .*? the /, '').replace(/\s*\(promised.*\)$/, ''), days: late });
      continue;
    }
    // Money stages live in the payment column (one card per posted video, from Sponsor Video Revenue)
    if (/^(Posted|Invoiced)$/.test(d.stage || '')) {
      const md = draftOf('Invoice', 'Payment chase');
      if (md) moneyDrafts.push({ deal: d, draft: md });
      continue;
    }

    // 3. Script: brief/price agreed but the script hasn't gone to the brand
    const scriptDraft = draftOf('Script');
    if (scriptDraft || (['Price Agreed', 'Signed', 'Brief Received'].includes(d.stage) && !d.scriptSent)) {
      const n = video ? num(video.status) : 0;
      const tag = scriptDraft ? 'Draft ready' : !d.linkedVideo ? 'No video card' : n >= 5 ? 'Script ready' : n >= 3 ? 'Being written' : 'Not started';
      put('script', { tag, tone: scriptDraft || n >= 5 ? 'go' : !d.linkedVideo ? 'bad' : 'muted', sub: video ? video.status : 'Link the video card in Notion', days: daysSince(d.confirmed || lastOur, today) ?? 0, draft: scriptDraft?.id || null });
      continue;
    }
    // 4. Video: script approved, the cut is being made or is ready to share
    const videoDraft = draftOf('Draft video');
    if (videoDraft || ['Script Approved', 'In Production'].includes(d.stage)) {
      const b = normBrand(d.brand);
      const row = intake.find((r) => r.creator === intakeCreator(d.creator) && b && normBrand(r.title).includes(b));
      const tag = videoDraft ? 'Draft ready' : row?.status === 'In Review' && row.frame ? 'Cut ready' : row?.status === 'Changes' ? 'Editor revising' : row ? 'In edit' : video && num(video.status) >= 7 ? 'In edit' : 'To film';
      put('video', { tag, tone: videoDraft || tag === 'Cut ready' ? 'go' : 'muted', sub: [row?.editor, video?.status].filter(Boolean).join(' · '), days: daysSince(d.scriptApproved, today) ?? 0, draft: videoDraft?.id || null, frame: row?.frame || null });
      continue;
    }
    // 5. We spoke last: waiting on the brand (nudge count shows how hard we've chased)
    if (lastOur) {
      const q = daysSince(lastOur, today);
      const nudge = draftOf('Follow-up');
      const tone = nudge ? 'go' : d.followUps >= MAX_NUDGES ? 'bad' : q >= 3 ? 'warn' : 'muted';
      const tag = nudge ? 'Nudge ready' : d.followUps >= MAX_NUDGES ? 'Over to you' : d.followUps ? `Nudge ${d.followUps}/${MAX_NUDGES}` : q >= 3 ? 'Nudge due' : 'Just sent';
      put('waiting', { tag, tone, sub: `${d.stage || 'No stage'} · quiet ${q}d`, days: q, draft: nudge?.id || null });
    }
  }

  // Drafts with no deal (brand we couldn't place yet) still need a reply
  for (const x of drafts.filter((x) => !x.dealId && x.kind === 'Reply')) {
    cols.reply.push({ id: x.id, brand: x.brand || 'Brand', creator: '?', stage: 'No deal yet', tag: 'Draft ready', tone: 'go', sub: 'not linked to a deal', days: daysSince(x.created, today) ?? 0, draft: x.id, url: null });
  }

  // 6. Money, per posted video
  const money = (xs, tag, tone, sub) => (xs || []).forEach((x) => cols.money.push({ id: x.url || `${x.brand}-${x.video}`, brand: x.brand, creator: x.creator, stage: x.video || '', tag, tone, sub: sub(x), days: x.days ?? 0, amount: x.amount || null, url: x.url }));
  money(chase.needs_invoice, 'Invoice to send', 'warn', (x) => `posted ${x.days}d ago`);
  money(chase.awaiting_payment, 'Chasing payment', 'bad', (x) => (x.invoiced ? `invoiced ${x.days}d ago` : `unpaid ${x.days}d`));
  money(chase.cut_pending, 'Cut to collect', 'go', (x) => `brand paid${x.cut_percent ? ` · ${x.cut_percent}% cut` : ''}`);

  // Invoice / payment-chase emails waiting in Approvals: pin them to that brand's card, or add a card if there isn't one
  for (const { deal, draft } of moneyDrafts) {
    const card = cols.money.find((c) => normBrand(c.brand) === normBrand(deal.brand) && c.creator === deal.creator && !c.draft);
    const tag = draft.kind === 'Invoice' ? 'Invoice draft ready' : 'Chase draft ready';
    if (card) Object.assign(card, { draft: draft.id, tag, tone: 'go' });
    else cols.money.push({ id: deal.id, brand: deal.brand, creator: deal.creator || '?', stage: deal.stage, tag, tone: 'go', sub: deal.stage, days: 0, draft: draft.id, url: deal.url });
  }

  for (const k of Object.keys(cols)) cols[k].sort((a, b) => (b.draft ? 1 : 0) - (a.draft ? 1 : 0) || (b.days || 0) - (a.days || 0));
  return { columns: COLUMNS.map((c) => ({ ...c, items: cols[c.key] })), total: Object.values(cols).reduce((n, xs) => n + xs.length, 0) };
}
