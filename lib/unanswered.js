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

// What the hourly reply is told. It never promises what we do not have: the first version said "say we will send it
// shortly", which wrote promise emails (Luma AI x Lindsay's account email, Holo x Valeri's "when was it seen") and the
// filler guard let them through because the instruction itself held "shortly" (night check, Nov 24; rules 4 and 6).
export const REPLY_NOTE = 'They are waiting on us. Answer what they said or asked, briefly and warmly. If they asked for something only Harsh can give (an account email or login, analytics, a date or time, where or when something was seen, a price, a signature), do not answer or promise that part at all: no "we are checking", no "we will send it". Never agree to new terms, prices or signatures.';
export const EDITOR_TURN = /\beditor\b|\bchanges\b|\brevised cut\b|\breshoot\b/i;
// true when a reply only acknowledges and promises to check, send or follow up later. Pure.
export function promiseOnly(body) {
  const t = String(body || '');
  return /\b(we('| a)re (checking|looking into|confirming|working on getting)|we('ll| will) (check|send|share|follow up|get back|confirm|look into)|we can (definitely )?check)\b/i.test(t) || /\bshortly\b/i.test(t)
    // "We are on it and will send the draft over as soon as it is ready" (Manyfast x Duncan, morning check Nov 25)
    || /\bwe('| a)re on it\b|\bas soon as (it('s| is)|possible|we can)\b/i.test(t);
}

// true when a reply says nothing between the greeting and the sign-off beyond thanks and pleasantries ("That is great
// news that the script is approved", "Thanks for letting us know, we'll keep an eye out for their feedback"). Such a
// reply is never drafted: if the brand asked for something, the ask goes to Harsh; if it was only an acknowledgement, no
// reply is needed (morning check, Nov 25: five hollow replies in one day; Luma AI x Lindsay asked three times for the
// account email and got "great news" back; rules 61 and 77). Pure.
const PLEASANTRY = /^(hi|hello|hey|dear)\b|^(best|thanks|thank you|cheers|regards|kind regards|warm regards)[,!.]?$|team$|^(thanks|thank you|many thanks|that('s| is) (great|wonderful|good)|great news|good news|we appreciate|appreciate|we('ll| will) keep an eye|we look forward|looking forward|we('re| are) (excited|glad|happy|thrilled)|glad|happy to hear|sounds good|noted|perfect|great)\b/i;
export function hollowReply(body) {
  const lines = String(body || '').replace(/<br\s*\/?>/gi, '\n').split(/\n+|(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
  return lines.every((l) => PLEASANTRY.test(l));
}
// true when the brand's email asks us for something (a question or a request). Pure.
export function brandAsks(text) {
  return /\?|\b(please|could you|can you|kindly|let (me|us) know|share|send (us|me|over))\b/i.test(String(text || ''));
}

// The safety net that runs every hour (Harsh, Nov 24: "how can we keep missing replies, how many times do I have to
// point it out"; Manyfast x Duncan's script approval sat 14 hours with no answer). Whatever the email reader decided,
// a deal whose newest email is the brand's, 2+ hours old, with nothing waiting in Approvals, gets a reply drafted into
// Approvals for Harsh's Send, and Harsh gets one list in #pm-alerts. Each brand email is handled once: its time is
// stamped on the deal (Reply Check). Nothing is sent from here.
export async function sweepUnanswered({ hours = 1, days = 4, dry = false, max = 8 } = {}) {
  const items = await unanswered({ days });
  const { openDeals, discord } = await import('./briefs.js');
  const { createDraft, writeEmail } = await import('./outbox.js');
  const deals = await openDeals({ withClosed: true });
  const now = Date.now();
  const out = { sent: [], drafted: [], listed: [], skipped: [] };
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
    // Brand change notes (script or cut) get the fixed acknowledgement, sent now, never skipped (Harsh, Nov 26: Topview AI
    // x Lindsay round 2 sat unanswered because this net used to skip "the editor's work"; "we can't miss those emails")
    if (EDITOR_TURN.test(String(deal.nextAction || it.nextAction || '')) || /\b(feedback|changes?|revis|fix|notes?)\b/i.test(it.text)) {
      const ackKey = /script/i.test(`${deal.nextAction || ''} ${it.text.slice(0, 400)}`) && !/\b(video|cut|draft|edit)\b/i.test(it.text.slice(0, 400)) ? 'script_changes_ack' : 'video_changes_ack';
      try {
        const R = await import('./replytemplates.js');
        const r = await R.sendTemplateToDeal(deal.id, ackKey, { from: it.from, since: new Date(at).toISOString() });
        if (r?.sent) { out.sent.push(`${it.deal} (${it.date}): fixed reply ${ackKey}`); await stampReplyCheck(page, deal.id, key); continue; }
        if (r?.why) out.skipped.push(`${it.deal}: ${ackKey} not sent (${String(r.why).slice(0, 100)})`);
      } catch (e) { console.error('unanswered ack', it.deal, e.message); }
    }
    if (made < max && deal.threadId) {
      try {
        const mail = await writeEmail({ kind: 'Reply', deal, facts: { their_latest_message: it.text.slice(0, 2500), note: REPLY_NOTE } });
        // A reply that only promises a fact we do not have ("we are checking on the account email and will send it
        // over", "we'll share the details shortly") is not drafted: the brand's ask goes to Harsh in the list instead
        if (promiseOnly(mail.body)) throw new Error('only a promise, the ask needs Harsh');
        // A price nobody gave is never drafted: the rate question is Harsh's (Teamily x Lindsay, $7,000, night check Nov 25)
        const { inventedAmounts } = await import('./outbox.js');
        if (inventedAmounts(mail.body, [it.text, JSON.stringify(deal)].join('\n')).length) throw new Error('a price nobody gave, the ask needs Harsh');
        if (hollowReply(mail.body)) {
          if (brandAsks(it.text)) throw new Error('only thanks, the ask needs Harsh');
          // A status update ("still waiting on our client") still gets the stage's fixed acknowledgement (Holo AI x Chris, Nov 25)
          const R = await import('./replytemplates.js'); const ack = R.statusAckFor(deal.stage);
          if (ack) { const r = await R.sendTemplateToDeal(deal.id, ack, { from: it.from, since: new Date(at).toISOString() }).catch(() => null); if (r?.sent) { out.sent.push(`${it.deal} (${it.date}): fixed reply ${ack}`); await stampReplyCheck(page, deal.id, key); continue; } }
          out.skipped.push(`${it.deal}: only an acknowledgement, no reply needed`); await stampReplyCheck(page, deal.id, key); continue;
        }
        const r = await createDraft({ kind: 'Reply', deal, subject: mail.subject || `Re: ${deal.threadSubject || deal.brand}`, body: mail.body, video: deal.linkedVideo, why: `Needs you: unanswered brand email from ${it.date} (the hourly reply check found no reply) · ${it.deal}` });
        drafted = !!r?.created; if (drafted) made++;
      } catch (e) { console.error('unanswered draft', it.deal, e.message); }
    }
    (drafted ? out.drafted : out.listed).push(`${it.deal} (${it.date}): ${it.text.slice(0, 140).replace(/\s+/g, ' ')}`);
    await stampReplyCheck(page, deal.id, key);
  }
  if (!dry && (out.sent.length || out.drafted.length || out.listed.length)) {
    const lines = [...out.sent.map((l) => `• ✅ ${l} (sent now, was missed)`), ...out.drafted.map((l) => `• ✍️ ${l}`), ...out.listed.map((l) => `• ⚠️ ${l} (no draft, please reply)`)];
    await discord(`📭 **Brand emails nobody answered (1+ hour)**${out.drafted.length ? `\n${out.drafted.length} reply draft${out.drafted.length > 1 ? 's are' : ' is'} waiting in Approvals.` : ''}\n${lines.join('\n')}`.slice(0, 1950), 'pm').catch(() => {});
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
