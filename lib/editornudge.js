// Editor reminders (Harsh, Nov 21). Editors keep flexible hours, so nothing here runs on a clock: a reminder goes out
// when a video has sat at one stage too long, counted from the moment it got there, and the go-live date tightens it.
//
// Go-live 3+ days away (or no Post Date on the card):
//   Assigned, not started       editor after 12h, Harsh after 24h
//   Being edited, not in review editor after 24h, Harsh when go-live is under a day away
//   Changes, not sent back      editor after 12h, Harsh after 24h
//   Approved, CTAs not rendered editor after 6h,  Harsh after 12h   (To Post = the editor bot asked for the CTA renders)
// Go-live in 2 days: every wait halves and Harsh hears at the same time as the editor.
// Go-live today or tomorrow: after 3 hours at the stage (1 hour once go-live has passed), a video that is behind (today: anything short of Posted; tomorrow: not sent for
// review by midday IST) pings the editor and Harsh at once, then the editor again every 3 hours until it moves.
// One ping per stage (per round of changes) plus one to Harsh, so nobody gets spammed.
import { notion, plain } from './notion.js';
import { DS } from './tools.js';

const H = 36e5;
const IST = 5.5 * H;
const istDay = (t) => new Date(t + IST).toISOString().slice(0, 10);
const istHour = (t) => new Date(t + IST).getUTCHours();

// The editor's stage on an EDIT TRACKER row, and since when
export function stageOf(row) {
  const st = row.status;
  const latest = (...xs) => xs.filter(Boolean).map((x) => Date.parse(x)).filter((n) => !isNaN(n)).sort((a, b) => b - a)[0];
  if (st === 'Assigned') return { stage: 'start', since: latest(row.assignedAt, row.created) };
  if (['Claude running', 'Manual editing', 'Editor review'].includes(st)) return { stage: 'edit', since: latest(row.startedAt, row.assignedAt, row.created) };
  if (st === 'Changes') return { stage: 'changes', since: latest(row.changesAt, row.brandChangesAt, row.edited), round: row.revisions || 1 };
  if (st === 'To Post') return { stage: 'cta', since: latest(row.approvedAt, row.edited) };
  return null; // waiting on Harsh or the brand, or done
}

const WHAT = {
  start: 'not started yet',
  edit: 'still being edited, not sent for review yet',
  changes: 'the changes are not sent back yet',
  cta: 'approved, but the CTAs are not rendered yet',
};
const NORMAL = { start: [12, 24], edit: [24, null], changes: [12, 24], cta: [6, 12] };

// What to send for one row right now (pure): { editor: bool, harsh: bool, urgent: bool, text, daysLeft }
export function nudgeFor(row, now = Date.now()) {
  const s = stageOf(row);
  if (!s || !s.since) return null;
  const waited = (now - s.since) / H;
  const goLive = row.goLive ? String(row.goLive).slice(0, 10) : null;
  const daysLeft = goLive ? Math.round((Date.parse(goLive) - Date.parse(istDay(now))) / 864e5) : null;
  // Old rows nobody closed (go-live more than 2 days gone, or 10+ days at one stage with no date) are tidy-up, not
  // reminders: they would only spam the editor
  if ((daysLeft !== null && daysLeft < -2) || (daysLeft === null && waited > 240)) return null;
  const base = { stage: s.stage, round: s.round, since: s.since, daysLeft, what: WHAT[s.stage] };
  if (daysLeft !== null && daysLeft <= 1) {
    const behind = daysLeft <= 0 || (s.stage !== 'cta' && istHour(now) >= 12);
    if (!behind) return null;
    // A video only just handed over is never "behind" yet: the editor gets time to pick it up first (Harsh, Nov 23:
    // SAVED REELS was assigned at 12:02 and pinged at 12:04 "not started yet"). 3 hours in the stage, 1 hour once the
    // go-live day has already passed.
    if (waited < (daysLeft < 0 ? 1 : 3)) return null;
    return { ...base, urgent: true, editor: true, harsh: true };
  }
  let [e, h] = NORMAL[s.stage];
  if (daysLeft === 2) { e /= 2; h = e; }
  return { ...base, urgent: false, editor: waited >= e, harsh: h !== null && waited >= h };
}

export function goLiveText(row, now = Date.now()) {
  if (!row.goLive) return 'no Post Date on the card';
  const d = String(row.goLive).slice(0, 10);
  const left = Math.round((Date.parse(d) - Date.parse(istDay(now))) / 864e5);
  const nice = new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `goes live ${nice}${left === 0 ? ' (TODAY)' : left === 1 ? ' (TOMORROW)' : left < 0 ? ` (${-left} day${left === -1 ? '' : 's'} late)` : ` (in ${left} days)`}`;
}

const prop = (p, n) => plain(p.properties?.[n]) || '';
const dateOf = (p, n) => p.properties?.[n]?.date?.start || null;

async function goLiveFor(videoId) {
  if (!/^[0-9a-f]{32}$/i.test(String(videoId || '').replace(/-/g, ''))) return null;
  try {
    const page = await notion('GET', `/pages/${String(videoId).replace(/-/g, '')}`);
    for (const n of ['POST DATE', 'Post Date', 'Posting Date', 'Publish Date', 'Date']) { const d = page.properties?.[n]?.date?.start; if (d) return d; }
  } catch { /* card gone or not shared */ }
  return null;
}

// Paused by Harsh, Nov 24: "stop the editor's reminder on Discord for now, it's really messed up right now". Nothing
// goes to Discord while this is true; a dry run (?editornudge=1&dry=1) still lists what would have gone. Set to false to
// turn the reminders back on.
export const EDITOR_REMINDERS_PAUSED = true;

export async function editorNudges({ dry = false } = {}) {
  if (EDITOR_REMINDERS_PAUSED && !dry) return [];
  const statuses = ['Assigned', 'Claude running', 'Manual editing', 'Editor review', 'Changes', 'To Post'];
  const r = await notion('POST', `/data_sources/${DS.tracker}/query`, { page_size: 100, filter: { or: statuses.map((s) => ({ property: 'Status', select: { equals: s } })) } });
  const now = Date.now();
  const out = [];
  const { claimOnce, discord } = await import('./briefs.js');
  const { postToThread, editorMention } = await import('./editorthreads.js');
  for (const p of r.results || []) {
    if (p.in_trash) continue;
    const row = {
      id: p.id, title: prop(p, 'Video Title') || 'Untitled video', status: prop(p, 'Status'), editor: prop(p, 'Editor'), creator: prop(p, 'Creator'),
      created: p.created_time, edited: p.last_edited_time, assignedAt: dateOf(p, 'Assigned Date'), startedAt: dateOf(p, 'Started At'),
      changesAt: dateOf(p, 'Changes Requested At'), brandChangesAt: dateOf(p, 'Brand Changes At'), approvedAt: dateOf(p, 'Approved At'),
      revisions: Number(prop(p, 'Revisions')) || 0, videoId: prop(p, 'Video ID'), brief: p.properties?.['Brief Link']?.url || '',
      thread: [prop(p, 'Editor Thread ID'), prop(p, 'Video Thread ID'), prop(p, 'Discord Thread ID')].find((x) => /^\d{15,}$/.test(x)) || '',
    };
    if (!stageOf(row)) continue;
    row.goLive = (await goLiveFor(row.videoId)) || dateOf(p, 'Due By');
    const n = nudgeFor(row, now);
    if (!n || (!n.editor && !n.harsh)) continue;
    const stageKey = `${row.id} · ${n.stage}${n.round ? ' r' + n.round : ''} · ${new Date(n.since).toISOString().slice(0, 16)}`;
    const when = goLiveText(row, now);
    const brief = row.brief || (row.videoId ? `https://noocapaccesspage.vercel.app/video.html?id=${String(row.videoId).replace(/-/g, '')}` : '');
    const sent = [];
    if (n.editor) {
      // Urgent: again every 3 hours while it stays behind; otherwise once for this stage
      const key = n.urgent ? `Editor nudge · ${stageKey} · urgent ${Math.floor(now / (3 * H))}` : `Editor nudge · ${stageKey}`;
      if (dry || await claimOnce(key, n.urgent ? 3 : 24 * 30).catch(() => false)) {
        if (!dry) {
          const at = row.thread ? await editorMention(row.editor, row.thread).catch(() => '') : '';
          const msg = `${at ? at + ' ' : ''}${n.urgent ? '🚨' : '⏰'} **${row.title}** (${row.creator || 'creator'}): ${n.what}. It ${when}.${n.stage === 'cta' ? ' Render the CTAs and type "done" here when they are up.' : ''}${brief ? `\nBrief: ${brief}` : ''}`;
          const ok = row.thread ? await postToThread(row.thread, msg).catch(() => false) : false;
          if (!ok) await discord(`⏰ Couldn't reach ${row.editor || 'the editor'}'s thread for **${row.title}**, so tell them: ${n.what}. It ${when}.`, 'pm').catch(() => {});
        }
        sent.push(`${row.editor || 'editor'}${n.urgent ? ' (urgent)' : ''}`);
      }
    }
    if (n.harsh) {
      if (dry || await claimOnce(`Editor nudge · ${stageKey} · Harsh`, 24 * 30).catch(() => false)) {
        if (!dry) await discord(`${n.urgent ? '🚨' : '⏰'} **${row.title}** (${row.creator || 'creator'} · ${row.editor || 'no editor'}): ${n.what}. It ${when}. ${row.editor || 'The editor'} has been reminded in the video thread.`, 'pm').catch(() => {});
        sent.push('Harsh');
      }
    }
    if (sent.length) out.push(`${row.title}: ${n.what} → ${sent.join(' + ')}`);
  }
  return out;
}
