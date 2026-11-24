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
    if (!e || e.date < since) continue;
    // The creator's team looped us in (or forwarded the brief) and NOOCAP never wrote in the deal: the brand is still
    // waiting to hear we have it (HubSpot x Duncan, Nov 20, found only when Harsh looked on Nov 23)
    const loopIn = e.side === 'ours' && /team/i.test(e.from) && !/📨 \d{4}-\d{2}-\d{2} · us\b/.test(t);
    if (e.side !== 'brand' && !loopIn) continue;
    out.push({ kind: loopIn ? 'loop-in, NOOCAP never replied' : 'brand wrote last', id: d.id, url: d.url, deal: `${d.brand} × ${d.creator || '?'}`, stage: d.stage, threadId: d.threadId, date: e.date, from: e.from, subject: e.subject, text: e.text.slice(0, 900), draftWaiting: hasDraft.has(d.id.replace(/-/g, '')), card: d.linkedVideo || '', nextAction: d.nextAction, lastBrand: d.lastBrand || '' });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

// No reply is needed for: an emoji reaction, a signing platform's "all parties signed" notice, an out-of-office. Pure.
export function noReplyNeeded(text) {
  const t = String(text || '');
  return /reacted via Gmail|已通过 Gmail|reacted to your message/i.test(t)
    || /^\s*(completed:|all parties have signed|you('ve| have) (signed|completed))/im.test(t)
    || /\b(out of (the )?office|automatic reply|auto-?reply)\b/i.test(t.slice(0, 300));
}

// The safety net that runs every hour (Harsh, Nov 24: "how can we keep missing replies, how many times do I have to
// point it out"; Manyfast x Duncan's script approval sat 14 hours with no answer). Whatever the email reader decided,
// a deal whose newest email is the brand's, 2+ hours old, with nothing waiting in Approvals, gets a reply drafted into
// Approvals for Harsh's Send, and Harsh gets one list in #pm-alerts. Each brand email is handled once: its time is
// stamped on the deal (Reply Check). Nothing is sent from here.
export async function sweepUnanswered({ hours = 2, days = 4, dry = false, max = 8 } = {}) {
  const items = await unanswered({ days });
  const { openDeals, discord } = await import('./briefs.js');
  const { createDraft, writeEmail } = await import('./outbox.js');
  const deals = await openDeals({ withClosed: true });
  const now = Date.now();
  const out = { drafted: [], listed: [], skipped: [] };
  let made = 0;
  for (const it of items) {
    const deal = deals.find((d) => d.id === it.id);
    if (!deal) continue;
    const at = Date.parse(it.lastBrand || '') || Date.parse(it.date + 'T12:00:00+05:30');
    if (!Number.isFinite(at) || now - at < hours * 36e5) continue;
    if (it.draftWaiting) { out.skipped.push(`${it.deal}: a reply already waits in Approvals`); continue; }
    const page = await notion('GET', `/pages/${deal.id}`).catch(() => null);
    const stamp = plain(page?.properties?.['Reply Check']);
    const key = new Date(at).toISOString().slice(0, 16);
    if (stamp === key) continue;
    if (noReplyNeeded(it.text)) { out.skipped.push(`${it.deal}: no reply needed (reaction or notice)`); if (!dry) await stampReplyCheck(page, deal.id, key); continue; }
    if (dry) { out.listed.push(`${it.deal} (${it.date}): ${it.text.slice(0, 140).replace(/\s+/g, ' ')}`); continue; }
    let drafted = false;
    if (made < max && deal.threadId) {
      try {
        const mail = await writeEmail({ kind: 'Reply', deal, facts: { their_latest_message: it.text.slice(0, 2500), note: 'They are waiting on us. Answer what they said or asked, briefly and warmly. If they asked for something we do not have here (an account email, analytics, a date), say we will send it shortly, without inventing details or dates. Never agree to new terms, prices or signatures.' } });
        const r = await createDraft({ kind: 'Reply', deal, subject: mail.subject || `Re: ${deal.threadSubject || deal.brand}`, body: mail.body, video: deal.linkedVideo, why: `Needs you: unanswered brand email from ${it.date} (the hourly reply check found no reply) · ${it.deal}` });
        drafted = !!r?.created; if (drafted) made++;
      } catch (e) { console.error('unanswered draft', it.deal, e.message); }
    }
    (drafted ? out.drafted : out.listed).push(`${it.deal} (${it.date}): ${it.text.slice(0, 140).replace(/\s+/g, ' ')}`);
    await stampReplyCheck(page, deal.id, key);
  }
  if (!dry && (out.drafted.length || out.listed.length)) {
    const lines = [...out.drafted.map((l) => `• ✍️ ${l}`), ...out.listed.map((l) => `• ⚠️ ${l} (no draft, please reply)`)];
    await discord(`📭 **Brand emails nobody answered (2+ hours)**${out.drafted.length ? `\n${out.drafted.length} reply draft${out.drafted.length > 1 ? 's are' : ' is'} waiting in Approvals.` : ''}\n${lines.join('\n')}`.slice(0, 1950), 'pm').catch(() => {});
  }
  return out;
}
async function stampReplyCheck(page, id, key) {
  try {
    const ds = page?.parent?.data_source_id;
    if (ds && page && !page.properties?.['Reply Check']) await notion('PATCH', `/data_sources/${ds}`, { properties: { 'Reply Check': { rich_text: {} } } });
    await notion('PATCH', `/pages/${id}`, { properties: { 'Reply Check': { rich_text: [{ type: 'text', text: { content: key } }] } } });
  } catch (e) { console.error('reply check stamp', e.message); }
}
