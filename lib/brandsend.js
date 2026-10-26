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
import { readIntake, sameVideoCreator, titleNamesBrand } from './intake.js';

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
  const t = String(plain(page.properties?.['Editor Thread ID']) || '');
  if (!/^\d{15,}$/.test(t)) return;
  try { const E = await import('./editorthreads.js'); await E.postToThread(t, content); } catch (e) { console.error('thread note failed', e.message); }
}

// What the cut email may say it contains. The email writer reads the deal history, so when a brand asked for "the
// video and the caption" it would happily write "caption included" when there is none (ElevenLabs, 26 Oct). Only
// what is really attached may be mentioned.
export function cutInstructions(caption) {
  return caption
    ? 'The post caption is pasted below the email by the system, word for word. Say in one short sentence that the caption is below for their review. Do not write the caption yourself.'
    : 'This email carries only the review link. Do not say or suggest that a caption, script, thumbnail, file or anything else is included or attached.';
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

// Writes the email, makes sure the link is in it, and sends it. Returns the address it went to.
async function sendCut(row, deal) {
  const round = (row.revisions || 0) + 1;
  // An older cut email still waiting in Approvals is replaced, so the brand only ever gets this one
  const old = await pendingDraft(deal.id, 'Draft video').catch(() => null);
  if (old) await notion('PATCH', `/pages/${old.id}`, { properties: { Status: { select: { name: 'Rejected' } } } });
  const caption = String(row.caption || '').trim();
  const mail = await writeEmail({ kind: 'Draft video', deal, facts: { frame_io_link: row.frame, video_title: row.title, round, revised: round > 1, ...(caption ? { post_caption_included_below: true } : {}) }, instructions: cutInstructions(caption) });
  const body = cutBody(mail.body, row.frame, caption);
  const why = `Harsh switched "${row.title}" to Send to Brand (${round > 1 ? 'revised cut, round ' + round : 'first cut'}).`;
  const d = await createDraft({ kind: 'Draft video', deal, subject: mail.subject, body, video: deal.linkedVideo || row.url, why, notify: false });
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
  for (const page of pages) {
    const row = { ...readIntake(page), creator: plain(page.properties?.Creator) || '', caption: plain(page.properties?.['Post Caption']) || '' };
    const deal = pickDealForRow(row, deals);
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
        out.sent.push(`${row.title}: already with ${deal.brand}`);
        continue;
      }
      const to = await sendCut(row, deal);
      const now = new Date().toISOString();
      await setRow(row.id, SENT_STATUS, `Sent to ${to} in the ${deal.brand} thread.`, now);
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
