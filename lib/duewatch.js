// Due watch (Harsh, Nov 25): "I can't keep fixing these things again and again." The system check and the bug hunter
// look for errors; the misses Harsh kept catching were things that should have happened and quietly didn't (Brad's
// revised script never went, Prateek's "done" was ignored, ElevenLabs November was never invoiced). This watch looks
// from the brand's side instead: every 30 minutes, is anything we owe someone overdue? Plain rules, no AI.
//
// Every miss Harsh points out from now on becomes a rule here (and a PM LESSONS row).
// Week one (until REPORT_ONLY_UNTIL) it only reports: one WhatsApp line per new item, never the same item twice.
import { notion, plain, queryAll } from './notion.js';
import { DS, allVideos } from './tools.js';
import { openDeals, discord, log } from './briefs.js';

export const REPORT_ONLY_UNTIL = '2026-12-02';
const H = 36e5;
const t = (v) => { const x = Date.parse(String(v || '').replace(' ', 'T')); return Number.isFinite(x) ? x : 0; };
// the page id is the last 32 hex characters (a title like "CapCut-Brad-38a5…" would otherwise read "d38a5…")
const hex = (u) => (String(u || '').split('?')[0].replace(/-/g, '').toLowerCase().match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/) || [''])[0];
const num = (s) => parseInt(String(s || ''), 10);
const DONE_STAGES = ['Lost', 'Paid'];
const PROMISE = /\b(shortly|later today|today|by tomorrow|tomorrow|by (?:mon|tues|wednes|thurs|fri|satur|sun)day|will (?:share|send|get back|update|follow up)|we'?ll (?:share|send|get back|update)|stated we will|committed to|promised)\b/i;

// The last line of the deal memory's HISTORY written by us, if it promised something and nothing of ours came after.
// Pure. "2026-11-20 us: Agreed to continue ..., stated we will share the revised script shortly."
export function openPromise(memory) {
  const hist = (String(memory || '').split(/HISTORY:/i)[1] || '').split(/\n\s*\n|BILLING:|OPEN NOW:/i)[0];
  const lines = hist.split(/\n|<br\s*\/?>/).map((l) => l.trim()).filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
  let last = null;
  for (const l of lines) if (/^\d{4}-\d{2}-\d{2}\s+us\b/i.test(l)) last = l;
  if (!last || !PROMISE.test(last)) return null;
  return { day: last.slice(0, 10), text: last.replace(/^\d{4}-\d{2}-\d{2}\s+us:?\s*/i, '').slice(0, 160) };
}

// All the rules. Pure: deals (openDeals), cards (allVideos), rows (EDIT TRACKER, flattened). Returns
// [{ key, rule, line }], key stable per item so the same thing is reported once.
export function findDue({ deals = [], cards = [], rows = [], now = Date.now() } = {}) {
  const out = [];
  const add = (key, rule, line) => out.push({ key, rule, line });
  const live = deals.filter((d) => !DONE_STAGES.includes(d.stage) && !d.paused);
  const cardById = new Map(cards.map((c) => [hex(c.id || c.url), c]));
  const name = (d) => `${d.brand} × ${d.creator}`;

  for (const d of live) {
    // 1. We told the brand something was coming and nothing of ours went after it (CapCut x Brad, Nov 20 -> 25)
    const p = openPromise(d.memory);
    const ourLast = t(d.lastOur);
    if (p && now - t(p.day + 'T23:59:00Z') > 24 * H && (!ourLast || ourLast < t(p.day + 'T23:59:00Z'))) {
      add(`promise ${hex(d.id)} ${p.day}`, 'promise', `${name(d)}: on ${p.day} we told them "${p.text}" and nothing has gone since`);
    }
    const card = cardById.get(hex(d.linkedVideo));
    const cn = card ? num(card.status) : NaN;
    // 2. Card says the script is with the brand's approval, deal says a cut was already submitted (CapCut x Brad)
    if (card && cn <= 5 && ['Submitted', 'Approved', 'Posted'].includes(d.stage) && now - t(card.edited) < 14 * 24 * H && ourLast < t(card.edited)) {
      add(`mismatch ${hex(d.id)} ${d.stage} ${cn}`, 'mismatch', `${name(d)}: the card is at ${card.status} but the deal says ${d.stage}, so the PM may skip the script`);
    }
    // 3. Script ready on the card for 2h+ and no script email since the card changed
    if (card && cn === 5 && card.sponsor !== false && now - t(card.edited) > 2 * H && now - t(card.edited) < 14 * 24 * H
      && t(d.scriptSent) < t(String(card.edited).slice(0, 10)) && ourLast < t(card.edited) && !/hold/i.test(card.title || '')
      && (!d.scriptSent || /revised|updated|new script|once shared by us/i.test(d.memory || ''))) {
      add(`script ${hex(card.id)} ${String(card.edited).slice(0, 10)}`, 'script', `${name(d)}: "${card.title}" has been at Script Approval since ${String(card.edited).slice(0, 16).replace('T', ' ')} UTC and no script went to the brand`);
    }
    // 4. Posted a day ago and no invoice or billing ask (ElevenLabs November, Nov 25)
    const postedAt = t(d.linksSent) || (d.stage === 'Posted' ? t(d.delivered) : 0);
    if (d.stage === 'Posted' && postedAt && now - postedAt > 24 * H && !d.invoiceSent && !String(d.stripeInvoices || '').trim() && !d.billingRequested && d.channel !== 'WhatsApp') {
      add(`invoice ${hex(d.id)}`, 'invoice', `${name(d)}: posted ${String(d.linksSent || d.delivered).slice(0, 10)}, no invoice and no billing ask yet`);
    }
  }

  for (const r of rows) {
    const status = r.Status || '';
    const req = t(r['Changes Requested At']), done = t(r['Changes Done At']), started = t(r['Started At']);
    const label = `${r['Video Title'] || 'video'} (${r.Editor || 'no editor'})`;
    // 5. Editor's "done" didn't move the video (Manyfast x Chris, Nov 24: row mid-edit with changes open for 15h)
    if (['Manual editing', 'Claude running', 'Editor review'].includes(status) && req > done && now - req > 24 * H && now - req < 14 * 24 * H) {
      add(`stuckedit ${hex(r.id)} ${String(r['Changes Requested At']).slice(0, 16)}`, 'stuckedit', `${label}: changes asked ${String(r['Changes Requested At']).slice(0, 16).replace('T', ' ')} UTC, still "${status}". If the editor already said done, it didn't register`);
    }
    // 6. Changes sent to the editor 12h ago and nobody started
    if (status === 'Changes' && req && now - req > 12 * H && now - req < 14 * 24 * H && started < req) {
      add(`notstarted ${hex(r.id)} ${String(r['Changes Requested At']).slice(0, 16)}`, 'notstarted', `${label}: changes sent ${String(r['Changes Requested At']).slice(0, 16).replace('T', ' ')} UTC and not started yet`);
    }
    // 7. Set to Send to Brand and the email never went
    if (status === 'Send to Brand' && now - t(r['Last Updated']) > 30 * 60e3) {
      add(`sendstuck ${hex(r.id)} ${String(r['Last Updated']).slice(0, 13)}`, 'sendstuck', `${label}: set to Send to Brand ${String(r['Last Updated']).slice(0, 16).replace('T', ' ')} UTC and the cut hasn't gone to the brand`);
    }
  }
  return out;
}

const flat = (p) => { const o = { id: p.id }; for (const [k, v] of Object.entries(p.properties || {})) o[k] = plain(v); o['Last Updated'] = o['Last Updated'] || p.last_edited_time; return o; };

async function reported(days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const res = await queryAll(DS.agentLog, { and: [{ property: 'Event', title: { starts_with: 'Due watch' } }, { timestamp: 'created_time', created_time: { on_or_after: since } }] }, { useCache: false, maxPages: 5 }).catch(() => []);
  return new Set(res.map((p) => plain(p.properties?.Details)).filter(Boolean));
}

// The run: find, keep only new items, one WhatsApp message for all of them. dry=true returns without sending.
export async function runDueWatch({ dry = false } = {}) {
  const [deals, { videos }, trackerPages] = await Promise.all([
    openDeals({ withClosed: true }),
    allVideos({ quick: true }),
    queryAll(DS.tracker, { or: ['Manual editing', 'Claude running', 'Editor review', 'Changes', 'Send to Brand'].map((s) => ({ property: 'Status', select: { equals: s } })) }, { useCache: false }).catch(() => []),
  ]);
  const items = findDue({ deals, cards: videos, rows: trackerPages.map(flat) });
  const seen = dry ? new Set() : await reported();
  const fresh = items.filter((i) => !seen.has(i.key));
  if (dry || !fresh.length) return { mode: 'report only', found: items.length, new: fresh.length, items: dry ? items : fresh };
  await discord(`🟡 **Overdue (${fresh.length})**\n${fresh.map((i) => `• ${i.line}`).join('\n')}`, 'pm');
  for (const i of fresh) await log({ event: `Due watch: ${i.rule}`, outcome: 'Alert', email: { messageId: '' }, details: i.key, area: 'Brand deals' }).catch(() => {});
  return { mode: 'report only', found: items.length, new: fresh.length, items: fresh };
}
