// Brand asks that fell through: the deal's memory says "We owe: …", the brand wrote last, and nothing is waiting in
// Approvals. That happens when a promise draft was rejected, when a rule shipped after the email arrived, or when the
// inbox read it wrong. Each one is put to Harsh on WhatsApp once (swipe-reply with the answer and it becomes the email),
// so nothing a brand asked for sits unanswered because no single email triggered the right path.
import { notion } from './notion.js';
import { DS } from './tools.js';
import { log, discord } from './briefs.js';
import { pendingDraft } from './outbox.js';

const day = (x) => String(x || '').slice(0, 10);

// The open item, or null. Pure, so it can be tested.
export function owedItem(deal, today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)) {
  if (!deal || deal.paused || deal.channel === 'WhatsApp' || ['Lost', 'Paid'].includes(deal.stage)) return null;
  const open = String(deal.memory || '').split(/OPEN NOW:/i)[1] || '';
  const m = open.match(/we owe:?\s*([^\n]+)/i);
  if (!m) return null;
  const owe = m[1].replace(/<br\s*\/?>.*$/i, '').trim().replace(/\.$/, '');
  if (!owe || /^(nothing|none|n\/a|-)\b/i.test(owe)) return null;
  // The brand spoke last, within the last 10 days
  if (!deal.lastBrand || (deal.lastOur && day(deal.lastOur) >= day(deal.lastBrand))) return null;
  const age = (Date.parse(today) - Date.parse(day(deal.lastBrand))) / 864e5;
  if (age > 10) return null;
  return { need: owe.slice(0, 300), since: day(deal.lastBrand) };
}

export async function sweepOwed(deals, { now } = {}) {
  const asked = [];
  for (const deal of deals) {
    if (asked.length >= 5) break; // never flood the chat in one run; the rest come next heartbeat
    const item = owedItem(deal, now);
    if (!item) continue;
    if (await pendingDraft(deal.id, 'Reply').catch(() => true)) continue;
    const mark = `${deal.id} ${item.since}`;
    const seen = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: 'Owed ask' } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length > 0).catch(() => true);
    if (seen) continue;
    const ask = { dealId: deal.id, brand: deal.brand, creator: deal.creator, need: item.need, threadId: deal.threadId || '', messageRfc: deal.messageRfc || '', subject: deal.threadSubject || '', brandEmail: deal.brandEmail || '', theirMessage: `(last brand email ${item.since}) ${item.need}` };
    try { const W = await import('./whatsapp.js'); await W.askForInfo(ask); } catch (e) { console.error('owed ask', e.message); }
    await discord(`🙋 **${deal.brand} × ${deal.creator} is still waiting on us** since ${item.since}: ${item.need}. Nothing is drafted. Swipe-reply on WhatsApp with the answer and I'll draft it into their thread. ${deal.url || ''}`, 'pm').catch(() => {});
    await log({ event: `Owed ask: ${deal.brand} × ${deal.creator}`, outcome: 'Alert', email: { messageId: '' }, deal, details: `${mark} · ${item.need}`, area: 'Brand deals', creator: deal.creator }).catch(() => {});
    asked.push(`${deal.brand} × ${deal.creator}`);
  }
  return asked;
}
