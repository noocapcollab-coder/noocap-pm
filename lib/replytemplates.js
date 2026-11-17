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
    key: 'draft_review_ack',
    when: 'The brand says they got the video draft and it is with their team or client for review. Nothing else asked.',
    stages: ['Submitted'],
    days: 0,
    body: 'Hi {name},\n\nThanks for the update. We\'ll wait for the feedback on the video, and if anything needs changing our editor will turn it around within 1 to 2 working days.\n\nBest,\n{creator}\'s Team',
  },
];
export const TEMPLATE_KEYS = BUILT_IN.map((t) => t.key);

// The templates in use: the Notion table's active rows over the built-in copies (same key)
let cache = null;
export async function loadTemplates() {
  if (cache && Date.now() - cache.t < 5 * 60e3) return cache.list;
  let rows = [];
  if (TEMPLATES_DS) {
    const r = await notion('POST', `/data_sources/${TEMPLATES_DS}/query`, { page_size: 50 }).catch(() => ({ results: [] }));
    rows = (r.results || []).filter((p) => !p.in_trash).map((p) => ({ key: plain(p.properties?.Key), body: plain(p.properties?.Reply), active: p.properties?.Active?.checkbox !== false }));
  }
  const list = BUILT_IN.map((t) => { const row = rows.find((x) => x.key === t.key); return row ? { ...t, body: row.body || t.body, active: row.active } : { ...t, active: true }; });
  cache = { list, t: Date.now() };
  return list;
}

const firstName = (from) => {
  const disp = (String(from || '').match(/^\s*"?([^"<@]+?)"?\s*</) || [])[1] || '';
  const first = disp.trim().split(/\s+/)[0] || '';
  if (/^[A-Za-z][a-z]{1,14}$/.test(first) && !/^(team|info|hello|partnerships?|marketing|support|the)$/i.test(first)) return first;
  const local = (String(from || '').match(/([\w.+-]+)@/) || [])[1] || '';
  const l = local.split(/[._-]/)[0];
  return /^[a-z]{3,12}$/i.test(l) && !/^(info|hello|team|partner|partners|partnerships|collab|marketing|brand|creators?|business|contact|support|sales|media|campaigns?|outreach)$/i.test(l) ? l[0].toUpperCase() + l.slice(1).toLowerCase() : '';
};

export function fillTemplate(body, { from, deal }) {
  const name = firstName(from);
  return String(body)
    .replace(/Hi \{name\},/g, name ? `Hi ${name},` : 'Hi there,')
    .replace(/\{name\}/g, name || 'there')
    .replace(/\{creator\}/g, deal?.creator || 'NOOCAP')
    .replace(/\{brand\}/g, deal?.brand || '');
}

// Working days from today (India date), Mon-Fri
export function addWorkingDays(from, n) {
  const d = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6) left--; }
  return d.toISOString().slice(0, 10);
}

// Can this template go for this deal now? Pure. Returns '' when it can, or why not.
export function templateBlock(t, { stage, deadline, today, sentRecently }) {
  if (!t || !t.active) return 'no active template';
  if (!t.stages.includes(stage)) return `deal is at ${stage || 'an unknown stage'}, the template is for ${t.stages.join(' / ')}`;
  if (t.days && deadline && String(deadline).slice(0, 10) < addWorkingDays(today, t.days)) return `the brand's deadline (${String(deadline).slice(0, 10)}) is sooner than the template promises`;
  if (sentRecently) return 'the same reply already went in this thread in the last 3 days';
  return '';
}

// Has this template already gone in this thread in the last 3 days?
export async function sentRecently(OUTBOX_DS, threadId, key) {
  if (!threadId) return false;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 5, filter: { and: [
    { property: 'Gmail Thread ID', rich_text: { equals: threadId } },
    { property: 'Why', rich_text: { contains: `[template:${key}]` } },
    { timestamp: 'created_time', created_time: { on_or_after: new Date(Date.now() - 3 * 864e5).toISOString() } },
  ] } }).catch(() => ({ results: [] }));
  return (r.results || []).length > 0;
}

export { STAGES, stageBefore, rt };
