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
  { key: 'money', title: 'Payment from brand', hint: 'Invoice to send, or brand still to pay' },
  { key: 'cut', title: 'NOOCAP cut to collect', hint: 'Brand paid the creator, our cut is due' },
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
    const mine = draftsByDeal.get(String(d.id).replace(/-/g, '')) || [];
    // Closed or paused deals stay off the board, unless a reply to the brand is waiting in Approvals
    if ((d.paused || /^(Paid|Lost)$/.test(d.stage || '')) && !mine.some((x) => x.kind === 'Reply')) continue;
    const draftOf = (...kinds) => mine.find((x) => kinds.includes(x.kind));
    const lastOur = [d.lastOur, d.scriptSent, d.linksSent, d.invoiceSent, d.confirmed].map(day).filter(Boolean).sort().pop() || null;
    const theirs = day(d.lastBrand);
    // Linked video card, or the creator's card whose title names the brand
    const nb = normBrand(d.brand);
    const video = (d.linkedVideo && videoById.get(pageId(d.linkedVideo))) || (nb.length >= 3 ? videos.find((v) => v.creator === d.creator && v.stage !== 'Posted' && normBrand(v.title).includes(nb)) : null) || null;
    const na = d.nextAction || '';
    const base = { id: d.id, brand: d.brand, creator: d.creator || '?', stage: d.stage || 'No stage', url: d.url, amount: Number(d.finalRate || d.invoiceAmount || 0) || null };
    const put = (col, extra) => cols[col].push({ ...base, ...extra });
    const promise = /^Send /.test(na) && !/^Send the script/i.test(na); // a ready script sits in the Script column, not in promises
    const lastTouch = [lastOur, theirs].filter(Boolean).sort().pop();
    if (!mine.length && !promise && lastTouch && daysSince(lastTouch, today) > DEAD_AFTER) continue; // dead thread
    if (/^unknown/i.test(d.brand || '')) continue; // junk row

    // 1. Reply needed = the PM read a brand question and drafted the answer (a brand writing isn't always a question)
    const reply = draftOf('Reply');
    if (reply) { put('reply', { tag: 'Draft ready', tone: 'go', sub: theirs ? `they wrote ${daysSince(theirs, today)}d ago` : '', days: daysSince(theirs, today) ?? 0, draft: reply.id }); continue; }

    // 2. Something we said we'd send (or posted links the brand is expecting)
    const linksDraft = draftOf('Posted links');
    if (linksDraft && !promise) { put('promised', { tag: 'Draft ready', tone: 'go', sub: 'posted links', days: 0, draft: linksDraft.id }); continue; }
    if (promise) {
      const due = day(d.nextActionDate);
      const late = due && due < today ? daysSince(due, today) : 0;
      put('promised', { tag: late ? `${late}d late` : 'Due ' + (due === today ? 'today' : due || 'soon'), tone: late ? 'bad' : 'warn', sub: na.replace(/^Send .*? the /, '').replace(/\s*\(promised.*\)$/, ''), days: late });
      continue;
    }
    // Money stages: one card per posted video comes from Sponsor Video Revenue. A problem deal (flagged) still shows here.
    if (/^(Posted|Invoiced)$/.test(d.stage || '')) {
      const md = draftOf('Invoice', 'Payment chase');
      if (md) moneyDrafts.push({ deal: d, draft: md });
      else if (d.needsCheck && na) moneyDrafts.push({ deal: d, issue: na });
      continue;
    }
    // Brand approved the video: the editor bot handles CTAs and posting, nothing for you
    if (d.stage === 'Approved') continue;

    const waitingForBrief = /waiting for the brief/i.test(na);
    // 3. Script on our side: brief is in (or price agreed and not waiting on a brief) and the script hasn't gone out,
    //    or the brand asked for changes and Shreya is revising
    const scriptDraft = draftOf('Script');
    const revising = /revis|writing the script|script changes/i.test(na);
    // No stage set yet but the creator already has a card for this brand: its status says where the deal really is
    const vn = video ? num(video.status) : 0;
    const guessScript = !d.stage && vn >= 1 && vn <= 5, guessVideo = !d.stage && vn >= 6 && vn <= 9;
    if (scriptDraft || revising || guessScript || (!waitingForBrief && ['Price Agreed', 'Signed', 'Brief Received'].includes(d.stage) && !d.scriptSent)) {
      const n = video ? num(video.status) : 0;
      const tag = scriptDraft ? 'Draft ready' : /revis|changes/i.test(na) ? 'Being revised' : n >= 5 ? 'Script ready' : n >= 3 ? 'Being written' : video ? 'Not started' : na ? 'Before script' : 'No video card';
      const tone = scriptDraft || tag === 'Script ready' ? 'go' : tag === 'No video card' ? 'bad' : tag === 'Before script' ? 'warn' : 'muted';
      const sub = na && !/writing the script|revis|^Send the script/i.test(na) ? na : n >= 5 ? 'script is ready, send it from the email thread' : video ? video.status : 'No card on the creator board yet';
      put('script', { tag, tone, sub, days: daysSince(d.confirmed || lastOur, today) ?? 0, draft: scriptDraft?.id || null, url: d.url });
      continue;
    }
    // 4. Video: script approved, the cut is being made or is ready to share
    const videoDraft = draftOf('Draft video');
    if (videoDraft || guessVideo || ['Script Approved', 'In Production'].includes(d.stage)) {
      const row = intake.find((r) => r.creator === intakeCreator(d.creator) && nb && normBrand(r.title).includes(nb));
      const tag = videoDraft ? 'Draft ready' : row?.status === 'In Review' && row.frame ? 'Cut ready' : row?.status === 'Changes' ? 'Editor revising' : row ? 'In edit' : video && num(video.status) >= 7 ? 'In edit' : 'To film';
      put('video', { tag, tone: videoDraft || tag === 'Cut ready' ? 'go' : 'muted', sub: [row?.editor, video?.status].filter(Boolean).join(' · '), days: daysSince(d.scriptApproved, today) ?? 0, draft: videoDraft?.id || null, frame: row?.frame || null });
      continue;
    }
    // 5. Everything else is with the brand: brief pending, script or cut with them, negotiating, or a new deal
    const nudge = draftOf('Follow-up');
    const q = daysSince(lastOur || theirs, today);
    const tag = nudge ? 'Nudge ready' : !d.stage ? 'Set the stage' : d.followUps >= MAX_NUDGES ? 'Over to you' : d.followUps ? `Nudge ${d.followUps}/${MAX_NUDGES}` : waitingForBrief ? 'Brief pending' : q >= 3 ? 'Quiet' : 'With brand';
    const tone = nudge ? 'go' : !d.stage || d.followUps >= MAX_NUDGES ? 'bad' : q >= 3 ? 'warn' : 'muted';
    const what = { 'Script Sent': 'script with them', Submitted: 'cut with them', Negotiating: 'negotiating', Inbound: 'new enquiry', 'Price Agreed': 'price agreed', Signed: 'signed' }[d.stage] || (d.stage ? d.stage : 'new deal, stage not set');
    put('waiting', { tag, tone, sub: `${what}${q != null ? ` · last email ${q}d ago` : ''}`, days: q ?? 0, draft: nudge?.id || null });
  }

  // Drafts with no deal (brand we couldn't place yet) still need a reply
  const shown = new Set(deals.map((d) => String(d.id).replace(/-/g, '')));
  for (const x of drafts.filter((x) => x.kind === 'Reply' && (!x.dealId || !shown.has(x.dealId.replace(/-/g, ''))))) {
    cols.reply.push({ id: x.id, brand: x.brand || 'Brand', creator: x.creator || '?', stage: x.dealId ? 'Closed deal' : 'No deal yet', tag: 'Draft ready', tone: 'go', sub: x.dealId ? 'deal already closed in Notion' : 'not linked to a deal', days: daysSince(x.created, today) ?? 0, draft: x.id, url: null });
  }

  // 6. Money, per posted video
  const money = (xs, tag, tone, sub) => (xs || []).forEach((x) => cols.money.push({ id: x.url || `${x.brand}-${x.video}`, brand: x.brand, creator: x.creator, stage: x.video || '', tag, tone, sub: sub(x), days: x.days ?? 0, amount: x.amount || null, url: x.url }));
  money(chase.needs_invoice, 'Invoice to send', 'warn', (x) => `posted ${x.days}d ago`);
  money(chase.awaiting_payment, 'Chasing payment', 'bad', (x) => (x.invoiced ? `invoiced ${x.days}d ago` : `unpaid ${x.days}d`));
  (chase.cut_pending || []).forEach((x) => cols.cut.push({ id: 'cut-' + (x.url || `${x.brand}-${x.video}`), brand: x.brand, creator: x.creator, stage: x.video || '', tag: x.cut_percent ? `${x.cut_percent}% cut` : 'Cut due', tone: 'warn', sub: `brand paid${x.days != null ? ` ${x.days}d ago` : ''}${x.video && x.video !== x.brand ? ` · ${x.video}` : ''}`, days: x.days ?? 0, amount: x.amount || null, url: x.url }));

  // Invoice / payment-chase emails waiting in Approvals: pin them to that brand's card, or add a card if there isn't one
  for (const { deal, draft, issue } of moneyDrafts) {
    if (issue) { cols.money.push({ id: deal.id, brand: deal.brand, creator: deal.creator || '?', stage: deal.stage, tag: 'Needs you', tone: 'bad', sub: issue, days: 99, url: deal.url }); continue; }
    const card = cols.money.find((c) => normBrand(c.brand) === normBrand(deal.brand) && c.creator === deal.creator && !c.draft);
    const tag = draft.kind === 'Invoice' ? 'Invoice draft ready' : 'Chase draft ready';
    if (card) Object.assign(card, { draft: draft.id, tag, tone: 'go' });
    else cols.money.push({ id: deal.id, brand: deal.brand, creator: deal.creator || '?', stage: deal.stage, tag, tone: 'go', sub: deal.stage, days: 0, draft: draft.id, url: deal.url });
  }

  for (const k of Object.keys(cols)) cols[k].sort((a, b) => (b.draft ? 1 : 0) - (a.draft ? 1 : 0) || (b.days || 0) - (a.days || 0));
  return { columns: COLUMNS.map((c) => ({ ...c, items: cols[c.key] })), total: Object.values(cols).reduce((n, xs) => n + xs.length, 0) };
}
