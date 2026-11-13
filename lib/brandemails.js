// Brand Email on the video cards (Harsh, Nov 9): every sponsor card shows who at the brand gets our scripts and cuts,
// copied from its deal: the brand contact we reply to plus anyone else from the brand's own company on the thread.
// The creator's team and our own inboxes are left out. WhatsApp deals say so instead. Runs hourly, writes only changes.
import { notion, plain, queryAll } from './notion.js';
import { DS } from './tools.js';
import { titleNamesBrand } from './intake.js';

const ADDR = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
const FREE = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail)\./i;
const company = (a) => { const d = (a.split('@')[1] || '').toLowerCase(); return FREE.test(d) ? a.toLowerCase() : d.split('.').slice(-2).join('.'); };

export function brandContacts(deal) {
  if (deal?.channel === 'WhatsApp') return 'Brand handled on WhatsApp (no email)';
  const main = ((String(deal?.brandEmail || '').match(ADDR) || [])[0] || '').toLowerCase();
  if (!main) return '';
  const home = company(main);
  const out = [main];
  for (const a of String(deal?.threadCc || '').match(ADDR) || []) {
    const k = a.toLowerCase();
    if (!out.includes(k) && !/noocap/i.test(k) && company(k) === home) out.push(k);
  }
  return out.slice(0, 5).join(', ');
}

const idOf = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [''])[0];

export async function syncBrandEmails(deals) {
  const changed = [];
  for (const d of deals) {
    const id = idOf(d.linkedVideo);
    const want = brandContacts(d);
    if (!id || !want) continue;
    try {
      const page = await notion('GET', `/pages/${id}`);
      const prop = page.properties?.['Brand Email'];
      if (!prop || prop.type !== 'rich_text') continue; // a board without the column
      if (String(plain(prop) || '').trim() === want) continue;
      await notion('PATCH', `/pages/${id}`, { properties: { 'Brand Email': { rich_text: [{ type: 'text', text: { content: want } }] } } });
      changed.push(`${d.brand} × ${d.creator}`);
    } catch { /* card gone or no access: next hour */ }
  }
  // The same contacts on each sponsor row in EDIT TRACKER (Harsh, Nov 13: "I want the mail ID of the brand the video is
  // going to"), so whoever sends or checks a cut sees where it goes. Rows not posted yet, matched by brand and creator.
  try {
    const rows = await queryAll(DS.tracker, { and: [{ property: 'TYPE', select: { equals: 'SPONSOR' } }, { property: 'Status', select: { does_not_equal: 'Posted' } }] }, { useCache: false });
    for (const r of rows) {
      const title = plain(r.properties?.['Video Title']);
      const creator = plain(r.properties?.Creator);
      const d = trackerDeal(deals, title, creator);
      const want = d ? brandContacts(d) : '';
      const prop = r.properties?.['Brand Email'];
      if (!want || !prop || String(plain(prop) || '').trim() === want) continue;
      try {
        await notion('PATCH', `/pages/${r.id}`, { properties: { 'Brand Email': { rich_text: [{ type: 'text', text: { content: want } }] } } });
        changed.push(`${title} (edit tracker)`);
      } catch { /* next hour */ }
    }
  } catch { /* EDIT TRACKER unreachable: next hour */ }
  return changed;
}

// The deal a sponsor row belongs to: its title names the brand and the creator matches ("Valerie" on the tracker is
// "Valeri" on the deal). Several deals with the same brand and creator: the newest open one.
const short = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
export function trackerDeal(deals, title, creator) {
  const hits = deals.filter((d) => d.brand && titleNamesBrand(title, d.brand) && (!creator || !d.creator || short(d.creator) === short(creator)));
  return hits.sort((a, b) => String(b.created || b.opened || '').localeCompare(String(a.created || a.opened || '')))[0] || null;
}
