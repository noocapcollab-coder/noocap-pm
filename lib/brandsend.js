// "Send to Brand" on EDIT TRACKER. Harsh checks the cut and switches the row's Status to "Send to Brand"; the PM then
// writes the cut email (Frame.io link included) in the brand's email thread and sends it straight away, with no stop in
// Approvals. On success the row moves to "With Brand" and gets "Sent To Brand At". When it can't send (no deal, no
// brand email, a WhatsApp deal, Gmail refused), the row goes back to "In Review" with the reason in "Brand Send Note"
// and #pm-alerts gets told, so nothing sits on "Send to Brand" looking sent when it wasn't.
//
// n8n's EDIT TRACKER watcher calls /api/tick?cuts=now within about 2 minutes of the switch; the heartbeat runs it
// again every 10 minutes as a backup (only for rows switched more than 3 minutes ago, so the two never race).
import { notion, plain } from './notion.js';
import { DS } from './tools.js';
import { openDeals, discord } from './briefs.js';
import { createDraft, pendingDraft, writeEmail, approveAndSend, OUTBOX_DS } from './outbox.js';
import { readIntake, sameVideoCreator, titleNamesBrand, moveCardToBrandApproval } from './intake.js';

export const SEND_STATUS = 'Send to Brand';
export const SENT_STATUS = 'With Brand';
const CLOSED = ['Posted', 'Invoiced', 'Paid'];
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];

// The brand deal a video row belongs to: same creator, the title names the brand. Open deals win over closed ones,
// and when two brands both match ("Zen" and "ZenBusiness") the longer brand name wins.
export function pickDealForRow(row, deals) {
  const hits = (deals || []).filter((d) => d && sameVideoCreator(row.creator, d.creator) && titleNamesBrand(row.title, d.brand));
  const rank = (d) => (CLOSED.includes(d.stage) ? 0 : 1000) + String(d.brand || '').length;
  return hits.sort((a, b) => rank(b) - rank(a))[0] || null;
}

// Why this row can't be emailed, or null when it can
export function sendBlocker(row, deal) {
  if (!row.frame) return 'No Frame.io link on the row. Add it, then switch to Send to Brand again.';
  if (!deal) return `No brand deal found for "${row.title}" (${row.creator || 'no creator'}). The video title needs the brand's name, and the deal must exist in Brand Deals.`;
  if (deal.channel === 'WhatsApp') return `${deal.brand} is handled on WhatsApp, so no email went out. Pass the link on by hand: ${row.frame}`;
  if (!/@/.test(deal.brandEmail || '')) return `The ${deal.brand} deal has no brand email. Add it on the deal, then switch to Send to Brand again.`;
  return null;
}

// Has this exact link already been emailed to the brand since the last change request?
async function alreadySent(dealId, frame, since) {
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [
    { property: 'Deal', relation: { contains: dealId } },
    { property: 'Status', select: { equals: 'Sent' } },
    { property: 'Body', rich_text: { contains: frame.slice(0, 90) } },
    ...(since ? [{ timestamp: 'created_time', created_time: { after: new Date(since).toISOString() } }] : []),
  ] } }).catch(() => ({ results: [] }));
  return (r.results || [])[0] || null;
}

async function setRow(id, status, note, sentAt) {
  const properties = { Status: { select: { name: status } }, 'Brand Send Note': { rich_text: rt(note) } };
  if (sentAt) properties['Sent To Brand At'] = { date: { start: sentAt } };
  await notion('PATCH', `/pages/${id}`, { properties });
}

async function tellThread(page, content) {
  // the video's 🎬 thread, or for older videos the "Changes — <title>" thread the editor worked in
  const t = String(plain(page.properties?.['Editor Thread ID']) || plain(page.properties?.['Changes Thread ID']) || '');
  if (!/^\d{15,}$/.test(t)) return;
  try { const E = await import('./editorthreads.js'); await E.postToThread(t, content); } catch (e) { console.error('thread note failed', e.message); }
}

// What the cut email may say it contains. The email writer reads the deal history, so when a brand asked for "the
// video and the caption" it would happily write "caption included" when there is none (ElevenLabs, 26 Oct). Only
// what is really attached may be mentioned.
export function cutInstructions(caption, revised = false) {
  // Revised rounds: this email delivers the changes, it does not reply to anything else in the thread (Polar, Nov 10)
  const only = 'This email only hands over the cut. Do not answer or raise anything else from the thread (billing, invoices, payment, dates, other questions) and never say a cut or version is still coming.';
  const rev = revised ? ' This is the revised cut that already makes the changes the brand asked for: say so in one sentence.' : '';
  return only + rev + ' ' + (caption
    ? 'The post caption is pasted below the email by the system, word for word. Say in one short sentence that the caption is below for their review. Do not write the caption yourself.'
    : 'This email carries only the review link. Do not say or suggest that a caption, script, thumbnail, file or anything else is included or attached.');
}

// A revised cut email must say it IS the revised cut, and nothing else. Polar x Valeri (system check, Nov 10): the
// round-2 cut (music swapped as Ushni asked) went out saying "we'll get you the revised cut for a final check before
// we post" and asked Polar, who pays through Gusto and already had 3 billing reminders, for billing details again.
// The writer had answered the brand's latest email instead of delivering the cut. These are the lines a cut email
// may never carry; when one shows up the plain cut email below is sent instead.
const CUT_PROMISE = /\b(?:we'?ll|we will|i'?ll|i will|will)\b[^.\n]{0,40}\b(?:get|send|share|have|deliver)\b[^.\n]{0,30}\b(?:revised|updated|new|final|edited)\s+(?:cut|version|video|edit|draft)\b/i;
const CUT_OFFTOPIC = /\b(?:billing|invoic\w*|company name|billing address|payment details|paypal|bank details|w-?9)\b/i;
export function cutBodyProblems(body, revised) {
  const t = String(body || '');
  const out = [];
  if (revised && CUT_PROMISE.test(t)) out.push('promises a revised cut later while this email is the revised cut');
  if (CUT_OFFTOPIC.test(t)) out.push('raises billing or invoices, which a cut email never does');
  return out;
}
export function plainCutBody(written, frame, creator, revised) {
  const hi = (String(written || '').match(/^\s*((?:Hi|Hello|Hey)\b[^\n,]{0,40},)/i) || [])[1] || 'Hi,';
  const line = revised ? `Here is the revised cut with the changes you asked for: ${frame}` : `Here is the cut for your review: ${frame}`;
  return `${hi}\n\n${line}\n\nBest,\n${creator ? creator + "'s Team" : 'The Team'}`;
}

// The final body: the review link always in it, and the caption (when there is one) word for word above the signature
export function cutBody(text, frame, caption) {
  let body = String(text || '');
  const add = (block) => {
    const m = body.match(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i);
    body = m ? body.slice(0, m.index) + `\n\n${block}` + m[0] : body + `\n\n${block}`;
  };
  if (!body.includes(frame)) add(`Review link: ${frame}`);
  if (caption && !body.includes(caption)) add(`Post caption:\n${caption}`);
  return body;
}

const SETTLE_MS = 60 * 1000;

// The deal's contact as it is right now (the list of deals can lag behind an edit made a moment ago)
async function freshDeal(deal) {
  const p = await notion('GET', `/pages/${deal.id}`).catch(() => null);
  if (!p) return deal;
  const get = (n) => plain(p.properties?.[n]);
  return { ...deal, brandEmail: get('Brand Email') || deal.brandEmail, threadCc: get('Thread CC') || deal.threadCc, channel: get('Channel') || deal.channel, stage: get('Deal Stage') || deal.stage, memory: get('Deal Memory') || deal.memory };
}

// Writes the email, makes sure the link is in it, and sends it. Returns the address it went to.
async function sendCut(row, deal) {
  const round = (row.revisions || 0) + 1;
  // An older cut email still waiting in Approvals is replaced, so the brand only ever gets this one
  // (only this video's: another video's revised cut waiting in Approvals is left alone)
  const old = await pendingDraft(deal.id, 'Draft video').catch(() => null);
  const oldBody = old ? (old.properties?.Body?.rich_text || []).map((t) => t.plain_text).join('') : '';
  if (old && (oldBody.includes(row.frame) || (row.title && oldBody.includes(row.title)))) await notion('PATCH', `/pages/${old.id}`, { properties: { Status: { select: { name: 'Rejected' } } } });
  const caption = String(row.caption || '').trim();
  const mail = await writeEmail({ kind: 'Draft video', deal, facts: { frame_io_link: row.frame, video_title: row.title, round, revised: round > 1, ...(caption ? { post_caption_included_below: true } : {}) }, instructions: cutInstructions(caption, round > 1) });
  let written = mail.body;
  if (cutBodyProblems(written, round > 1).length) written = plainCutBody(written, row.frame, deal.creator, round > 1);
  const body = cutBody(written, row.frame, caption);
  const why = `Harsh switched "${row.title}" to Send to Brand (${round > 1 ? 'revised cut, round ' + round : 'first cut'}).`;
  const d = await createDraft({ kind: 'Draft video', deal, subject: mail.subject, body, video: deal.linkedVideo || row.url, why, notify: false, sameAs: row.frame });
  if (!d.created) throw new Error(d.reason || 'could not write the email');
  try {
    await approveAndSend(d.id);
  } catch (e) {
    // leave nothing half-done in Approvals: the row goes back to In Review and says why
    await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
    throw e;
  }
  try { const { retireRepliesFor } = await import('./outbox.js'); await retireRepliesFor(deal.threadId, d.id); } catch { /* fine */ }
  return deal.brandEmail;
}

// A revised cut after the BRAND's changes goes straight back to the brand, with no stop at In Review and no email
// for Harsh to approve (Harsh, Nov 5: ZEN UGC 3 sat at In Review two days after Prateek wrote done). The n8n "done"
// listener already sends these rows to Send to Brand; this is the backup for a "done" it missed.
// One row at a time, so a deal with several videos (ZenBusiness: UGC 1, 2, 3) gets each revised cut sent.
// Brand round = the brand's email asked for the changes (Revisions bumped) or the cut was already sent to the brand.
// Only rows finished after BRAND_ROUND_FROM, so older rows sitting at In Review are never emailed out of the blue.
export const BRAND_ROUND_FROM = '2026-11-05T12:45:00Z';
export function isBrandRound(p, from = BRAND_ROUND_FROM) {
  const pr = p?.properties || {};
  if (plain(pr.Status) !== 'In Review' || !plain(pr['Frame.io Link'])) return false;
  const revisions = Number(pr.Revisions?.number || 0);
  const sentBefore = !!pr['Sent To Brand At']?.date?.start;
  if (!revisions && !sentBefore) return false;
  const asked = pr['Changes Requested At']?.date?.start;
  if (!asked) return false;
  const back = Date.parse(p.last_edited_time || 0);
  return back > Date.parse(asked) && back > Date.parse(from);
}

export async function brandRoundsToSend({ report = { drafts: [], errors: [] } } = {}) {
  const q = (ds) => notion('POST', `/data_sources/${ds}/query`, { page_size: 30, filter: { and: [
    { property: 'Status', select: { equals: 'In Review' } },
    { timestamp: 'last_edited_time', last_edited_time: { after: BRAND_ROUND_FROM } },
  ] } }).then((r) => r.results || []).catch(() => []);
  const rows = [...(await q(DS.tracker)), ...(await q(DS.intake))].filter((p) => isBrandRound(p));
  const moved = [];
  for (const p of rows) {
    await notion('PATCH', `/pages/${p.id}`, { properties: { Status: { select: { name: SEND_STATUS } }, 'Brand Send Note': { rich_text: rt('Brand changes done, sending the revised cut back to the brand.') } } }).catch((e) => report.errors?.push(`Brand round ${p.id}: ${String(e.message).slice(0, 80)}`));
    moved.push(plain(p.properties?.['Video Title']) || p.id);
  }
  return moved;
}

// rowId: only that row (the n8n call). minAgeMin: skip rows switched less than this long ago (the heartbeat backup).
export async function sendCutsToBrands({ rowId, minAgeMin = 0, report = { drafts: [], errors: [] } } = {}) {
  let pages;
  if (rowId) {
    const p = await notion('GET', `/pages/${rowId}`).catch(() => null);
    pages = p && plain(p.properties?.Status) === SEND_STATUS ? [p] : [];
  } else {
    // EDIT TRACKER and Video Intake (older videos still finish there) both have the Send to Brand status
    const q = (ds) => notion('POST', `/data_sources/${ds}/query`, { page_size: 20, filter: { property: 'Status', select: { equals: SEND_STATUS } } }).then((r) => r.results || []).catch(() => []);
    pages = [...(await q(DS.tracker)), ...(await q(DS.intake))].filter((p) => !minAgeMin || Date.now() - Date.parse(p.last_edited_time) >= minAgeMin * 60e3);
  }
  if (!pages.length) return { sent: [], blocked: [] };

  const deals = await openDeals({ withClosed: true }).catch((e) => { throw new Error('Could not read Brand Deals: ' + e.message); });
  const out = { sent: [], blocked: [] };
  for (let page of pages) {
    // Notion can hand back a row (and a deal) a few seconds out of date right after someone edits them: DREAMINA 2
    // went out with the old link and the old contact because the link, the contact and the status were all changed
    // within a minute of the send. So wait until the row has been still for a minute, then read everything fresh.
    const age = Date.now() - Date.parse(page.last_edited_time);
    if (age < SETTLE_MS) await new Promise((r) => setTimeout(r, SETTLE_MS - age));
    page = await notion('GET', `/pages/${page.id}`).catch(() => page);
    if (plain(page.properties?.Status) !== SEND_STATUS) continue;
    const row = { ...readIntake(page), creator: plain(page.properties?.Creator) || '', caption: plain(page.properties?.['Post Caption']) || '' };
    let deal = pickDealForRow(row, deals);
    if (deal) deal = await freshDeal(deal);
    // Claim the row first: another run that sees "Sending..." from the last 3 minutes leaves it alone
    const note = String(plain(page.properties?.['Brand Send Note']) || '');
    if (/^Sending/.test(note) && Date.now() - Date.parse(page.last_edited_time) < 3 * 60e3) continue;
    await notion('PATCH', `/pages/${row.id}`, { properties: { 'Brand Send Note': { rich_text: rt('Sending...') } } }).catch(() => {});
    try {
      const stop = sendBlocker(row, deal);
      if (stop) {
        await setRow(row.id, 'In Review', stop);
        await discord(`⚠️ **Couldn't send "${row.title}" to the brand**\n• ${stop}\n• The row is back on In Review.`, 'pm');
        out.blocked.push(`${row.title}: ${stop}`);
        continue;
      }
      const dup = await alreadySent(deal.id, row.frame, row.revisions ? row.changesAt : null);
      if (dup) {
        await setRow(row.id, SENT_STATUS, `Already emailed to ${deal.brand} on ${String(dup.created_time).slice(0, 10)}, not sent again.`, dup.created_time);
        await moveCardToBrandApproval(row);
        out.sent.push(`${row.title}: already with ${deal.brand}`);
        continue;
      }
      const to = await sendCut(row, deal);
      const now = new Date().toISOString();
      await setRow(row.id, SENT_STATUS, `Sent to ${to} in the ${deal.brand} thread.`, now);
      await moveCardToBrandApproval(row);
      await tellThread(page, `📤 **Sent to ${deal.brand}** for review. Waiting on their feedback.`);
      await discord(`📤 **${deal.brand} × ${deal.creator}: cut sent to the brand**\n• "${row.title}" went to ${to}\n• ${row.frame}`, 'log');
      out.sent.push(`${row.title} → ${to}`);
      report.drafts?.push(`Cut sent to ${deal.brand}: ${row.title}`);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      await setRow(row.id, 'In Review', `Not sent: ${msg}`).catch(() => {});
      await discord(`⚠️ **Couldn't send "${row.title}" to ${deal?.brand || 'the brand'}**\n• ${msg}\n• The row is back on In Review.`, 'pm').catch(() => {});
      out.blocked.push(`${row.title}: ${msg}`);
      report.errors?.push(`Send to Brand ${row.title}: ${msg.slice(0, 120)}`);
    }
  }
  return out;
}
