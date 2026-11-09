// Brand Email on the video cards (Harsh, Nov 9): every sponsor card shows who at the brand gets our scripts and cuts,
// copied from its deal: the brand contact we reply to plus anyone else from the brand's own company on the thread.
// The creator's team and our own inboxes are left out. WhatsApp deals say so instead. Runs hourly, writes only changes.
import { notion, plain } from './notion.js';

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
  return changed;
}
