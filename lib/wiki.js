// Brand wiki (Harsh, Nov 12: "so the AI won't be confused in what to reply"). Karpathy's LLM-wiki idea applied to brand
// deals: every deal and every email conversation with a brand is compiled into ONE page per brand (contacts, agencies,
// rates by creator, how they work, how they pay, what went wrong before), and the PM reads that page before it reads or
// writes any email to the brand. The PM stays the only thing that sends; the wiki is its memory.
// Pages live in Notion "BRAND WIKI" (internal, has rates: never shown to editors, writers or creator boards).
import { notion, plain } from './notion.js';
import { claude, HAIKU } from './claude.js';

export const WIKI_DS = '3eddcd77-b77d-43fd-aca2-9cd19f35b7b7';
const PER_RUN = 6; // pages compiled per heartbeat, so a run never runs long

// "Higgsfield.AI", "Higgsfield" and "Bluehost 2" are the same brands as "higgsfield" and "bluehost"
export function brandKey(name) {
  return String(name || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s+\d+$/, '')
    .replace(/\.(ai|io|so|app|com|co|dev|net)\b/g, '')
    .replace(/\b(ai|app|inc|ltd|llc)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

const hashOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36); };
const chunks = (s) => { const out = []; const t = String(s || ''); for (let i = 0; i < t.length && out.length < 90; i += 1900) out.push({ type: 'text', text: { content: t.slice(i, i + 1900) } }); return out; };
const today = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

const RULES = `You keep NOOCAP Media's wiki page for ONE brand. NOOCAP is an agency that makes sponsored short videos for creators (Lindsay, Chris, Duncan, Valeri, Brad, Emtech and others) and handles the brand emails for them. The PM, an AI that answers brand emails, reads this page before every email to this brand, so write what it must know to reply correctly without asking anything we already know.
Use exactly these headings, plain text, no markdown symbols, no em dashes:
WHO: what the brand/product is, and whether they come to us directly or through an agency (name it).
CONTACTS: each person who writes to us, their email, their role or agency, who signs, who must be copied.
DEALS: one line per deal: creator, what was agreed (deliverables, rate, currency), stage, dates that matter.
HOW THEY WORK: their process as the emails show it (brief format, script approval, how drafts are reviewed and where, portals or dashboards, links they need, codes, posting rules, tool access, billing details they gave, how invoices must look).
PAYMENT: how and how fast they pay, anything outstanding.
WATCH OUT: mistakes or disputes that happened with this brand and the rule that came out of it, things they asked us never to do.
OPEN NOW: what is pending across their deals and who owes the next move.
Only facts stated in the material. If something is not known, leave it out rather than guess. Keep it under 3,500 characters for a brand with one or two deals and under 6,000 for more; never cut OPEN NOW short, shorten the older history instead.`;

// Every deal (open and closed) grouped by brand
export function groupByBrand(deals) {
  const m = new Map();
  for (const d of deals) {
    const k = brandKey(d.brand);
    if (!k) continue;
    if (!m.has(k)) m.set(k, { key: k, names: new Set(), deals: [] });
    m.get(k).names.add(d.brand);
    m.get(k).deals.push(d);
  }
  return [...m.values()];
}

const sourceHash = (g) => hashOf(g.deals.map((d) => [d.id, d.stage, d.lastBrand, d.lastOur, d.finalRate, (d.memory || '').length, d.notes.length, d.billing.length].join('|')).sort().join('#'));

async function wikiRows() {
  const out = []; let cursor;
  do {
    const r = await notion('POST', `/data_sources/${WIKI_DS}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...(r.results || [])); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

async function compile(g) {
  const { readTranscript } = await import('./memory.js');
  const per = Math.max(3000, Math.floor(26000 / g.deals.length));
  const parts = [];
  for (const d of g.deals) {
    const convo = await readTranscript(d.id, per).catch(() => '');
    parts.push([`=== Deal: ${d.brand} x ${d.creator || '?'} | stage ${d.stage || '?'} | channel ${d.channel || '?'}`,
      d.finalRate ? `Rate: ${d.finalRate} USD` : '', d.deliverables ? `Deliverables: ${d.deliverables}` : '', d.paymentTerms ? `Payment terms: ${d.paymentTerms}` : '',
      d.brandEmail ? `Brand email: ${d.brandEmail}` : '', d.threadCc ? `Thread CC: ${d.threadCc}` : '', d.billing ? `Billing details: ${d.billing}` : '',
      d.paidDate ? `Paid: ${d.paidDate}` : '', d.invoiceSent ? `Invoice sent: ${d.invoiceSent}` : '', d.notes ? `Notes: ${d.notes}` : '', d.agentNotes ? `Agent notes: ${d.agentNotes.slice(-800)}` : '',
      d.memory ? `Deal record:\n${d.memory}` : '', convo ? `Conversation (newest kept):\n${convo}` : ''].filter(Boolean).join('\n'));
  }
  const out = await claude({
    _job: 'wiki',
    model: HAIKU,
    max_tokens: 2400,
    system: RULES,
    messages: [{ role: 'user', content: `Brand: ${[...g.names].join(' / ')}\n\n${parts.join('\n\n').slice(0, 60000)}\n\nWrite the page.` }],
  });
  return (out.content || []).map((c) => c.text || '').join('').trim().replace(/[—–]/g, ',').slice(0, 7000);
}

// Heartbeat: compile the pages that are missing or out of date, a few per run (unchanged brands cost nothing)
export async function updateWiki(deals, { limit = PER_RUN } = {}) {
  const rows = await wikiRows();
  const byKey = new Map(rows.map((r) => [plain(r.properties?.Key), r]));
  const groups = groupByBrand(deals).map((g) => ({ ...g, hash: sourceHash(g), row: byKey.get(g.key) }))
    .filter((g) => !(g.row && (g.row.properties?.Locked?.checkbox || plain(g.row.properties?.['Source Hash']) === g.hash)))
    // newest activity first, so live deals are right before old ones
    .sort((a, b) => Math.max(...b.deals.map((d) => Date.parse(d.lastBrand || d.lastOur || d.created) || 0)) - Math.max(...a.deals.map((d) => Date.parse(d.lastBrand || d.lastOur || d.created) || 0)));
  const done = [];
  for (const g of groups.slice(0, limit)) {
    try {
      const page = await compile(g);
      if (page.length < 80) continue;
      const props = {
        Brand: { title: [{ type: 'text', text: { content: [...g.names][0].slice(0, 200) } }] },
        Key: { rich_text: [{ type: 'text', text: { content: g.key } }] },
        Creators: { rich_text: [{ type: 'text', text: { content: [...new Set(g.deals.map((d) => d.creator).filter(Boolean))].join(', ').slice(0, 1900) } }] },
        Deals: { number: g.deals.length },
        Page: { rich_text: chunks(page) },
        'Source Hash': { rich_text: [{ type: 'text', text: { content: g.hash } }] },
        Updated: { date: { start: today() } },
      };
      if (g.row) {
        await notion('PATCH', `/pages/${g.row.id}`, { properties: props });
        // the readable copy on the page itself: replace the old one
        const kids = (await notion('GET', `/blocks/${g.row.id}/children?page_size=100`).catch(() => ({ results: [] }))).results || [];
        for (const k of kids) await notion('DELETE', `/blocks/${k.id}`).catch(() => {});
        await notion('PATCH', `/blocks/${g.row.id}/children`, { children: blocksOf(page) });
      } else {
        await notion('POST', '/pages', { parent: { data_source_id: WIKI_DS }, properties: props, children: blocksOf(page) });
      }
      done.push([...g.names][0]);
    } catch (e) { console.error('wiki', g.key, e.message); }
  }
  return { done, left: Math.max(0, groups.length - done.length) };
}

function blocksOf(page) {
  return page.split(/\n+/).filter((l) => l.trim()).slice(0, 95).map((l) => {
    const h = l.match(/^(WHO|CONTACTS|DEALS|HOW THEY WORK|PAYMENT|WATCH OUT|OPEN NOW):\s*(.*)$/);
    if (h) return [{ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: h[1] } }] } }, ...(h[2] ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: chunks(h[2]) } }] : [])];
    return [{ object: 'block', type: 'paragraph', paragraph: { rich_text: chunks(l.replace(/^[-*•]\s*/, '• ')) } }];
  }).flat().slice(0, 100);
}

// What the PM reads: the brand's page, or '' when there is none yet
const memo = new Map();
export async function wikiFor(brand) {
  const k = brandKey(brand);
  if (!k) return '';
  if (memo.has(k) && Date.now() - memo.get(k).at < 10 * 60e3) return memo.get(k).text;
  const r = await notion('POST', `/data_sources/${WIKI_DS}/query`, { page_size: 1, filter: { property: 'Key', rich_text: { equals: k } } }).catch(() => ({ results: [] }));
  const text = plain(r.results?.[0]?.properties?.Page) || '';
  memo.set(k, { at: Date.now(), text });
  return text;
}

export const wikiPrompt = (text) => (text ? `\nWhat NOOCAP already knows about this brand from every past deal and email (brand wiki). Use it so the email fits how this brand works: never ask for something already given here, follow their process and the WATCH OUT rules. If it disagrees with the current deal's conversation, the conversation wins:\n${text.slice(0, 7000)}\n` : '');
