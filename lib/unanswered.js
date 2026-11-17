// Brand emails nobody answered (Harsh, Nov 17: "we haven't replied most of them"). Reads every deal's own record of its
// emails (the 📨 lines on the deal page, from every inbox) and lists the deals whose newest email is from the brand, with
// no reply waiting in Approvals. Pure parts are exported for tests.
import { notion, plain } from './notion.js';
import { openDeals } from './briefs.js';
import { readTranscript } from './memory.js';
import { OUTBOX_DS } from './outbox.js';

// The newest email in a deal's record: { side: 'brand'|'ours', date, from, subject, text }
export function lastEntry(transcript) {
  const parts = String(transcript || '').split(/\n?(?=📨 )/).filter((p) => p.startsWith('📨 '));
  const p = parts[parts.length - 1];
  if (!p) return null;
  const head = p.split('\n')[0];
  const m = head.match(/^📨 (\d{4}-\d{2}-\d{2}) · (.+?) · (.*)$/) || head.match(/^📨 (\d{4}-\d{2}-\d{2}) · (.+)$/);
  if (!m) return null;
  const who = m[2] || '';
  const side = /^brand\b/i.test(who) ? 'brand' : 'ours';
  return { side, date: m[1], from: who.replace(/^brand\s*/i, '').replace(/^\(|\)$/g, ''), subject: m[3] || '', text: p.split('\n').slice(1).join('\n').replace(/<br\s*\/?>/g, '\n').trim() };
}

export async function unanswered({ days = 10 } = {}) {
  const deals = (await openDeals({ withClosed: true })).filter((d) => d.stage !== 'Lost' && d.channel !== 'WhatsApp');
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const waiting = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { property: 'Status', select: { equals: 'Draft' } } }).catch(() => ({ results: [] }));
  const hasDraft = new Set((waiting.results || []).flatMap((r) => (r.properties?.Deal?.relation || []).map((x) => x.id.replace(/-/g, ''))));
  const out = [];
  for (const d of deals) {
    if (d.lastBrand && String(d.lastBrand).slice(0, 10) < since) continue;
    const t = await readTranscript(d.id, 6000).catch(() => '');
    const e = lastEntry(t);
    if (!e || e.side !== 'brand' || e.date < since) continue;
    out.push({ id: d.id, url: d.url, deal: `${d.brand} × ${d.creator || '?'}`, stage: d.stage, threadId: d.threadId, date: e.date, from: e.from, subject: e.subject, text: e.text.slice(0, 900), draftWaiting: hasDraft.has(d.id.replace(/-/g, '')), card: d.linkedVideo || '', nextAction: d.nextAction });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}
