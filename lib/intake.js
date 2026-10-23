// Video Intake: the editors' database (Frame.io link, editor, status). The editor bot already messages editors when
// a row's Status changes (Changes = revise, To Post = render the CTAs for the other platforms), so the PM only has to
// set the right Status and write the brand's feedback on the row.
import { notion, plain } from './notion.js';
import { DS } from './tools.js';

const INTAKE_CREATOR = { valeri: 'Valerie', emtech: 'EmTech', 'david iya': 'David', nicole: 'NICOLE' };
export const intakeCreator = (c) => INTAKE_CREATOR[String(c || '').toLowerCase()] || c;
const normBrand = (s) => String(s || '').toLowerCase().replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];

export function readIntake(p) {
  const get = (n) => plain(p.properties?.[n]);
  return { id: p.id, url: p.url, title: get('Video Title') || '', status: get('Status') || '', frame: get('Frame.io Link') || null, editor: get('Editor') || null, revisions: Number(get('Revisions') || 0), changesAt: get('Changes Requested At') || null, created: p.created_time };
}

// Does a Video Intake title name this brand? The full name ("ZenBusiness × Lindsay"), or a short form of it the team
// used for the videos ("ZEN UGC 1", "Dreamina 2"): a word of at least 3 letters the brand name starts with
const GENERIC = new Set(['ugc', 'video', 'videos', 'new', 'the', 'long', 'short', 'reel', 'reels', 'form', 'sponsor', 'cut', 'final', 'draft', 'part', 'and']);
export function titleNamesBrand(title, brand) {
  const b = normBrand(brand);
  if (!b || b.length < 3) return false;
  if (normBrand(title).includes(b)) return true;
  return String(title || '').toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w) && b.startsWith(w));
}

// Every open (not posted) Video Intake row for this deal's brand and creator, newest first. A deal with several
// videos (ZEN UGC 1, 2, 3) has several rows.
export async function findIntakeRows(deal) {
  if (!normBrand(deal.brand) || !deal.creator) return [];
  const res = await notion('POST', `/data_sources/${DS.intake}/query`, {
    page_size: 50,
    filter: { and: [{ property: 'Creator', select: { equals: intakeCreator(deal.creator) } }, { property: 'Status', select: { does_not_equal: 'Posted' } }] },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });
  return (res.results || []).map(readIntake).filter((r) => titleNamesBrand(r.title, deal.brand));
}

// The sponsor video in Video Intake for this deal: same creator, SPONSOR, title mentions the brand, not posted yet
export async function findIntakeRow(deal) {
  const b = normBrand(deal.brand);
  if (!b || !deal.creator) return null;
  const open = await findIntakeRows(deal).catch(() => []);
  if (open[0]) return open[0];
  const res = await notion('POST', `/data_sources/${DS.intake}/query`, {
    page_size: 50,
    filter: { and: [{ property: 'Creator', select: { equals: intakeCreator(deal.creator) } }, { property: 'Status', select: { does_not_equal: 'Posted' } }] },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });
  const rows = (res.results || []).map(readIntake).filter((r) => normBrand(r.title).includes(b));
  if (rows[0]) return rows[0];
  // The brand is asking for changes on a video already marked Posted (marked too early, or the brand reopened it):
  // the latest row for this brand edited in the last 3 weeks goes back to the editor
  const old = await notion('POST', `/data_sources/${DS.intake}/query`, {
    page_size: 20,
    filter: { and: [{ property: 'Creator', select: { equals: intakeCreator(deal.creator) } }, { property: 'Status', select: { equals: 'Posted' } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: new Date(Date.now() - 21 * 864e5).toISOString() } }] },
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
  }).catch(() => ({ results: [] }));
  return (old.results || []).map(readIntake).find((r) => titleNamesBrand(r.title, deal.brand)) || null;
}

// Same, when there's no deal yet: match on brand (and creator if known) across all SPONSOR rows not posted yet.
// Only returns a row when exactly one matches.
export async function findIntakeRowByBrand(brand, creator) {
  const b = normBrand(brand);
  if (!b || b.length < 3) return null;
  const and = [{ property: 'Status', select: { does_not_equal: 'Posted' } }, { property: 'TYPE', select: { equals: 'SPONSOR' } }];
  if (creator) and.push({ property: 'Creator', select: { equals: intakeCreator(creator) } });
  const res = await notion('POST', `/data_sources/${DS.intake}/query`, { page_size: 100, filter: { and }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] });
  const rows = (res.results || []).map((p) => ({ ...readIntake(p), creator: plain(p.properties?.Creator) })).filter((r) => titleNamesBrand(r.title, brand));
  return rows.length === 1 ? rows[0] : null;
}

// Screenshots the brand attached to their feedback (real images only: no tiny signature logos), uploaded to Notion
async function feedbackImages(atts) {
  const imgs = (atts || []).filter((a) => /^image\//i.test(a.mimeType || '') && a.data && Buffer.byteLength(a.data, 'base64') > 15000).slice(0, 6);
  if (!imgs.length) return [];
  const { uploadToNotion } = await import('./briefs.js');
  const ids = [];
  for (const a of imgs) { const id = await uploadToNotion(a).catch(() => null); if (id) ids.push(id); }
  return ids;
}

export async function setIntake(row, status, { feedback, bumpRevision = false, images } = {}) {
  // One line per change, whatever shape the AI gave (a string is one line, never split into letters)
  if (feedback) feedback = [].concat(...[].concat(feedback).map((f) => (Array.isArray(f) ? f : [f]))).map((f) => String(f ?? '').trim()).filter(Boolean);
  const now = new Date().toISOString();
  const props = { Status: { select: { name: status } } };
  if (status === 'Changes') props['Changes Requested At'] = { date: { start: now } };
  if (status === 'To Post') props['Approved At'] = { date: { start: now } };
  if (bumpRevision) props.Revisions = { number: row.revisions + 1 };
  // The brand's changes also go in a "Brand Feedback" field, and the heartbeat posts them into the editor's Discord
  // thread ("Changes — <title>") once the editor bot has opened it (see lib/editorthreads.js)
  if (status === 'Changes' && feedback && feedback.length && process.env.DISCORD_BOT_TOKEN) {
    await ensureFeedbackFields();
    props['Brand Feedback'] = { rich_text: rt(feedback.filter(Boolean)[0] || '') };
    props['Feedback Posted'] = { checkbox: false };
  }
  await notion('PATCH', `/pages/${row.id}`, { properties: props });
  if (feedback && feedback.length) {
    const kids = feedback.filter(Boolean).slice(0, 40).map((l) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(l) } }));
    // The brand's screenshots go under the same heading, so the editor's Discord post can carry them too
    const pics = status === 'Changes' ? await feedbackImages(images).catch(() => []) : [];
    await notion('PATCH', `/blocks/${row.id}/children`, { children: [
      { object: 'block', type: 'heading_3', heading_3: { rich_text: rt(`Brand feedback · round ${row.revisions + 1} · ${now.slice(0, 10)}`) } },
      ...kids,
      ...pics.map((id) => ({ object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id } } })),
    ] });
  }
}

let fieldsDone = false;
export async function ensureFeedbackFields() {
  if (fieldsDone) return;
  fieldsDone = true;
  await notion('PATCH', `/data_sources/${DS.intake}`, { properties: { 'Brand Feedback': { rich_text: {} }, 'Feedback Posted': { checkbox: {} } } }).catch(() => {});
}

// The editor bot marks a Video Intake row To Post / Posted ("approved, render the CTAs" → "done"), but the card on
// the creator's board can be left behind at In Edit / Changes / Approval. Every heartbeat, cards whose Intake row
// has reached To Post or Posted in the last 3 days move to "10- To Post" so the board and dashboard catch up.
// Only cards still in 7–9 move: a card already at To Post, Ready, Posted or Scheduled is never touched.
const BOARD_OF = { valerie: 'Valeri', david: 'David Iya', nicole: 'Nicole', emtech: 'Emtech' };
// Only Intake "Posted" counts: that is set when the editor types done in the To Post thread (CTAs rendered).
// Intake "To Post" only means ops approved the cut and the editor still has the CTAs to do, so the card stays put.
export async function syncCardsFromIntake() {
  const { BOARDS, allVideos } = await import('./tools.js');
  const { schemaOf, findProp } = await import('./actions.js');
  const res = await notion('POST', `/data_sources/${DS.intake}/query`, {
    page_size: 50,
    filter: { and: [{ property: 'Status', select: { equals: 'Posted' } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: new Date(Date.now() - 3 * 864e5).toISOString() } }] },
  });
  const rows = (res.results || []).map((p) => ({ ...readIntake(p), creator: plain(p.properties?.Creator) }));
  if (!rows.length) return [];
  const { videos } = await allVideos();
  const moved = [];
  for (const r of rows) {
    const c = String(r.creator || '').toLowerCase();
    const board = BOARDS.find((b) => b.creator.toLowerCase() === (BOARD_OF[c] || r.creator || '').toLowerCase());
    const key = normBrand(r.title);
    if (!board || key.length < 3) continue;
    const num = (s) => parseInt(String(s || ''), 10);
    const cards = videos.filter((v) => v.creator === board.creator && [7, 8, 9].includes(num(v.status)) && (normBrand(v.title).includes(key) || key.includes(normBrand(v.title))));
    if (cards.length !== 1) continue; // none, or ambiguous: leave it for a person
    const v = cards[0];
    const schema = await schemaOf(board.ds);
    const found = findProp(schema, 'status');
    const opt = (found?.[1].status?.options || found?.[1].select?.options || []).find((o) => num(o.name) === 10);
    if (!opt) continue;
    await notion('PATCH', `/pages/${v.id}`, { properties: { [found[0]]: found[1].type === 'status' ? { status: { name: opt.name } } : { select: { name: opt.name } } } });
    moved.push(`${v.title} (${board.creator}): ${v.status} → ${opt.name}`);
  }
  return moved;
}

// Late images (see postLateImages): skip when this row already got images around the time the email was handled,
// else save them under their own heading and return their file URLs for Discord
export async function addLateImages(row, atts, label, handledAt) {
  const r = await notion('GET', `/blocks/${row.id}/children?page_size=100`);
  const t0 = Date.parse(handledAt || 0);
  const already = (r.results || []).some((b) => b.type === 'image' && Math.abs(Date.parse(b.created_time) - t0) < 15 * 60e3);
  if (already) return [];
  const ids = await feedbackImages(atts).catch(() => []);
  if (!ids.length) return [];
  await notion('PATCH', `/blocks/${row.id}/children`, { children: [
    { object: 'block', type: 'heading_3', heading_3: { rich_text: rt(`Brand images · ${label}`) } },
    ...ids.map((id) => ({ object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id } } })),
  ] });
  const after = await notion('GET', `/blocks/${row.id}/children?page_size=100`);
  return (after.results || []).filter((b) => b.type === 'image').slice(-ids.length).map((b) => b.image?.file?.url || b.image?.external?.url).filter(Boolean);
}
