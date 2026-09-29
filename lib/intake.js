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
  return { id: p.id, url: p.url, title: get('Video Title') || '', status: get('Status') || '', frame: get('Frame.io Link') || null, editor: get('Editor') || null, revisions: Number(get('Revisions') || 0), created: p.created_time };
}

// The sponsor video in Video Intake for this deal: same creator, SPONSOR, title mentions the brand, not posted yet
export async function findIntakeRow(deal) {
  const b = normBrand(deal.brand);
  if (!b || !deal.creator) return null;
  const res = await notion('POST', `/data_sources/${DS.intake}/query`, {
    page_size: 50,
    filter: { and: [{ property: 'Creator', select: { equals: intakeCreator(deal.creator) } }, { property: 'Status', select: { does_not_equal: 'Posted' } }] },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });
  const rows = (res.results || []).map(readIntake).filter((r) => normBrand(r.title).includes(b));
  return rows[0] || null;
}

// Same, when there's no deal yet: match on brand (and creator if known) across all SPONSOR rows not posted yet.
// Only returns a row when exactly one matches.
export async function findIntakeRowByBrand(brand, creator) {
  const b = normBrand(brand);
  if (!b || b.length < 3) return null;
  const and = [{ property: 'Status', select: { does_not_equal: 'Posted' } }, { property: 'TYPE', select: { equals: 'SPONSOR' } }];
  if (creator) and.push({ property: 'Creator', select: { equals: intakeCreator(creator) } });
  const res = await notion('POST', `/data_sources/${DS.intake}/query`, { page_size: 100, filter: { and }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] });
  const rows = (res.results || []).map((p) => ({ ...readIntake(p), creator: plain(p.properties?.Creator) })).filter((r) => normBrand(r.title).includes(b));
  return rows.length === 1 ? rows[0] : null;
}

export async function setIntake(row, status, { feedback, bumpRevision = false } = {}) {
  const now = new Date().toISOString();
  const props = { Status: { select: { name: status } } };
  if (status === 'Changes') props['Changes Requested At'] = { date: { start: now } };
  if (status === 'To Post') props['Approved At'] = { date: { start: now } };
  if (bumpRevision) props.Revisions = { number: row.revisions + 1 };
  await notion('PATCH', `/pages/${row.id}`, { properties: props });
  if (feedback && feedback.length) {
    const kids = feedback.filter(Boolean).slice(0, 40).map((l) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(l) } }));
    await notion('PATCH', `/blocks/${row.id}/children`, { children: [
      { object: 'block', type: 'heading_3', heading_3: { rich_text: rt(`Brand feedback · round ${row.revisions + 1} · ${now.slice(0, 10)}`) } },
      ...kids,
    ] });
  }
}
