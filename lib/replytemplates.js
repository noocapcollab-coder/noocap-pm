// Fixed replies for the brand messages that keep coming back (Harsh, Nov 17): "thanks for the script, it's with the
// client for review", "when can we expect the video?", "any update on the revised cut?". Each one has a set answer with
// set timings (script 2-3 working days after the brief, first draft 3-4 after script approval, revised cut 1-2 after
// feedback), sent by the PM on its own in the brand's thread.
// The wording lives in the Notion table "Reply Templates" (under Brand Deals Automation System) so the team can edit it without code;
// the copies below are the fallback when the table can't be read, and the starting rows of the table.
// Safety: a template only goes when the brand's whole message is that one thing, the deal is at the right stage, the
// brand's own deadline isn't sooner than what the template promises, and the same template hasn't already gone in that
// thread in the last 3 days (a second chase goes to Harsh instead, so a brand never gets the same line twice).
import { notion, plain } from './notion.js';
import { STAGES, stageBefore } from './outbox.js';

export const TEMPLATES_DS = process.env.REPLY_TEMPLATES_DS || '41b508e9-9dda-81dd-8d24-000b2c975ad4';
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];

export const BUILT_IN = [
  {
    key: 'script_review_ack',
    when: 'The brand says they got the script and it is with their team or client for review. Nothing else asked.',
    stages: ['Script Sent'],
    days: 0,
    body: 'Hi {name},\n\nThanks for letting us know. We\'ll wait for the feedback, and as soon as the script is approved we\'ll move straight into filming.\n\nBest,\n{creator}\'s Team',
  },
  {
    key: 'script_eta',
    when: 'The brand asks when the script will be ready. The script has not been sent yet. Nothing else asked.',
    stages: ['Price Agreed', 'Signed', 'Brief Received'],
    days: 3,
    body: 'Hi {name},\n\nThanks for checking in. We\'re working on the script now and you\'ll have it within 2 to 3 working days, here in this thread.\n\nBest,\n{creator}\'s Team',
  },
  {
    key: 'video_eta',
    when: 'The brand asks when the video or first draft will be ready. The script is approved and no cut has been sent yet. Nothing else asked.',
    stages: ['Script Approved', 'In Production'],
    days: 4,
    body: 'Hi {name},\n\nThanks for checking in. The video is in production and you\'ll have the first draft within 3 to 4 working days, which we\'ll share here for your review.\n\nBest,\n{creator}\'s Team',
  },
  {
    key: 'revision_eta',
    when: 'The brand asks when the revised cut will be ready, after they sent feedback on a video we delivered. Nothing else asked.',
    stages: ['Submitted', 'In Production'],
    days: 2,
    body: 'Hi {name},\n\nThanks for following up. Our editor is working through your feedback and you\'ll have the revised cut within 1 to 2 working days.\n\nBest,\n{creator}\'s Team',
  },
  {
    key: 'script_changes_ack',
    when: 'The brand sent changes or notes on a script we sent (or a new brief for it). Nothing else asked.',
    stages: ['Script Sent', 'Brief Received', 'Script Approved', 'In Production', 'Submitted', 'Approved'],
    days: 3,
    body: 'Hi {name},\n\nThanks for the notes. We\'ve passed them to our writer and you\'ll have the revised script within 2 to 3 working days, here in this thread.\n\nBest,\n{creator}\'s Team',
  },
  {
    // Harsh, Nov 18: when the brand approves the video and says it's good to publish, this goes straight out (no
    // approval), so the invoice can leave together with the live link (Dreamina x Chris)
    key: 'billing_on_approval',
    when: 'The brand approved the final video and says it is good to go or asks us to publish it. Nothing else asked.',
    stages: ['Submitted', 'Approved'],
    days: 0,
    body: 'Hi {name},\n\nThanks for approving the video. We\'ll get it posted as soon as possible and share the live link here.\n\nIn the meantime, could you please send over your company\'s billing details (registered company name, billing email, full address, and VAT or tax ID if you have one)? That way the invoice can go out together with the live link.\n\nBest,\n{creator}\'s Team',
  },
  {
    // Harsh, Nov 19 (Luma x Chris): "confirm you're ready to publish and your publishing date" needs no approval. The date
    // is the card's POST DATE; with no date on the card it isn't sent
    key: 'publish_date_confirm',
    when: 'The brand approved the content and asks us to confirm we are ready to publish and/or when it will be published (it may also list posting instructions: CTA, tracking link, bio link, story, tags). Nothing else asked.',
    stages: ['Script Approved', 'In Production', 'Submitted', 'Approved'],
    days: 0,
    body: 'Hi {name},\n\nThanks for the approval. We\'re ready to publish, and it goes live on {post_date}, set up as you listed.\n\nOnce it\'s live we\'ll send the links here in this thread.\n\nBest,\n{creator}\'s Team',
  },
  {
    // Harsh, Nov 24 (Manyfast x Duncan): a plain script approval got no reply at all. The PM sends this itself right after
    // it handles the approval (lib/inbox.js, script_approved), unless the tool-access email is going out in the thread
    key: 'script_approved_ack',
    when: 'The brand approved the script and asks us to go ahead with filming or production. Nothing else asked.',
    // Paid: deals paid upfront stay at Paid through production (Manyfast x Duncan)
    stages: ['Script Approved', 'In Production', 'Paid'],
    days: 0,
    body: 'Hi {name},\n\nThanks for approving the script! We\'re moving into production now, and you\'ll have the first draft within 3 to 4 working days, here in this thread.\n\nBest,\n{creator}\'s Team',
  },
  {
    key: 'draft_review_ack',
    when: 'The brand says they got the video draft and it is with their team or client for review. Nothing else asked.',
    stages: ['Submitted'],
    days: 0,
    body: 'Hi {name},\n\nThanks for the update. We\'ll wait for the feedback on the video, and if anything needs changing our editor will turn it around within 1 to 2 working days.\n\nBest,\n{creator}\'s Team',
  },
];
export const TEMPLATE_KEYS = BUILT_IN.map((t) => t.key);

// The templates in use: the Notion table's rows over the built-in copies (same key). Rows with a new key (added by the
// PM's weekly learning or by the team) are used too, with the stages and timing written on the row.
const STAGE_NAMES = STAGES;
const promisedDays = (s) => { const n = String(s || '').match(/(\d+)\s*(?:to|-|–)?\s*(\d+)?\s*working days/i); return n ? Number(n[2] || n[1]) : 0; };
let cache = null;
export async function loadTemplates({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.t < 5 * 60e3) return cache.list;
  let rows = [];
  if (TEMPLATES_DS) {
    const r = await notion('POST', `/data_sources/${TEMPLATES_DS}/query`, { page_size: 100 }).catch(() => ({ results: [] }));
    rows = (r.results || []).filter((p) => !p.in_trash).map((p) => ({
      id: p.id, key: plain(p.properties?.Key), when: plain(p.properties?.["When it's used"]), body: plain(p.properties?.Reply),
      active: p.properties?.Active?.checkbox === true, timing: plain(p.properties?.['Timing promised']),
      stages: String(plain(p.properties?.Stages) || '').split(/\s*,\s*/).filter((x) => STAGE_NAMES.includes(x)),
      examples: plain(p.properties?.Examples) || '', previous: plain(p.properties?.['Previous reply']) || '',
    })).filter((x) => x.key);
  }
  const list = BUILT_IN.map((t) => { const row = rows.find((x) => x.key === t.key); return row ? { ...t, id: row.id, body: row.body || t.body, when: row.when || t.when, active: row.active, stages: row.stages.length ? row.stages : t.stages, examples: row.examples, previous: row.previous } : { ...t, active: !TEMPLATES_DS }; });
  for (const row of rows) if (!BUILT_IN.some((t) => t.key === row.key) && !row.key.startsWith('_') && row.stages.length && row.body) list.push({ ...row, days: promisedDays(row.timing) });
  cache = { list, t: Date.now() };
  return list;
}

// The classifier's "template" field, built from the active templates (so a template added in Notion is recognised)
export function templateField(list) {
  const act = (list || []).filter((t) => t.active);
  return {
    type: ['string', 'null'], enum: [...act.map((t) => t.key), null],
    description: `Only for a brand message whose WHOLE point is one of these, with nothing else asked or shared: ${act.map((t) => `${t.key} = ${t.when}`).join('; ')}. null when the message also asks or gives anything else (an invoice, billing, a contract, changes, a question about the creator, a specific deadline to confirm), or is from our side.`,
  };
}

// A mailbox's role word is never a person's name. AI Inspo x Duncan, Nov 23: "Business VivaVideoapp"
// <business@vivavideotech.com> got a fixed reply opening "Hi Business"; Jessie signs every email (rule 68). When the
// From name is a role word, the name she signs with is used. Pure.
const ROLE_WORD = /^(team|info|hello|the|partner|partners|partnerships?|collabs?|collaborations?|marketing|brand|brands|creators?|business|contact|support|sales|media|campaigns?|outreach|admin|official|press|growth|finance|billing|accounts?|hr|ops|operations|studio|agency|noreply|no-reply)$/i;
// The name a person signs with wins over the mailbox's display name: people often write under another name than the
// one on the account (Atoms x Lindsay, Nov 23: "xiaohua su" <may@atoms.dev> signs every email "May", and the fixed reply
// opened "Hi xiaohua", in lower case; rule 68). A display name in lower case is capitalised.
const signedName = (text = '') => {
  const sig = String(text || '').match(/(?:^|\n)[ \t]*(?:[Bb]est|[Tt]hanks|[Rr]egards|[Cc]heers|[Kk]ind [Rr]egards|[Ww]arm [Rr]egards|[Tt]hank [Yy]ou|[Ss]incerely)\b[^\n]{0,10}\n[ \t]*([A-Z][a-z'-]{1,20})[ \t]*(?:\n|$)/);
  // Our own people signing a quoted email are never the brand (Harsh signed the early Joylo emails)
  return sig && !ROLE_WORD.test(sig[1]) && !/^(Harsh|Pratham|Noocap)$/i.test(sig[1]) ? sig[1] : '';
};
const firstName = (from, text = '') => {
  const signed = signedName(text);
  if (signed) return signed;
  const disp = (String(from || '').match(/^\s*"?([^"<@]+?)"?\s*</) || [])[1] || '';
  const first = disp.trim().split(/\s+/)[0] || '';
  if (/^[A-Za-z][a-z]{1,14}$/.test(first) && !ROLE_WORD.test(first)) return first[0].toUpperCase() + first.slice(1);
  const local = (String(from || '').match(/([\w.+-]+)@/) || [])[1] || '';
  const l = local.split(/[._-]/)[0];
  if (/^[a-z]{3,12}$/i.test(l) && !ROLE_WORD.test(l)) return l[0].toUpperCase() + l.slice(1).toLowerCase();
  return '';
};

// The post date the team set on the deal's video card (POST DATE), as "Saturday, November 21". Only this date, never a
// guess: a template that needs it is not sent when the card has none.
// A POST DATE that has already passed is stale (the brand held the post, the date was never moved) and is never quoted
// to a brand: the template is not sent and the date goes to Harsh (bug hunter, ElevenLabs x Duncan, Nov 24: Yulia's
// approval on Nov 24 got "it goes live on Wednesday, October 28" from a card dated Oct 28 that sat on hold). Pure.
export const usablePostDay = (day, today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)) =>
  day && String(day).slice(0, 10) >= String(today).slice(0, 10) ? String(day).slice(0, 10) : '';
export async function cardPostDate(deal) {
  const id = (String(deal?.linkedVideo || '').match(/([0-9a-f]{32})(?:\?|$)/i) || [])[1];
  if (!id) return '';
  try {
    const page = await notion('GET', `/pages/${id}`);
    const dp = Object.entries(page.properties || {}).find(([n, v]) => v.type === 'date' && /post/i.test(n) && !/posted/i.test(n));
    const day = usablePostDay(dp?.[1]?.date?.start);
    return day ? fmtDay(day) : '';
  } catch { return ''; }
}
export const fmtDay = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function fillTemplate(body, { from, deal, postDate = '', text = '' }) {
  const name = firstName(from, text);
  return String(body)
    .replace(/\{post_date\}/g, postDate)
    .replace(/Hi \{name\},/g, name ? `Hi ${name},` : 'Hi there,')
    .replace(/\{name\}/g, name || 'there')
    .replace(/\{creator\}/g, deal?.creator || 'NOOCAP')
    .replace(/\{brand\}/g, deal?.brand || '');
}

// A fixed reply never promises a script that already went. The contract_ack row says "we'll share the script with you
// here in this thread", which is right before the script and wrong after it (Topview AI x Lindsay, Nov 22: Su Wern sent
// the corrected agreement a day after approving our script and was told we would share the script; the deal's memory
// then said we owe the script). Once the deal has a Script Sent Date or is at Script Sent or later, the script clause
// is cut ("..., and we'll share the script ..." or a whole sentence about sharing/sending the script). Pure.
export function dropSentScriptPromise(body, deal = {}) {
  const at = STAGES.indexOf(deal?.stage);
  const done = !!deal?.scriptSent || (at >= 0 && at >= STAGES.indexOf('Script Sent'));
  if (!done) return String(body);
  return String(body)
    .replace(/,?\s+and\s+we(?:'|’)ll\s+(?:share|send)\s+(?:you\s+)?the\s+script[^.\n]*\./gi, '.')
    .replace(/[ \t]*\bWe(?:'|’)ll\s+(?:share|send)\s+(?:you\s+)?the\s+script[^.\n]*\.[ \t]*/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

// Working days from today (India date), Mon-Fri
export function addWorkingDays(from, n) {
  const d = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6) left--; }
  return d.toISOString().slice(0, 10);
}

// Can this template go for this deal now? Pure. Returns '' when it can, or why not.
// Timing promises. Once one went in a thread and nothing it promised has been sent since, a brand chasing it gets a
// date from Harsh, never the same "2 to 3 working days" again (Atoms x Lindsay, Nov 23: the Nov 19 script_changes_ack
// promised the revised script in 2 to 3 working days; when May chased on Nov 23 the script_eta template promised
// another 2 to 3 working days; lesson "A brand chasing a promised posting gets a time from Harsh").
export const ETA_KEYS = new Set(['script_eta', 'video_eta', 'revision_eta', 'script_changes_ack', 'video_changes_ack']);
// rows: outbox rows of the thread as { why, status, kind, created }. Returns the ISO day of an open promise, or ''. Pure.
export function openEtaPromise(rows = []) {
  const sent = rows.filter((r) => r.status === 'Sent').sort((a, b) => String(a.created).localeCompare(String(b.created)));
  let open = '';
  for (const r of sent) {
    const k = (String(r.why || '').match(/\[template:([a-z_]+)\]/) || [])[1];
    if (k && ETA_KEYS.has(k)) open = String(r.created || '').slice(0, 10) || 'earlier';
    else if (open && /^(Script|Draft video)$/.test(r.kind || '')) open = '';
  }
  return open;
}
export async function etaPromised(OUTBOX_DS, threadId) {
  if (!threadId) return '';
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 30, filter: { and: [
    { property: 'Gmail Thread ID', rich_text: { equals: threadId } },
    { timestamp: 'created_time', created_time: { on_or_after: new Date(Date.now() - 14 * 864e5).toISOString() } },
  ] } }).catch(() => ({ results: [] }));
  const txt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || '').join('');
  return openEtaPromise((r.results || []).map((p) => ({ why: txt(p.properties?.Why), status: p.properties?.Status?.select?.name, kind: p.properties?.Kind?.select?.name, created: p.created_time })));
}

// The status acknowledgement that fits a stage, when the brand only gives an update ("the script is with our client,
// we'll get back to you"). Used when the reader named a template the stage doesn't allow (Holo AI x Chris, Nov 25: it
// picked contract_ack at Script Sent, was blocked, and Mateo got no reply). Pure.
export function statusAckFor(stage) {
  return { 'Script Sent': 'script_review_ack', Submitted: 'draft_review_ack' }[String(stage || '')] || null;
}
export function templateBlock(t, { stage, deadline, today, sentRecently, etaPromised = '' }) {
  if (!t || !t.active) return 'no active template';
  if (etaPromised && ETA_KEYS.has(t.key) && t.key !== 'script_changes_ack' && t.key !== 'video_changes_ack') return `we already promised a time in this thread (${etaPromised}) and the brand is chasing it: the date is Harsh's`;
  if (!t.stages.includes(stage)) return `deal is at ${stage || 'an unknown stage'}, the template is for ${t.stages.join(' / ')}`;
  if (t.days && deadline && String(deadline).slice(0, 10) < addWorkingDays(today, t.days)) return `the brand's deadline (${String(deadline).slice(0, 10)}) is sooner than the template promises`;
  // Only a reply that really went says "already went": callers treat that as done (the Invoices step stamps Billing
  // Request Sent on it). A copy still waiting in Approvals, or one Harsh rejected, blocks a second copy but is not sent
  // (Emergent x Chris and CapCut x Chris, Nov 18: held billing asks were stamped as asked, bug hunter)
  if (sentRecently === 'waiting') return 'the same reply is already waiting in Approvals (or was rejected) in this thread in the last 3 days';
  if (sentRecently) return 'the same reply already went in this thread in the last 3 days';
  return '';
}

// Has this template already gone in this thread in the last 3 days, in this round? 'sent' when one went, 'waiting' when
// the only copies are still in Approvals or were rejected, false when there is none.
// A round ends when we send something new in the thread (the revised cut, a script, any email that isn't this fixed
// reply): a copy from before that answered the last round, not this one. Topview AI x Lindsay, Nov 25: the round 1
// "we'll fix it" went at 08:36 UTC, the revised cut at 16:29, round 2 notes at 16:39 got no reply because the round 1
// copy was "already sent in the last 3 days" (Harsh: "I can't keep saying this again and again").
export function sameRoundCopy(rows = [], key) {
  const tag = `[template:${key}]`;
  const sorted = [...rows].sort((a, b) => String(a.created).localeCompare(String(b.created)));
  let copy = null;
  for (const r of sorted) {
    if (String(r.why || '').includes(tag)) { copy = r; continue; }
    if (copy && r.status === 'Sent') copy = null; // we sent something new after it: a new round
  }
  if (!copy) return false;
  return sorted.some((r) => String(r.why || '').includes(tag) && r.status === 'Sent' && String(r.created) >= String(copy.created)) ? 'sent' : 'waiting';
}
// since: the time of the brand email being answered. An acknowledgement (*_ack: "thanks, we'll fix it", "thanks, we'll
// film") answers one brand email, so a copy written before that email answered an earlier one and never blocks this
// one, even when the revised cut went by hand and left no Sent row to end the round (Weglot x Lindsay Nov 23, Topview AI
// x Lindsay Nov 25: round 2 notes got no reply). Chases (*_eta) keep the 3-day rule: a second chase goes to Harsh.
export async function sentRecently(OUTBOX_DS, threadId, key, { since = '' } = {}) {
  if (!threadId) return false;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { and: [
    { property: 'Gmail Thread ID', rich_text: { equals: threadId } },
    { timestamp: 'created_time', created_time: { on_or_after: new Date(Date.now() - 3 * 864e5).toISOString() } },
  ] } }).catch(() => ({ results: [] }));
  const txt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || '').join('');
  let rows = (r.results || []).map((p) => ({ why: txt(p.properties?.Why), status: p.properties?.Status?.select?.name, created: p.created_time }));
  if (since && /_ack$/.test(key || '')) rows = rows.filter((x) => !String(x.why || '').includes(`[template:${key}]`) || String(x.created) >= new Date(since).toISOString());
  return sameRoundCopy(rows, key);
}

export { STAGES, stageBefore, rt };

// ---------- learning from Harsh's own replies (Harsh, Nov 17: "let the second brain keep learning what the replies are") ----------
// 1. An email the PM left unread for Harsh carries a mark in the AGENT LOG ([unread thread:… template:…]).
// 2. When our side then replies in that thread by hand, the reply is saved as an example on the matching template row
//    (or on the "_new" row when no template fitted), in the Examples column.
// 3. Once a week (Sunday) the PM reads the examples: a template whose examples show Harsh says it differently gets its
//    wording updated (the old wording kept in "Previous reply"), and a situation Harsh keeps answering by hand becomes a
//    new template, added switched off for Harsh to tick. One small Haiku call per template with new examples, no more.
const MAX_EX = 1800;
const today = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

async function rowFor(key) {
  const list = await loadTemplates({ fresh: true });
  const t = list.find((x) => x.key === key && x.id);
  if (t) return t;
  if (!TEMPLATES_DS) return null;
  const r = await notion('POST', `/data_sources/${TEMPLATES_DS}/query`, { page_size: 1, filter: { property: 'Key', title: { equals: key } } }).catch(() => ({ results: [] }));
  const p = (r.results || [])[0];
  if (p) return { id: p.id, key, examples: plain(p.properties?.Examples) || '' };
  const made = await notion('POST', '/pages', { parent: { data_source_id: TEMPLATES_DS }, properties: { Key: { title: rt(key) }, "When it's used": { rich_text: rt('Brand messages Harsh answered by hand that no template covered yet. The PM learns new templates from these every Sunday.') }, Active: { checkbox: false } } });
  return { id: made.id, key, examples: '' };
}

export async function learnFromReply({ threadId, ourText, agentLogDs }) {
  if (!threadId || !String(ourText || '').trim() || !TEMPLATES_DS) return '';
  const r = await notion('POST', `/data_sources/${agentLogDs}/query`, { page_size: 3, sorts: [{ timestamp: 'created_time', direction: 'descending' }], filter: { and: [
    { property: 'Details', rich_text: { contains: `[unread thread:${threadId} ` } },
    { timestamp: 'created_time', created_time: { on_or_after: new Date(Date.now() - 10 * 864e5).toISOString() } },
  ] } }).catch(() => ({ results: [] }));
  const hit = (r.results || [])[0];
  if (!hit) return '';
  const details = plain(hit.properties?.Details) || '';
  if (details.includes('[learned]')) return '';
  const key = (details.match(/template:([\w-]+)\]/) || [])[1] || 'none';
  const row = await rowFor(key === 'none' ? '_new' : key);
  if (!row) return '';
  const brandSaid = String(plain(hit.properties?.Event) || '').slice(0, 160);
  const ex = `--- ${today()} · ${brandSaid}\n${String(ourText).replace(/\n{3,}/g, '\n\n').trim().slice(0, 600)}`;
  const all = `${ex}\n${row.examples || ''}`.slice(0, MAX_EX);
  await notion('PATCH', `/pages/${row.id}`, { properties: { Examples: { rich_text: rt(all) } } });
  await notion('PATCH', `/pages/${hit.id}`, { properties: { Details: { rich_text: rt(`${details} [learned]`) } } }).catch(() => {});
  return `saved as an example for ${key === 'none' ? 'new templates' : key}`;
}

// Writing rules every template keeps (Harsh's rules, and the placeholders the PM fills in)
export function templateOk(body) {
  const b = String(body || '');
  return /^Hi \{name\},/.test(b) && /\{creator\}'s Team\s*$/.test(b) && b.length < 900 && !/[—–]/.test(b) && !/\b(it's|it is) not\b[^.]{0,60}\b(it's|it is)\b/i.test(b);
}
const exampleCount = (s) => (String(s || '').match(/^--- /gm) || []).length;

export async function improveTemplates({ claude, HAIKU, notify = async () => {} }) {
  if (!TEMPLATES_DS) return [];
  const list = await loadTemplates({ fresh: true });
  const done = [];
  const RULES = 'Write like a friendly agency team member, in short plain sentences joined naturally. Never stack three items in a list for rhythm, never write "it\'s not X, it\'s Y", never chop ideas into short choppy fragments, never use dashes. Keep the placeholders exactly: start with "Hi {name}," and end with "Best,\\n{creator}\'s Team". Never promise a different timing than the current reply unless every example uses the new timing.';
  for (const t of list.filter((x) => x.id && exampleCount(x.examples) >= 2)) {
    const out = await claude({ _job: 'templates', model: HAIKU, max_tokens: 600, system: RULES,
      tools: [{ name: 'update', description: 'Decide whether the template should change', input_schema: { type: 'object', properties: { change: { type: 'boolean' }, reply: { type: 'string' }, why: { type: 'string' } }, required: ['change', 'why'] } }],
      tool_choice: { type: 'tool', name: 'update' },
      messages: [{ role: 'user', content: `A fixed reply our PM sends to brands.\nWhen it is used: ${t.when}\n\nCurrent reply:\n${t.body}\n\nHow Harsh actually answered these messages himself:\n${t.examples}\n\nShould the fixed reply change so it reads more like Harsh's own answers (tone, wording, what it promises)? Only change it if his answers clearly differ. If so, give the full new reply.` }] });
    const x = (out.content || []).find((c) => c.type === 'tool_use')?.input || {};
    const props = { Examples: { rich_text: [] } };
    if (x.change && templateOk(x.reply) && x.reply.trim() !== t.body.trim()) {
      Object.assign(props, { Reply: { rich_text: rt(x.reply.trim()) }, 'Previous reply': { rich_text: rt(t.body) } });
      done.push(`${t.key}: ${String(x.why || '').slice(0, 140)}`);
    }
    await notion('PATCH', `/pages/${t.id}`, { properties: props }).catch(() => {});
  }
  // New templates from situations Harsh keeps answering by hand
  const r = await notion('POST', `/data_sources/${TEMPLATES_DS}/query`, { page_size: 1, filter: { property: 'Key', title: { equals: '_new' } } }).catch(() => ({ results: [] }));
  const nw = (r.results || [])[0];
  const nex = nw ? plain(nw.properties?.Examples) || '' : '';
  if (nw && exampleCount(nex) >= 3) {
    const out = await claude({ _job: 'templates', model: HAIKU, max_tokens: 900, system: RULES,
      tools: [{ name: 'propose', description: 'New fixed replies', input_schema: { type: 'object', properties: { templates: { type: 'array', maxItems: 2, items: { type: 'object', properties: { key: { type: 'string', description: 'snake_case' }, when: { type: 'string' }, reply: { type: 'string' }, stages: { type: 'array', items: { type: 'string', enum: STAGES } }, timing: { type: 'string' } }, required: ['key', 'when', 'reply', 'stages'] } } }, required: ['templates'] } }],
      tool_choice: { type: 'tool', name: 'propose' },
      messages: [{ role: 'user', content: `Brand messages Harsh answered by hand, with his answers:\n${nex}\n\nExisting fixed replies: ${list.map((t) => t.key).join(', ')}.\nPropose a new fixed reply only for a situation that appears at least 3 times above, is a single simple question or update, and that no existing fixed reply covers. Otherwise return an empty list.` }] });
    const x = (out.content || []).find((c) => c.type === 'tool_use')?.input || {};
    for (const n of (x.templates || []).slice(0, 2)) {
      const key = String(n.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
      if (!key || list.some((t) => t.key === key) || !templateOk(n.reply) || !(n.stages || []).length) continue;
      await notion('POST', '/pages', { parent: { data_source_id: TEMPLATES_DS }, properties: { Key: { title: rt(key) }, "When it's used": { rich_text: rt(n.when) }, Reply: { rich_text: rt(n.reply) }, Stages: { rich_text: rt(n.stages.join(', ')) }, 'Timing promised': { rich_text: rt(n.timing || '') }, Active: { checkbox: false } } }).catch(() => {});
      done.push(`new template ${key} (switched off until you tick Active)`);
    }
    await notion('PATCH', `/pages/${nw.id}`, { properties: { Examples: { rich_text: [] } } }).catch(() => {});
  }
  cache = null;
  if (done.length) await notify(`💬 Reply templates learned from your replies this week:\n${done.map((d) => `• ${d}`).join('\n')}\nCheck them in Notion → Reply Templates.`);
  return done;
}

// Send one fixed reply into a deal's thread by hand (the ?sendtemplate= hook): for a brand message that came in before
// the templates existed. Same stage and once-per-3-days checks as the automatic path.
export async function sendTemplateToDeal(dealId, key, { from = '', since = '', today: day = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10) } = {}) {
  const { openDeals } = await import('./briefs.js');
  const { createDraft, autoSend, OUTBOX_DS } = await import('./outbox.js');
  const deal = (await openDeals({ withClosed: true })).find((d) => String(d.id).replace(/-/g, '') === String(dealId).replace(/-/g, ''));
  if (!deal) return { sent: false, why: 'deal not found' };
  const t = (await loadTemplates({ fresh: true })).find((y) => y.key === key && y.active);
  const block = templateBlock(t, { stage: deal.stage, deadline: deal.deadline, today: day, sentRecently: await sentRecently(OUTBOX_DS, deal.threadId, key, { since }) });
  if (block) return { sent: false, why: block };
  const postDate = /\{post_date\}/.test(t.body) ? await cardPostDate(deal) : '';
  if (/\{post_date\}/.test(t.body) && !postDate) return { sent: false, why: 'no upcoming POST DATE on the video card (none, or it has passed)' };
  const body = fillTemplate(t.body, { from: from || deal.brandEmail, deal, postDate });
  const r = await createDraft({ kind: 'Reply', deal, subject: `Re: ${deal.threadSubject || deal.brand}`, body, video: deal.linkedVideo, notify: false, why: `Fixed reply (sent by hand) [template:${key}]: ${deal.brand} × ${deal.creator}` });
  if (!r?.created || !r.id) return { sent: false, why: r?.reason || 'draft not made' };
  const sent = await autoSend(r.id); if (sent?.held) return { sent: false, why: sent.why };
  return { sent: true, to: deal.brandEmail, deal: `${deal.brand} × ${deal.creator}`, body };
}
