// Outreach (Harsh, Nov 12): pitch a creator to the brands that reached out to OTHER creators (the Brand Pool).
// Harsh presses Start for a creator; the PM queues the right brands and sends one email at a time from the outreach
// inbox (harshkoli201@gmail.com, through the n8n "Outreach · Gmail" workflow), at least 5 minutes apart, inside a
// sending window, under a daily cap. Replies are read from that inbox and shown on the Outreach tab as they are:
// no AI reads them (no API spend).
//   Campaigns  one row per creator: template, follow-ups, Running/Paused/Off          (OUTREACH CAMPAIGNS)
//   Queue      one row per brand pitched for a creator, with its status and thread     (OUTREACH QUEUE)
import { notion, queryAll, plain } from './notion.js';
import { buildMime } from './mime.js';
import { POOL_DS, poolKey } from './brandpool.js';

export const CAMPAIGNS_DS = '27aa4a6d-fb50-4414-b6ac-130dc7cf98d9';
export const QUEUE_DS = '6ffdb8a2-9cf0-4070-bc3a-a8825f684be4';
export const TEMPLATE_PAGE = '40c508e99dda803c94a1c7b14dc80127'; // BRAND OUTREACH TEMPLATES (Harsh's default template)
export const FROM = 'Harsh Koli <harshkoli201@gmail.com>';
export const CREATORS = ['Brad', 'Chris', 'Lindsay', 'Valeri', 'Duncan', 'Emtech', 'Dmytro', 'David Iya', 'Nicole', 'AI Learns'];

// Settings (Vercel env can change them without a deploy)
export const SETTINGS = {
  dailyCap: Number(process.env.OUTREACH_DAILY || 30),
  gapMin: Math.max(5, Number(process.env.OUTREACH_GAP_MIN || 5)),
  // sending window in UTC, Monday to Friday: 14:00 to 22:00 UTC = 7:30pm to 3:30am IST = 9am to 5pm New York
  windowUtc: String(process.env.OUTREACH_WINDOW_UTC || '14-22'),
  weekdaysOnly: process.env.OUTREACH_WEEKENDS !== 'on',
  followUp1Days: Number(process.env.OUTREACH_FU1_DAYS || 4),
  followUp2Days: Number(process.env.OUTREACH_FU2_DAYS || 5),
  lastSeenDays: Number(process.env.OUTREACH_LAST_SEEN_DAYS || 180),
  repitchDays: Number(process.env.OUTREACH_REPITCH_DAYS || 60),
  queueBatch: 40,
  optOut: process.env.OUTREACH_OPTOUT === 'off' ? '' : 'P.S. If this isn\'t relevant for you, just reply "stop" and I won\'t email again.',
};

const rt = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 1990) } }];
const rtLong = (s) => { const t = String(s ?? ''); const out = []; for (let i = 0; i < t.length && out.length < 50; i += 1990) out.push({ type: 'text', text: { content: t.slice(i, i + 1990) } }); return out; };
const lc = (s) => String(s ?? '').toLowerCase().trim();
const day = (d) => new Date(d).toISOString().slice(0, 10);
const addr = (s) => lc((String(s || '').match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/) || [])[0] || '');
const brandKey = (s) => lc(s).replace(/\(.*?\)/g, ' ').replace(/\.(ai|io|so|app|com|co|dev|net)\b/g, '').replace(/\b(ai|app|inc|ltd|llc|hq|the|team)\b/g, '').replace(/[^a-z0-9]+/g, '');

// ---------- the email itself ----------
// The template uses [creator] / {creator}, [followers] / {followers} / "X+", {brand}, and "he/his/him" for the creator
export function render(template, { creator, followers, pronoun = 'he', brand = '' }) {
  const P = { he: ['he', 'his', 'him'], she: ['she', 'her', 'her'], they: ['they', 'their', 'them'] }[pronoun] || ['he', 'his', 'him'];
  const cap = (w, like) => (/^[A-Z]/.test(like) ? w[0].toUpperCase() + w.slice(1) : w);
  let t = String(template || '')
    .replace(/\[\s*creator\s*\]|\{\s*creator\s*\}/gi, creator)
    .replace(/\[\s*brand\s*\]|\{\s*brand\s*\}/gi, brand || 'your brand')
    .replace(/\[\s*followers\s*\]|\{\s*followers\s*\}/gi, followers || '')
    .replace(/\bX\+(?=\s*followers)/g, followers ? `${String(followers).replace(/\+$/, '')}+` : '')
    .replace(/\(\s*\+?\s*followers\)/gi, '') // "( followers)" left when no follower count is set
    .replace(/\(\s*\)/g, '');
  if (pronoun !== 'he') t = t.replace(/\b(he|his|him)\b/gi, (m) => cap(P[{ he: 0, his: 1, him: 2 }[m.toLowerCase()]], m)).replace(/\bthey is\b/gi, 'they are').replace(/\bthey was\b/gi, 'they were');
  return t.replace(/<\/?b>/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function toHtml(text) {
  return String(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>')}</p>`).join('');
}

export function buildEmail(c, row, kind) {
  const brand = row.brand || '';
  const vars = { creator: c.creator, followers: c.followers, pronoun: c.pronoun, brand };
  const subject = render(c.subject || '{creator} x {brand}', vars);
  const body = kind === 'first' ? render(c.body, vars) : render(kind === 'fu1' ? c.followUp1 : c.followUp2, vars);
  const text = [body, kind === 'first' && SETTINGS.optOut && !/\bstop\b/i.test(body) ? SETTINGS.optOut : ''].filter(Boolean).join('\n\n');
  return { subject: kind === 'first' ? subject : `Re: ${subject}`, text, html: toHtml(text) };
}

// ---------- campaigns ----------
function readCampaign(p) {
  const g = (n) => plain(p.properties?.[n]);
  return { id: p.id, creator: g('Creator'), status: g('Status') || 'Off', subject: g('Subject') || '', body: g('Body') || '', followUp1: g('Follow-up 1') || '', followUp2: g('Follow-up 2') || '', followers: g('Followers') || '', pronoun: g('Pronoun') || 'he', started: g('Started') || '' };
}

let templateCache = null;
export async function defaultTemplate() {
  if (templateCache && Date.now() - templateCache.at < 10 * 60e3) return templateCache.text;
  const r = await notion('GET', `/blocks/${TEMPLATE_PAGE}/children?page_size=100`).catch(() => ({ results: [] }));
  const text = (r.results || []).map((b) => (b[b.type]?.rich_text || []).map((t) => t.plain_text).join('')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  templateCache = { at: Date.now(), text };
  return text;
}

export async function campaigns() {
  const rows = (await queryAll(CAMPAIGNS_DS, undefined, { useCache: false })).map(readCampaign);
  const tpl = await defaultTemplate();
  return CREATORS.map((creator) => rows.find((r) => lc(r.creator) === lc(creator)) || { id: null, creator, status: 'Off', subject: '', body: '', followUp1: '', followUp2: '', followers: '', pronoun: creator === 'Lindsay' || creator === 'Valeri' || creator === 'Nicole' ? 'she' : 'he' })
    .map((c) => ({ ...c, body: c.body || tpl, usesDefault: !c.body }));
}

export async function saveCampaign(creator, f) {
  if (!CREATORS.includes(creator)) throw new Error('Unknown creator');
  const props = {};
  if ('subject' in f) props.Subject = { rich_text: rt(f.subject) };
  if ('body' in f) props.Body = { rich_text: rtLong(f.body) };
  if ('followUp1' in f) props['Follow-up 1'] = { rich_text: rtLong(f.followUp1) };
  if ('followUp2' in f) props['Follow-up 2'] = { rich_text: rtLong(f.followUp2) };
  if ('followers' in f) props.Followers = { rich_text: rt(f.followers) };
  if ('pronoun' in f && ['he', 'she', 'they'].includes(f.pronoun)) props.Pronoun = { select: { name: f.pronoun } };
  if ('status' in f) props.Status = { select: { name: f.status } };
  if (f.status === 'Running') props.Started = { date: { start: new Date().toISOString() } };
  const have = (await queryAll(CAMPAIGNS_DS, undefined, { useCache: false })).find((p) => lc(plain(p.properties?.Creator)) === lc(creator));
  if (have) await notion('PATCH', `/pages/${have.id}`, { properties: props });
  else await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: CAMPAIGNS_DS }, properties: { Creator: { title: rt(creator) }, ...props } });
  return { ok: true };
}

// ---------- who gets pitched ----------
function readQueue(p) {
  const g = (n) => plain(p.properties?.[n]);
  return { id: p.id, brand: g('Brand'), creator: g('Creator'), to: g('To'), status: g('Status') || 'Queued', poolKey: g('Pool Key'), sentAt: g('Sent At'), lastSentAt: g('Last Sent At'), threadId: g('Thread ID'), messageId: g('Message ID'), reply: g('Reply'), error: g('Error'), created: p.created_time };
}
export async function queue() { return (await queryAll(QUEUE_DS, undefined, { useCache: false })).map(readQueue); }

// The brands a creator would be pitched to, best first. Pure: the pool rows, the queue and open deals are passed in.
export function pickBrands(creator, poolRows, queued, openDeals, { now = Date.now() } = {}) {
  const already = new Set(queued.filter((q) => q.creator === creator).map((q) => q.poolKey));
  const busy = new Set(openDeals.filter((d) => d.creator && lc(d.creator) !== lc(creator)).map((d) => brandKey(d.brand)).filter(Boolean));
  const out = [];
  for (const p of poolRows) {
    const g = (n) => plain(p.properties?.[n]);
    const key = g('Key') || '';
    const to = String(g('Contact Emails') || '').split(/[,\s]+/).map(addr).find((a) => a && poolKey(a));
    const ms = (n) => String(g(n) || '').split(', ').filter(Boolean);
    const approached = ms('Approached');
    const worked = ms('Worked With');
    const pitchedFor = ms('Pitched For');
    const lastSeen = g('Last Seen');
    const lastPitched = g('Last Pitched');
    let why = '';
    if (g('Do Not Contact')) why = 'Do Not Contact';
    else if (g('Offer Type') !== 'Paid offer') why = 'not a paid offer';
    else if (!to) why = 'no email address';
    else if (approached.includes(creator) || worked.includes(creator)) why = `already talks to ${creator}`;
    else if (!lastSeen || now - Date.parse(lastSeen) > SETTINGS.lastSeenDays * 864e5) why = 'not seen in 6 months';
    else if (pitchedFor.includes(creator) && lastPitched && now - Date.parse(lastPitched) < SETTINGS.repitchDays * 864e5) why = `pitched for ${creator} recently`;
    else if (already.has(key)) why = 'already in the queue';
    else if (busy.has(brandKey(g('Brand')))) why = 'working with another creator right now';
    if (why) continue;
    out.push({ poolId: p.id, poolKey: key, brand: g('Brand'), to, budget: Number(g('Top Budget USD')) || 0, lastSeen, contact: g('Contact Name') || '' });
  }
  return out.sort((a, b) => b.budget - a.budget || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

async function candidates(creator) {
  const [pool, q, deals] = await Promise.all([
    queryAll(POOL_DS, undefined, { useCache: false }),
    queue(),
    import('./briefs.js').then((m) => m.openDeals()).catch(() => []),
  ]);
  return pickBrands(creator, pool, q, deals);
}

export async function preview(creator) {
  const list = await candidates(creator);
  const c = (await campaigns()).find((x) => x.creator === creator);
  const sample = list[0] ? buildEmail(c, list[0], 'first') : buildEmail(c, { brand: 'Example Brand' }, 'first');
  return { creator, count: list.length, brands: list.slice(0, 100).map((b) => ({ brand: b.brand, to: b.to, budget: b.budget || null })), sample: { to: list[0]?.to || '', subject: sample.subject, text: sample.text }, settings: SETTINGS };
}

// Queue the next batch of brands for a creator (topped up as the queue empties, so Notion writes stay small)
async function fillQueue(creator, n = SETTINGS.queueBatch) {
  const list = (await candidates(creator)).slice(0, n);
  for (const b of list) {
    await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: QUEUE_DS }, properties: {
      Brand: { title: rt(b.brand) }, Creator: { select: { name: creator } }, To: { email: b.to }, 'First Name': { rich_text: rt(b.contact.split(/\s+/)[0] || '') },
      Status: { select: { name: 'Queued' } }, 'Pool Key': { rich_text: rt(b.poolKey) },
    } });
  }
  return list.length;
}

export async function start(creator) {
  const c = (await campaigns()).find((x) => x.creator === creator);
  if (!c?.body?.trim()) throw new Error('Add the email template first');
  if (/\bX\+/.test(c.body) && !c.followers) throw new Error(`Add ${creator}'s follower count first (the template says "X+ followers")`);
  await saveCampaign(creator, { status: 'Running', ...(c.usesDefault ? { body: c.body } : {}) });
  const q = await queue();
  const waiting = q.filter((r) => r.creator === creator && r.status === 'Queued').length;
  const added = waiting >= 10 ? 0 : await fillQueue(creator);
  return { ok: true, queued: waiting + added };
}

export const pause = (creator) => saveCampaign(creator, { status: 'Paused' });
export async function stop(creator) {
  await saveCampaign(creator, { status: 'Off' });
  // brands not emailed yet leave the queue (Skipped), so a later Start picks them fresh
  for (const r of (await queue()).filter((x) => x.creator === creator && x.status === 'Queued')) await notion('PATCH', `/pages/${r.id}`, { properties: { Status: { select: { name: 'Skipped' } } } });
  return { ok: true };
}

// ---------- sending ----------
export function inWindow(now = new Date()) {
  const [a, b] = SETTINGS.windowUtc.split('-').map(Number);
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  const wd = now.getUTCDay();
  if (SETTINGS.weekdaysOnly && (wd === 0 || wd === 6)) return false;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

async function gmail(body) {
  const hook = process.env.N8N_OUTREACH_WEBHOOK || 'https://n8n-production-cd10f.up.railway.app/webhook/outreach-gmail';
  const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hook-secret': process.env.PM_HOOK_SECRET || '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { ok: false, error: t.slice(0, 200) || `HTTP ${r.status}` }; }
  if (!r.ok && j.ok !== false) j = { ok: false, error: j.message || `HTTP ${r.status}` };
  return j;
}

async function sendOne(c, row, kind) {
  const e = buildEmail(c, row, kind);
  const raw = buildMime({ from: FROM, to: row.to, subject: e.subject, text: e.text, html: e.html, ...(kind !== 'first' && row.messageId ? { inReplyTo: row.messageId } : {}) });
  const msgId = (Buffer.from(raw, 'base64url').toString('utf8').match(/^Message-ID:\s*(<[^>]+>)/mi) || [])[1] || '';
  const res = await gmail({ action: 'send', raw, ...(kind !== 'first' && row.threadId ? { threadId: row.threadId } : {}) });
  const nowIso = new Date().toISOString();
  if (!res.ok) {
    // The inbox not connected / n8n down is not this brand's fault: the brand stays in line and the error shows on the tab
    const ours = /credential|auth|unauthori[sz]ed|forbidden|401|403|404|5\d\d|webhook|x-hook-secret|not registered|ECONN|timeout|aborted/i.test(String(res.error || ''));
    await notion('PATCH', `/pages/${row.id}`, { properties: { ...(ours ? {} : { Status: { select: { name: 'Failed' } }, 'Last Sent At': { date: { start: nowIso } } }), Error: { rich_text: rt(`${nowIso.slice(0, 16)} ${res.error || 'send failed'}`) } } });
    return { ok: false, error: res.error, held: ours };
  }
  const status = kind === 'first' ? 'Sent' : kind === 'fu1' ? 'Follow-up 1 sent' : 'Follow-up 2 sent';
  await notion('PATCH', `/pages/${row.id}`, { properties: {
    Status: { select: { name: status } }, 'Last Sent At': { date: { start: nowIso } }, Error: { rich_text: [] },
    ...(kind === 'first' ? { 'Sent At': { date: { start: nowIso } }, 'Thread ID': { rich_text: rt(res.threadId || '') }, 'Message ID': { rich_text: rt(msgId) } } : {}),
  } });
  if (kind === 'first') await markPitched(row).catch(() => {});
  return { ok: true, kind, brand: row.brand, creator: row.creator };
}

async function markPitched(row) {
  const r = await notion('POST', `/data_sources/${POOL_DS}/query`, { page_size: 1, filter: { property: 'Key', rich_text: { equals: row.poolKey } } });
  const p = r.results?.[0];
  if (!p) return;
  const have = (p.properties?.['Pitched For']?.multi_select || []).map((o) => ({ name: o.name }));
  if (!have.some((o) => o.name === row.creator)) have.push({ name: row.creator });
  await notion('PATCH', `/pages/${p.id}`, { properties: { 'Pitched For': { multi_select: have }, 'Last Pitched': { date: { start: day(Date.now()) } } } });
}

// What goes next: a follow-up that is due, else the next queued brand of the running creator emailed longest ago
export function nextUp(cs, rows, now = Date.now()) {
  const running = new Map(cs.filter((c) => c.status === 'Running').map((c) => [c.creator, c]));
  const t = (s) => Date.parse(s || 0) || 0;
  const due = rows.filter((r) => running.has(r.creator) && (
    (r.status === 'Sent' && running.get(r.creator).followUp1.trim() && now - t(r.lastSentAt) >= SETTINGS.followUp1Days * 864e5)
    || (r.status === 'Follow-up 1 sent' && running.get(r.creator).followUp2.trim() && now - t(r.lastSentAt) >= SETTINGS.followUp2Days * 864e5)))
    .sort((a, b) => t(a.lastSentAt) - t(b.lastSentAt));
  if (due[0]) return { row: due[0], c: running.get(due[0].creator), kind: due[0].status === 'Sent' ? 'fu1' : 'fu2' };
  const lastBy = (cr) => Math.max(0, ...rows.filter((r) => r.creator === cr && r.lastSentAt).map((r) => t(r.lastSentAt)));
  const order = [...running.keys()].sort((a, b) => lastBy(a) - lastBy(b));
  for (const cr of order) {
    const r = rows.filter((x) => x.creator === cr && x.status === 'Queued').sort((a, b) => t(a.created) - t(b.created))[0];
    if (r) return { row: r, c: running.get(cr), kind: 'first' };
  }
  return null;
}

export async function tick({ force = false } = {}) {
  const now = new Date();
  const [cs, rows] = await Promise.all([campaigns(), queue()]);
  const out = { sent: null, replies: null, why: '' };
  // replies first (every run with anything out, cheap: one inbox read)
  if (rows.some((r) => /Sent|Follow-up/.test(r.status))) out.replies = await checkReplies(rows).catch((e) => ({ error: e.message }));
  if (!cs.some((c) => c.status === 'Running')) { out.why = 'no creator running'; return out; }
  if (!force && !inWindow(now)) { out.why = 'outside the sending window'; return out; }
  const today = day(now);
  const sentToday = rows.filter((r) => r.lastSentAt && day(r.lastSentAt) === today && r.status !== 'Failed').length;
  if (sentToday >= SETTINGS.dailyCap) { out.why = `daily cap reached (${sentToday})`; return out; }
  const last = Math.max(0, ...rows.map((r) => Date.parse(r.lastSentAt || 0) || 0));
  if (now - last < (SETTINGS.gapMin - 0.5) * 60e3) { out.why = 'waiting for the 5-minute gap'; return out; }
  // keep each running creator's queue topped up
  for (const c of cs.filter((x) => x.status === 'Running')) {
    const waiting = rows.filter((r) => r.creator === c.creator && r.status === 'Queued').length;
    if (waiting < 5) { const n = await fillQueue(c.creator, 20).catch(() => 0); if (n) return { ...out, why: `queued ${n} more for ${c.creator}` }; }
  }
  const next = nextUp(cs, rows, now.getTime());
  if (!next) { out.why = 'nothing left to send'; return out; }
  out.sent = await sendOne(next.c, next.row, next.kind);
  return out;
}

// ---------- replies ----------
const OPT_OUT = /\b(stop|unsubscribe|remove me|take me off|not interested|no thanks|no thank you|not a fit|pass on this)\b/i;
const BOUNCE = /mailer-daemon|postmaster|mail delivery (subsystem|failed)/i;
export async function checkReplies(rows) {
  const res = await gmail({ action: 'inbox', q: 'in:inbox -from:me newer_than:4d' });
  if (!res.ok) throw new Error(res.error || 'inbox read failed');
  const byThread = new Map(rows.filter((r) => r.threadId).map((r) => [r.threadId, r]));
  let n = 0;
  for (const m of res.messages || []) {
    let r = byThread.get(m.threadId);
    if (!r && BOUNCE.test(m.from)) r = rows.find((x) => x.to && String(m.snippet).toLowerCase().includes(x.to));
    if (!r || ['Replied', 'Interested', 'Not interested', 'Bounced'].includes(r.status) && String(r.reply || '').includes(String(m.snippet).slice(0, 60))) continue;
    if (['Interested', 'Not interested'].includes(r.status)) continue; // Harsh already sorted it
    const bounced = BOUNCE.test(m.from);
    const out = !bounced && OPT_OUT.test(m.snippet);
    const status = bounced ? 'Bounced' : out ? 'Not interested' : 'Replied';
    await notion('PATCH', `/pages/${r.id}`, { properties: { Status: { select: { name: status } }, Reply: { rich_text: rt(`${m.date || ''} · ${m.from || ''}\n${m.subject || ''}\n${m.snippet || ''}`) } } });
    if (out) await doNotContact(r.poolKey).catch(() => {});
    r.status = status; n++;
  }
  return { checked: (res.messages || []).length, updated: n };
}

async function doNotContact(key) {
  if (!key) return;
  const r = await notion('POST', `/data_sources/${POOL_DS}/query`, { page_size: 1, filter: { property: 'Key', rich_text: { equals: key } } });
  if (r.results?.[0]) await notion('PATCH', `/pages/${r.results[0].id}`, { properties: { 'Do Not Contact': { checkbox: true } } });
}

// Harsh sorting a reply on the tab
export async function setRowStatus(id, status) {
  if (!['Interested', 'Not interested', 'Replied', 'Skipped', 'Queued'].includes(status)) throw new Error('Unknown status');
  await notion('PATCH', `/pages/${id}`, { properties: { Status: { select: { name: status } } } });
  if (status === 'Not interested') { const p = await notion('GET', `/pages/${id}`); await doNotContact(plain(p.properties?.['Pool Key'])).catch(() => {}); }
  return { ok: true };
}

export async function testSend(creator, to) {
  const a = addr(to);
  if (!a) throw new Error('Enter an email address for the test');
  const c = (await campaigns()).find((x) => x.creator === creator);
  const e = buildEmail(c, { brand: 'Example Brand' }, 'first');
  const raw = buildMime({ from: FROM, to: a, subject: `[TEST] ${e.subject}`, text: e.text, html: e.html });
  const res = await gmail({ action: 'send', raw });
  if (!res.ok) throw new Error(res.error || 'Test send failed');
  return { ok: true };
}

// ---------- the tab ----------
export async function overview() {
  const [cs, rows] = await Promise.all([campaigns(), queue()]);
  const today = day(Date.now());
  const stats = Object.fromEntries(cs.map((c) => {
    const mine = rows.filter((r) => r.creator === c.creator);
    const k = (re) => mine.filter((r) => re.test(r.status)).length;
    return [c.creator, { queued: k(/^Queued$/), sent: mine.filter((r) => r.sentAt).length, followedUp: k(/^Follow-up/), replied: k(/^(Replied|Interested|Not interested)$/), interested: k(/^Interested$/), bounced: k(/^Bounced$/), failed: k(/^Failed$/) }];
  }));
  const sentToday = rows.filter((r) => r.lastSentAt && day(r.lastSentAt) === today && r.status !== 'Failed').length;
  const last = rows.map((r) => r.lastSentAt).filter(Boolean).sort().pop() || '';
  const recent = rows.filter((r) => r.lastSentAt || r.reply || r.status === 'Failed').sort((a, b) => String(b.lastSentAt || b.created).localeCompare(String(a.lastSentAt || a.created))).slice(0, 150);
  const replies = rows.filter((r) => r.reply).sort((a, b) => String(b.reply).localeCompare(String(a.reply)));
  return { ok: true, settings: { ...SETTINGS, from: FROM }, inWindow: inWindow(), sentToday, lastSentAt: last, campaigns: cs, stats, recent, replies };
}
