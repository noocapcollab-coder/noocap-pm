// PM · Heartbeat. n8n calls /api/tick every few minutes.
// Looks at deals and their videos, drafts the emails that are due, and sends the morning brief once a day.
import { notion, plain, titleOf } from './notion.js';
import { BOARDS, DS, todayIST, runTool, followGap, isWeekend } from './tools.js';
import { schemaOf, findProp } from './actions.js';
import { openDeals, setIf, discord, log } from './briefs.js';
import { createDraft, pendingDraft, writeEmail, stageBefore, OUTBOX_DS } from './outbox.js';
import { runDriveFolders } from './drive.js';
import { findIntakeRow } from './intake.js';
import { syncMoney, moneyDigest } from './money.js';

const MAX_DRAFTS_PER_TICK = 6;
// Autopilot: these email types send themselves after a hold, unless rejected in Approvals. PM_AUTOPILOT=off turns it off.
// Scripts: the PM drafts the email with the PDF and sends it itself after the hold. PM_SCRIPT_AUTOSEND=off makes script
// emails wait in Approvals instead; PM_SCRIPT_EMAILS=off stops drafting them at all (you send scripts by hand).
const SCRIPT_EMAILS = process.env.PM_SCRIPT_EMAILS !== 'off';
const SCRIPT_AUTO = SCRIPT_EMAILS && process.env.PM_SCRIPT_AUTOSEND !== 'off';
const KINDS_SET = String(process.env.PM_AUTOPILOT_KINDS || 'Follow-up').split(',').map((k) => k.trim()).filter(Boolean);
export const AUTO_KINDS = process.env.PM_AUTOPILOT === 'off' ? [] : [...KINDS_SET, ...(SCRIPT_AUTO && !KINDS_SET.includes('Script') ? ['Script'] : [])];
export const AUTO_HOLD_MIN = 30;
const AUTOPILOT_FROM = process.env.PM_AUTOPILOT_FROM || '2026-09-29T14:00:00Z'; // drafts made before autopilot existed still wait for a person
// Chris's inbox: replies to a brand (quote, counter, close, rate hold, decline, reply) always wait in Approvals as drafts.
// Only the "are you still interested?" nudges send themselves. LEADS_AUTOPILOT_KINDS overrides, LEADS_AUTOPILOT=off stops them too.
export const LEAD_KINDS = String(process.env.LEADS_AUTOPILOT_KINDS || 'Lead follow-up').split(',').map((k) => k.trim()).filter(Boolean);
const LEADS_AUTO_FROM = process.env.LEADS_AUTOPILOT_FROM || '2026-10-03T00:00:00+05:30';
const autoKindsNow = () => (process.env.PM_AUTOPILOT === 'off' ? [] : [...AUTO_KINDS, ...(Date.now() >= Date.parse(LEADS_AUTO_FROM) && process.env.LEADS_AUTOPILOT !== 'off' ? LEAD_KINDS : [])]);
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

// Has this exact Frame.io link already gone to the brand, is it waiting in Approvals, or did Harsh reject it?
async function frameAlreadyShared(dealId, frame) {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [
    { property: 'Deal', relation: { contains: dealId } }, { property: 'Body', rich_text: { contains: frame.slice(0, 90) } },
    // a draft you rejected counts too: rejecting it means "don't send this cut", so it is never drafted again
    { or: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Status', select: { equals: 'Sent' } }, { property: 'Status', select: { equals: 'Rejected' } }] },
  ] } });
  return (res.results || []).length > 0;
}

export async function runHeartbeat({ force = false } = {}) {
  let last = Date.now();
  const report = { drafts: [], handed_to_harsh: [], brief: null, errors: [], steps: [] };
  // Time each part of the tick for the Runs page
  const mark = (name) => { const errs = report.errors.length; report.steps.push({ name, ms: Date.now() - last, ok: errs === (mark.errs || 0) }); mark.errs = errs; last = Date.now(); };
  const deals = await openDeals();
  mark('Read brand deals');
  let budget = MAX_DRAFTS_PER_TICK;
  const draft = async (kind, deal, args) => {
    if (budget <= 0) return;
    if (await pendingDraft(deal.id, kind)) return;
    budget--;
    try {
      const mail = await writeEmail({ kind, deal, facts: args.facts || {} });
      // a link the email must carry (e.g. the Frame.io cut) goes in even if the writer forgot it
      const must = args.facts?.frame_io_link;
      if (must && !String(mail.body).includes(must)) mail.body = String(mail.body).replace(/\n(Best|Thanks|Regards|Cheers)[\s\S]*$/i, (sig) => `\n\nReview link: ${must}\n${sig}`);
      if (must && !String(mail.body).includes(must)) mail.body += `\n\nReview link: ${must}`;
      const auto = AUTO_KINDS.includes(kind);
      const r = await createDraft({ kind, deal, subject: mail.subject, body: mail.body, attach: args.attach || 'None', video: args.video || deal.linkedVideo, why: auto ? `${args.why} Sends on its own in ${AUTO_HOLD_MIN} min unless you reject it.` : args.why, notify: !auto });
      if (r.created) report.drafts.push(`${kind}: ${deal.brand} × ${deal.creator}`);
      if (r.created && auto && kind === 'Script') await discord(`📝 **Script going to ${deal.brand} · ${deal.creator}** in ${AUTO_HOLD_MIN} min\n• "${args.facts?.video_title || 'script'}" with the PDF attached, replying in their email thread. Reject it in Approvals to stop it`, 'pm');
    } catch (e) {
      report.errors.push(`${kind} ${deal.brand}: ${e.message.slice(0, 150)}`);
    }
  };

  for (const deal of deals) {
    if (deal.paused) continue;
    try {
      const video = deal.linkedVideo ? await videoInfo(deal.linkedVideo) : null;
      // The brand asked us to hold the work ("pause scripting until the clause is confirmed"). Nothing goes out to them
      // (no script, no cut), but we keep checking in on the 3/5/9 weekday schedule so the deal doesn't go cold.
      const onHold = /^On hold \(brand\)/i.test(deal.nextAction || '');
      if (onHold) {
        if (deal.brandEmail && !['Posted', 'Invoiced', 'Paid', 'Lost'].includes(deal.stage)) {
          const since = [deal.lastOur, deal.lastBrand, deal.scriptSent, deal.confirmed].filter(Boolean).map((d) => String(d).slice(0, 10)).sort().pop();
          const waited = since ? daysSince(since) : 0;
          const reason = String(deal.nextAction).replace(/^On hold \(brand\):\s*/i, '');
          if (since && waited >= followGap(deal.followUps || 0) && !isWeekend()) {
            if (deal.followUps >= MAX_FOLLOW_UPS) {
              if (!deal.needsCheck) {
                const schema = await schemaOf(DS.deals);
                const p = {};
                setIf(schema, p, 'Needs Check', true);
                await notion('PATCH', `/pages/${deal.id}`, { properties: p });
                await discord(`🙋 **Over to you: ${deal.brand} × ${deal.creator}**\nStill on hold and no word after ${deal.followUps} check-ins (${waited} days). I've stopped chasing.`, 'pm');
                report.handed_to_harsh.push(deal.brand);
              }
            } else {
              await draft('Follow-up', deal, { why: `On hold for ${waited} days (${reason}). Check-in ${deal.followUps + 1} of ${MAX_FOLLOW_UPS} so the deal doesn't go cold.`, facts: { on_hold: true, waiting_for: reason, days_waiting: waited, follow_up_number: deal.followUps + 1, note: 'They asked us to pause the work until this is confirmed. Check in warmly: ask whether there is any update on it, say we are ready to pick the work back up the moment they give the go-ahead. Do not push or sound impatient, and do not send any script or video.' } });
            }
          }
        }
        continue;
      }

      // 1. Script is ready (video at 5- Script Approval). Harsh sends scripts himself, so by default the PM only flags it
      //    (Next Action + one Discord ping) and notices his email when it goes out. PM_SCRIPT_EMAILS=on brings back the drafted email.
      if (video && video.num === 5 && !/\bhold\b/i.test(video.title || '') && ['Brief Received', 'Signed', 'Price Agreed', null, undefined].includes(deal.stage) && !deal.scriptSent) {
        if (SCRIPT_EMAILS) await draft('Script', deal, { attach: 'Script PDF', video: video.url, why: `Shreya's script for "${video.title}" is ready (status ${video.status}).`, facts: { video_title: video.title, deliverables: deal.deliverables, go_live: deal.deadline } });
        else if (!/^Send the script/i.test(deal.nextAction || '')) {
          const schema = await schemaOf(DS.deals);
          const p = {};
          setIf(schema, p, 'Next Action', 'Send the script to the brand (you send it, the PM tracks it)');
          await notion('PATCH', `/pages/${deal.id}`, { properties: p });
          await discord(`📝 **Script ready: ${deal.brand} × ${deal.creator}**\n• "${video.title}" is at Script Approval. Send it to the brand from the email thread, and I'll pick it up and chase their approval\n→ [Open card](${video.url})`, 'pm');
          report.drafts.push(`Script flagged: ${deal.brand} × ${deal.creator}`);
        }
      }

      // 1a. Revised script: the brand asked for changes (PM moved the card back to Script Draft and set "Shreya revising"),
      //     and the card is back at 5- Script Approval. Drafted for Harsh to check, never sent on its own.
      if (video && video.num === 5 && deal.stage === 'Script Sent' && /revising the script/i.test(deal.nextAction || '') && SCRIPT_EMAILS) {
        await draft('Script', deal, { attach: 'Script PDF', video: video.url, why: `Needs you: revised script for "${video.title}" is back at Script Approval. Open the attachment and check it's the new version before sending.`, facts: { video_title: video.title, revised: true, note: 'This is the revised script after their feedback. Say the updated script is attached with their notes worked in, and ask them to confirm.' } });
        // once per revision: the Next Action moves on, so a rejected draft isn't written again
        try { const schema = await schemaOf(DS.deals); const p = {}; setIf(schema, p, 'Next Action', 'Revised script ready: check it in Approvals and send'); await notion('PATCH', `/pages/${deal.id}`, { properties: p }); } catch { /* next run */ }
      }

      // 1b. Editor's cut is in review (Video Intake: In Review + Frame.io link) -> send it to the brand.
      //     Each new Frame.io link (first cut, revised cut) gets its own email, once.
      if (deal.brandEmail && !['Posted', 'Invoiced', 'Paid'].includes(deal.stage)) {
        const row = await findIntakeRow(deal).catch(() => null);
        const round = row && row.revisions ? row.revisions + 1 : 1;
        // A first cut when a cut is already with the brand (sent by the PM or by hand) is never re-sent: the brand is
        // reviewing. Only a revised cut (after they asked for changes) goes out while the deal is at Submitted or later.
        const alreadyWithBrand = !stageBefore(deal.stage, 'Submitted') && round === 1;
        if (row && row.status === 'In Review' && row.frame && !alreadyWithBrand && !(await frameAlreadyShared(deal.id, row.frame))) {
          await draft('Draft video', deal, { video: deal.linkedVideo || row.url, why: `${row.editor || 'The editor'} finished ${round > 1 ? 'the revised cut (round ' + round + ')' : 'the first cut'} of "${row.title}".`, facts: { frame_io_link: row.frame, video_title: row.title, round, revised: round > 1 } });
        }
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
        // Don't chase the brand while the next move is ours (script being revised, editor making changes...)
        const ourMove = /revising|writing|editing|making (the )?changes|working on/i.test(deal.nextAction || '');
        if (brandSilent && !ourMove && waited >= followGap(deal.followUps || 0) && (deal.followUps >= MAX_FOLLOW_UPS || !isWeekend())) {
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

  mark(`Deal emails (${deals.length} deals)`);
  // 5. Drive folders for videos that reached 6- To Film
  try {
    report.drive = await runDriveFolders();
    const made = report.drive.made || [];
    const newF = made.filter((m) => !m.rawOnly); // Raw Footage backfills stay quiet
    if (newF.length) await discord(`📁 **Drive folders ready (${newF.length})**\n` + newF.map((m) => `• ${m.creator} · ${m.title} → [folder](${m.folder})${m.shared ? '' : ' ⚠️ share by hand'}`).join('\n'), 'log');
    for (const e of report.drive.errors || []) report.errors.push('drive ' + e);
  } catch (e) { report.errors.push('drive: ' + String(e.message).slice(0, 150)); }

  mark('Drive folders');
  // 5a0. Chris's inbox: nudge brands that went quiet after our quote
  try { const { catchUpUnanswered } = await import('./leads.js'); const c = await catchUpUnanswered(); if (c.length) report.leadCatchUp = c; } catch (e) { report.errors.push('lead catch-up: ' + String(e.message).slice(0, 150)); }
  try { const { leadFollowUps } = await import('./leads.js'); report.leadNudges = await leadFollowUps(); } catch (e) { report.errors.push('lead nudges: ' + String(e.message).slice(0, 150)); }

  mark('Lead follow-ups');
  // 5a. Autopilot: send held drafts whose 30 minutes are up (evening log lists them)
  if (autoKindsNow().length) {
    try { report.autopilot = await runAutopilot(); } catch (e) { report.errors.push('autopilot: ' + String(e.message).slice(0, 150)); }
  }
  if (force || istHour() >= 21) {
    try { report.autolog = await autopilotDigest(); } catch (e) { report.errors.push('autopilot digest: ' + String(e.message).slice(0, 150)); }
  }

  mark('Autopilot sends');
  // 5b. Things we promised a brand ("I'll send the signed contract shortly"): remind Harsh once a day until sent
  const h = istHour();
  if (force || (h >= 10 && h < 21)) {
    try { report.promises = await promiseReminders(); } catch (e) { report.errors.push('promises: ' + String(e.message).slice(0, 150)); }
  }

  mark('Promise reminders');
  // 6. Sponsor money: log posted sponsor videos, ping new ones, remind unpaid invoices (every ~10 minutes)
  if (force || new Date().getUTCMinutes() % 10 < 2) {
    try {
      report.money = await syncMoney();
      for (const e of report.money.errors || []) report.errors.push('money ' + e);
    } catch (e) { report.errors.push('money: ' + String(e.message).slice(0, 150)); }
  }

  mark('Sponsor money');
  // 7. Morning brief + money digest, once a day after 9am IST
  if (force || istHour() >= 9) report.brief = await morningBrief({ force });
  mark('Morning brief');
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
  const { buildHQ } = await import('./hq.js');
  const { moneyChase } = await import('./money.js');
  const [hq, m, team, deals] = await Promise.all([
    buildHQ({ fresh: true }),
    moneyChase().catch(() => null),
    runTool('editor_output', { from: yesterday, to: yesterday, include_videos: false }).catch(() => ({})),
    openDeals().catch(() => []),
  ]);
  const o = hq.overview || {};
  const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const short = (t, n = 60) => { const x = String(t || 'Untitled').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  const named = (v) => v.title && !/^untitled$/i.test(v.title);
  const day = new Date(today + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const L = [`☀️ **Morning brief · ${day}**`];

  // 1. Today: only what isn't ready yet
  const tp = o.today_posts || [];
  const notReady = tp.filter((v) => v.stage !== 'Ready' && v.stage !== 'Posted');
  if (tp.length) {
    L.push(`\n**Posting today: ${tp.length - notReady.length} of ${tp.length} ready**`);
    for (const v of notReady.filter(named).slice(0, 6)) L.push(`• ${v.creator}: ${short(v.title)} · still in ${v.stage}${v.editor ? ' with ' + v.editor : ''}`);
  } else L.push('\n**Nothing scheduled to post today.**');

  // 2. Late = past its date (last 7 days) and still in production. Ready-but-not-marked cards are one line, they just need a click
  const overdue = (hq.schedule?.overdue || []).filter(named);
  const stuck = overdue.filter((v) => v.stage !== 'Ready');
  const unmarked = overdue.filter((v) => v.stage === 'Ready');
  if (stuck.length) {
    L.push(`\n**Late and still in production (${stuck.length})**`);
    for (const v of stuck.slice(0, 6)) L.push(`• ${v.creator}: ${short(v.title)} · ${v.stage}, ${v.days_late}d late${v.editor ? ' · ' + v.editor : ''}`);
    if (stuck.length > 6) L.push(`• …and ${stuck.length - 6} more on the dashboard`);
  }
  if (unmarked.length) L.push(`\n📌 ${unmarked.length} video${unmarked.length === 1 ? ' is' : 's are'} Ready but past the post date: ${unmarked.slice(0, 4).map((v) => `${v.creator} · ${short(v.title, 35)}`).join('; ')}${unmarked.length > 4 ? ' …' : ''}. Mark them 12- Posted if they went out, or give them a new date.`);

  // 3. What only Harsh can do
  const needs = [];
  const nDrafts = hq.kpis?.approvals || 0;
  if (nDrafts) needs.push(`${nDrafts} email${nDrafts === 1 ? '' : 's'} waiting in Approvals`);
  for (const a of (hq.leads?.approvals || []).slice(0, 3)) needs.push(`Approve or decline ${a.brand} × ${a.creator} at ${usd(a.approval)}`);
  const promised = deals.filter((d) => !d.paused && /^Send /.test(d.nextAction || '') && d.nextActionDate && String(d.nextActionDate).slice(0, 10) <= today && String(d.nextActionDate).slice(0, 10) >= new Date(Date.parse(today) - 14 * 864e5).toISOString().slice(0, 10));
  for (const d of promised.slice(0, 3)) needs.push(`${d.brand} × ${d.creator || '?'}: ${short(d.nextAction.replace(/\s*\(promised.*\)$/, ''), 80)}`);
  for (const i of (hq.deals?.overdue_invoices || []).slice(0, 3)) needs.push(`${i.brand} invoice ${i.days_overdue}d overdue${i.amount ? ' · ' + usd(i.amount) : ''}`);
  if (needs.length) { L.push('\n**Needs you**'); for (const n of needs) L.push('• ' + n); }

  // 4. Money: only what to act on (invoices to collect from creators, brand payments that are late)
  if (m) {
    const toInvoice = (m.needs_invoice || []).filter((x) => (x.days ?? 0) <= 21);
    if (toInvoice.length) L.push(`\n🧾 **Ask for invoices (${toInvoice.length})**: ${toInvoice.slice(0, 6).map((x) => `${x.brand} × ${x.creator}`).join(', ')}${toInvoice.length > 6 ? ' …' : ''}`);
    const late = (m.awaiting_payment || []).filter((x) => (x.days ?? 0) > 21);
    if (late.length) L.push(`⏳ **Brand payments late (${late.length})**: ${late.slice(0, 5).map((x) => `${x.brand} × ${x.creator}${x.amount ? ' ' + usd(x.amount) : ''} (${x.days}d)`).join(', ')}`);
  }

  // 5. Yesterday's editing, one line
  const eds = (team.editors || []).filter((e) => e.delivered);
  if (eds.length) L.push(`\n✂️ Yesterday: ${eds.map((e) => `${e.editor} ${e.delivered}`).join(' · ')} (${team.totals?.delivered || 0} delivered)`);

  if (L.length === 2 && !tp.length) L.push('All clear ✅');
  const text = L.join('\n');
  // Discord caps a message at 2000 characters
  let ok = true, buf = '';
  for (const l of L) {
    if ((buf + '\n' + l).length > 1900) { ok = (await discord(buf, 'pm')) && ok; buf = ''; }
    buf = buf ? buf + '\n' + l : l;
  }
  if (buf) ok = (await discord(buf, 'pm')) && ok;
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

// Deals whose Next Action is a promised "Send …" that's now due. One Discord ping per deal per day.
export async function promiseReminders() {
  const today = todayIST();
  const due = (await openDeals()).filter((d) => !d.paused && /^Send /.test(d.nextAction || '') && d.nextActionDate && String(d.nextActionDate).slice(0, 10) <= today && String(d.lastReminder || '').slice(0, 10) !== today);
  for (const d of due) {
    const late = daysSince(d.nextActionDate);
    await discord(`📎 **${d.brand} × ${d.creator || '?'} · still to send**\n• ${d.nextAction.replace(/^Send /, '')}${late > 0 ? `\n• ${late} day${late === 1 ? '' : 's'} past when it was due` : ''}\n→ Reply in the thread with it attached and I'll mark it done${d.url ? ` · [deal](${d.url})` : ''}`, 'pm');
    const schema = await schemaOf(DS.deals);
    const p = {};
    setIf(schema, p, 'Last Reminder Sent', today);
    if (Object.keys(p).length) await notion('PATCH', `/pages/${d.id}`, { properties: p });
  }
  return { reminded: due.map((d) => d.brand) };
}

// Sends held auto-kind drafts once their hold is over. Skips (and retires) a nudge if the brand wrote after it was drafted.
export async function runAutopilot() {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 20, filter: { and: [
    { property: 'Status', select: { equals: 'Draft' } },
    { or: autoKindsNow().map((k) => ({ property: 'Kind', select: { equals: k } })) },
  ] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
  const sent = [], skipped = [];
  const { approveAndSend } = await import('./outbox.js');
  for (const p of res.results || []) {
    if (p.in_trash) continue;
    const created = Date.parse(p.created_time);
    if (created < Date.parse(AUTOPILOT_FROM) || Date.now() - created < AUTO_HOLD_MIN * 60e3) continue;
    const subject = plain(p.properties?.Subject) || '';
    const thread = plain(p.properties?.['Gmail Thread ID']) || '';
    // Follow-ups and nudges wait for Monday instead of landing on a weekend
    if (/follow-up/i.test(plain(p.properties?.Kind) || '') && isWeekend()) continue;
    // Anything flagged for Harsh (the brand asked something) never sends itself
    if (/^Needs you/i.test(plain(p.properties?.Why) || '')) continue;
    // Brand (or anyone) wrote in this thread after the nudge was drafted: it's no longer needed
    if (thread) {
      const later = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Thread ID', rich_text: { equals: thread } }, { property: 'Email Date', date: { after: new Date(created).toISOString() } }] } }).catch(() => ({ results: [] }));
      if ((later.results || []).length) {
        await notion('PATCH', `/pages/${p.id}`, { properties: { Status: { select: { name: 'Rejected' } } } });
        skipped.push(subject);
        continue;
      }
    }
    try {
      await approveAndSend(p.id);
      sent.push(subject);
      await log({ event: `Auto-sent: ${subject}`, outcome: 'Sent', email: { messageId: '', threadId: thread }, details: `${plain(p.properties?.Kind)} to ${plain(p.properties?.To)} after the ${AUTO_HOLD_MIN}-minute hold` });
    } catch (e) {
      skipped.push(`${subject} (failed: ${String(e.message).slice(0, 80)})`);
    }
  }
  return { sent, skipped };
}

// Once an evening: what autopilot sent today
export async function autopilotDigest() {
  const today = todayIST();
  const done = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { equals: `Autopilot log ${today}` } }] } }).catch(() => ({ results: [] }));
  if ((done.results || []).length) return 'already sent';
  const since = new Date(Date.parse(today + 'T00:00:00+05:30')).toISOString();
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 50, filter: { and: [{ property: 'Event', title: { starts_with: 'Auto-sent:' } }, { timestamp: 'created_time', created_time: { on_or_after: since } }] } });
  const rows = (r.results || []).map((p) => plain(p.properties?.Event).replace(/^Auto-sent:\s*/, ''));
  if (rows.length) await discord(`🤖 **Sent on autopilot today (${rows.length})**\n` + rows.slice(0, 15).map((t) => '• ' + t).join('\n'), 'pm');
  await log({ event: `Autopilot log ${today}`, outcome: 'Rule', email: { messageId: '' }, details: rows.length ? rows.join('\n') : 'Nothing sent on autopilot today' });
  return rows.length;
}
