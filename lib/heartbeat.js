// PM · Heartbeat. n8n calls /api/tick every 30 minutes.
// Looks at deals and their videos, drafts the emails that are due, and sends the morning brief once a day.
import { notion, plain, titleOf } from './notion.js';
import { BOARDS, DS, todayIST, runTool } from './tools.js';
import { schemaOf, findProp } from './actions.js';
import { openDeals, setIf, discord, log } from './briefs.js';
import { createDraft, pendingDraft, writeEmail, OUTBOX_DS } from './outbox.js';
import { runDriveFolders } from './drive.js';

const MAX_DRAFTS_PER_TICK = 6;
const FOLLOW_UP_AFTER_DAYS = 3;
const MAX_FOLLOW_UPS = 3;
const WAITING_ON_BRAND = ['Price Agreed', 'Script Sent', 'Submitted'];
const pageIdFromUrl = (u) => (String(u || '').match(/([0-9a-f]{32})(?:[?#/]|$)/i) || [])[1] || null;
const daysSince = (d) => (d ? Math.floor((new Date(todayIST()) - new Date(String(d).slice(0, 10))) / 864e5) : null);
const istHour = () => new Date(Date.now() + 5.5 * 36e5).getUTCHours();

async function videoInfo(url) {
  const id = pageIdFromUrl(url);
  if (!id) return null;
  try {
    const page = await notion('GET', `/pages/${id}`);
    let status = '', postedUrl = null;
    for (const [name, p] of Object.entries(page.properties || {})) {
      const n = name.toLowerCase();
      if (n === 'status') status = plain(p) || '';
      if (p.type === 'url' && /posted/.test(n) && p.url) postedUrl = p.url;
    }
    return { id, url: page.url, title: titleOf(page), status, num: parseInt(status, 10), postedUrl };
  } catch {
    return null;
  }
}

export async function runHeartbeat({ force = false } = {}) {
  const deals = await openDeals();
  const report = { drafts: [], handed_to_harsh: [], brief: null, errors: [] };
  let budget = MAX_DRAFTS_PER_TICK;
  const draft = async (kind, deal, args) => {
    if (budget <= 0) return;
    if (await pendingDraft(deal.id, kind)) return;
    budget--;
    try {
      const mail = await writeEmail({ kind, deal, facts: args.facts || {} });
      const r = await createDraft({ kind, deal, subject: mail.subject, body: mail.body, attach: args.attach || 'None', video: args.video || deal.linkedVideo, why: args.why });
      if (r.created) report.drafts.push(`${kind}: ${deal.brand} × ${deal.creator}`);
    } catch (e) {
      report.errors.push(`${kind} ${deal.brand}: ${e.message.slice(0, 150)}`);
    }
  };

  for (const deal of deals) {
    if (deal.paused) continue;
    try {
      const video = deal.linkedVideo ? await videoInfo(deal.linkedVideo) : null;

      // 1. Script is ready (video at 5- Script Approval) -> send it to the brand
      if (video && video.num === 5 && ['Brief Received', 'Signed', 'Price Agreed', null, undefined].includes(deal.stage) && !deal.scriptSent) {
        await draft('Script', deal, { attach: 'Script PDF', video: video.url, why: `Shreya's script for "${video.title}" is ready (status ${video.status}).`, facts: { video_title: video.title, deliverables: deal.deliverables, go_live: deal.deadline } });
      }

      // 2. Video is live -> send the posted link
      if (video && video.num === 12 && !deal.linksSent) {
        const links = deal.postedLinks || video.postedUrl;
        if (links) await draft('Posted links', deal, { why: `"${video.title}" is posted.`, facts: { links, video_title: video.title } });
      }

      // 3. Brand has gone quiet -> follow up (max 3, then hand to Harsh)
      if (WAITING_ON_BRAND.includes(deal.stage) && deal.brandEmail) {
        const lastOur = deal.lastOur || deal.scriptSent || deal.confirmed || deal.teamCc;
        const brandSilent = lastOur && (!deal.lastBrand || String(deal.lastBrand).slice(0, 10) <= String(lastOur).slice(0, 10));
        const waited = daysSince(lastOur);
        if (brandSilent && waited >= FOLLOW_UP_AFTER_DAYS) {
          if (deal.followUps >= MAX_FOLLOW_UPS) {
            if (!deal.needsCheck) {
              const schema = await schemaOf(DS.deals);
              const p = {};
              setIf(schema, p, 'Needs Check', true);
              setIf(schema, p, 'Next Action', `No reply after ${deal.followUps} follow-ups. Harsh to decide.`);
              await notion('PATCH', `/pages/${deal.id}`, { properties: p });
              await discord(`🙋 **Over to you: ${deal.brand} × ${deal.creator}**\nNo reply after ${deal.followUps} follow-ups (${waited} days). I've stopped chasing.`, 'pm');
              report.handed_to_harsh.push(deal.brand);
            }
          } else {
            await draft('Follow-up', deal, { why: `No reply for ${waited} days at ${deal.stage} (follow-up ${deal.followUps + 1} of ${MAX_FOLLOW_UPS}).`, facts: { waiting_for: deal.stage === 'Script Sent' ? 'script approval' : deal.stage === 'Price Agreed' ? 'the brief and next steps' : 'their feedback', days_waiting: waited, follow_up_number: deal.followUps + 1 } });
          }
        }
      }

      // 4. Invoice unpaid -> chase on day 7, 14, 21
      if (deal.stage === 'Invoiced' && !deal.paidDate && deal.invoiceSent) {
        const days = daysSince(deal.invoiceSent);
        const chases = deal.followUps;
        if (chases < MAX_FOLLOW_UPS && days >= 7 * (chases + 1)) {
          await draft('Payment chase', deal, { why: `Invoice sent ${days} days ago and still unpaid (reminder ${chases + 1} of ${MAX_FOLLOW_UPS}).`, facts: { invoice_sent: deal.invoiceSent, due: deal.invoiceDue, amount: deal.invoiceAmount || deal.finalRate, reminder_number: chases + 1 } });
        } else if (chases >= MAX_FOLLOW_UPS && !deal.needsCheck) {
          const schema = await schemaOf(DS.deals);
          const p = {};
          setIf(schema, p, 'Needs Check', true);
          await notion('PATCH', `/pages/${deal.id}`, { properties: p });
          await discord(`🙋 **Payment still missing: ${deal.brand} × ${deal.creator}** after ${chases} reminders (${days} days). Over to you.`, 'pm');
          report.handed_to_harsh.push(deal.brand);
        }
      }
    } catch (e) {
      report.errors.push(`${deal.brand}: ${String(e.message).slice(0, 150)}`);
    }
  }

  // 5. Drive folders for videos that reached 6- To Film
  try {
    report.drive = await runDriveFolders();
    const made = report.drive.made || [];
    if (made.length) await discord(`📁 **Drive folders ready** (${made.length})\n` + made.map((m) => `• ${m.creator} · ${m.title} (${m.month})\n  Assets: ${m.assets}\n  Edited Videos: ${m.edited}${m.shared ? '' : '\n  ⚠️ sharing could not be set, share it by hand'}`).join('\n'), 'pm');
    for (const e of report.drive.errors || []) report.errors.push('drive ' + e);
  } catch (e) { report.errors.push('drive: ' + String(e.message).slice(0, 150)); }

  // 6. Morning brief, once a day after 9am IST
  if (force || istHour() >= 9) report.brief = await morningBrief({ force });
  return report;
}

async function briefSentToday() {
  const res = await notion('POST', `/data_sources/${DS.agentLog}/query`, {
    page_size: 1,
    filter: { and: [{ property: 'Area', select: { equals: 'Briefs' } }, { property: 'Time', date: { equals: todayIST() } }] },
  });
  return (res.results || []).length > 0;
}

export async function morningBrief({ force = false } = {}) {
  if (!force && (await briefSentToday())) return 'already sent today';
  const today = todayIST();
  const yesterday = new Date(new Date(today).getTime() - 864e5).toISOString().slice(0, 10);
  const [late, dealsR, team, drafts] = await Promise.all([
    runTool('pipeline', { only_overdue: true }),
    runTool('deals', {}),
    runTool('editor_output', { from: yesterday, to: yesterday, include_videos: false }),
    notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { property: 'Status', select: { equals: 'Draft' } } }),
  ]);
  const lines = [`☀️ **Morning brief · ${today}**`];

  const vids = late.videos || [];
  const readyLate = vids.filter((v) => v.stage === 'Ready');
  const editLate = vids.filter((v) => v.stage !== 'Ready');
  if (vids.length) {
    lines.push(`\n**Videos past their post date: ${vids.length}**`);
    for (const v of [...readyLate, ...editLate].slice(0, 8)) lines.push(`• ${v.creator}: ${v.title} (${v.status}, ${v.days_past_post_date}d late${v.editor ? ', ' + v.editor : ''})`);
    if (vids.length > 8) lines.push(`• …and ${vids.length - 8} more`);
  } else lines.push('\n✅ No videos past their post date.');

  const dueToday = (dealsR.actions_due || []).length;
  const overdueInv = dealsR.overdue_invoices || [];
  const nDrafts = (drafts.results || []).length;
  lines.push(`\n**Brand deals**`);
  lines.push(`• ${nDrafts} email${nDrafts === 1 ? '' : 's'} waiting for your approval`);
  if (dueToday) lines.push(`• ${dueToday} deal action${dueToday === 1 ? '' : 's'} due: ${(dealsR.actions_due || []).slice(0, 4).map((a) => `${a.brand} (${a.next_action || 'action'})`).join('; ')}`);
  if (overdueInv.length) lines.push(`• Overdue invoices: ${overdueInv.map((i) => `${i.brand} ${i.days_overdue}d`).join(', ')}`);
  const stages = Object.entries(dealsR.by_stage || {}).map(([s, v]) => `${s} ${v.deals}`).join(' · ');
  if (stages) lines.push(`• Open deals: ${stages}`);

  lines.push(`\n**Yesterday's editing**`);
  const eds = (team.editors || []).filter((e) => e.delivered);
  if (eds.length) lines.push(eds.map((e) => `${e.editor} ${e.delivered}`).join(' · ') + ` (total ${team.totals?.delivered || 0})`);
  else lines.push('No videos delivered through the intake form yesterday.');

  const text = lines.join('\n');
  const ok = await discord(text, 'pm');
  const rt = (s) => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];
  try {
    await notion('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id: DS.agentLog },
      properties: {
        Event: { title: rt(`Morning brief ${today}`) },
        Time: { date: { start: today } },
        Area: { select: { name: 'Briefs' } },
        Outcome: { select: { name: ok ? 'Sent' : 'Error' } },
        Source: { select: { name: 'Schedule' } },
        Model: { select: { name: 'None' } },
        Details: { rich_text: rt(text) },
      },
    });
  } catch { /* ignore */ }
  return ok ? 'sent' : 'not sent (DISCORD_PM_WEBHOOK missing?)';
}
