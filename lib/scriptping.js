// "Send to Script Writer" on every creator board card (Harsh, Nov 13): pick Script changes, Brief changed or Concept
// changed on the card and the PM does the rest within 10 minutes. It reads the brand's latest emails on the deal,
// writes what changed as a short list for Rudraksh (no money, the brand's own words for anything specific), pings him on
// Discord with the card link, adds the notes to the card, moves the card back to 4- Script Draft and sets the field to
// "Sent ✓" so it never goes twice. No copying or pasting from the emails, and nothing is sent to the brand.
import { notion, plain, queryAll } from './notion.js';
import { BOARDS } from './tools.js';

export const PING_PROP = 'Send to Script Writer';
export const KINDS = { 'Script changes': 'script changes', 'Brief changed': 'a changed brief', 'Concept changed': 'a changed concept' };
const idOf = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The deal behind a card: linked by the card URL, else the brand named in the title and the same creator
export function dealForCard(deals, card) {
  const id = idOf(card.url);
  const linked = deals.find((d) => idOf(d.linkedVideo) === id);
  if (linked) return linked;
  const t = norm(card.title);
  return deals.filter((d) => norm(d.brand).length >= 3 && t.includes(norm(d.brand).slice(0, 8)) && (!d.creator || norm(d.creator).slice(0, 5) === norm(card.creator).slice(0, 5)))[0] || null;
}

const NOTES_TOOL = {
  name: 'notes',
  description: 'What the script writer must change',
  input_schema: { type: 'object', properties: { points: { type: 'array', items: { type: 'string' }, description: 'One change per item, short, in the brand\'s words for anything specific (lines, product names, links, dates). Empty when the emails hold no change of this kind.' } }, required: ['points'] },
};

// Turn the newest brand emails into the change list. Pure input → model call; the caller handles empty answers.
async function changesFrom(convo, kind, card) {
  const { claude, HAIKU } = await import('./claude.js');
  const out = await claude({
    _job: 'script-ping', model: HAIKU, max_tokens: 900,
    system: `You brief NOOCAP's script writer. Harsh says the brand sent ${KINDS[kind]} for the video "${card.title}". From the deal's email conversation (oldest first, newest last), list exactly what the brand now wants changed in the script, brief or concept, taking the NEWEST brand message as the truth. Keep their exact words for lines, hooks, product names, features, links and dates. Never mention money, rates, fees or payment terms. Leave out greetings, scheduling and anything already done.`,
    tools: [NOTES_TOOL], tool_choice: { type: 'tool', name: 'notes' },
    messages: [{ role: 'user', content: String(convo).slice(-9000) || '(no emails on this deal)' }],
  });
  const v = (out.content || []).find((b) => b.type === 'tool_use')?.input || {};
  return (v.points || []).map((p) => String(p).trim()).filter(Boolean).slice(0, 12);
}

async function markSent(card, note) {
  await notion('PATCH', `/pages/${card.id}`, { properties: { [PING_PROP]: { select: { name: note } } } }).catch(() => {});
}

// Heartbeat step: every card on every board with a kind picked, handled once
export async function runScriptPings(deals) {
  const done = [];
  for (const b of BOARDS) {
    let rows = [];
    try { rows = await queryAll(b.ds, { or: Object.keys(KINDS).map((k) => ({ property: PING_PROP, select: { equals: k } })) }, { useCache: false }); } catch { continue; } // board without the field
    for (const p of rows) {
      // Boards name their columns differently ("Video Title", "VIDEO", "Video"; "Brief", "BRAND BRIEF", "BREIF")
      const props = Object.entries(p.properties || {});
      const titleProp = props.find(([, v]) => v?.type === 'title')?.[1];
      const briefProp = props.find(([k, v]) => /bri?e?i?f/i.test(k) && v?.type === 'url' && v.url)?.[1];
      const card = { id: p.id, url: p.url, title: plain(titleProp) || 'video', creator: b.creator, brief: briefProp?.url || '' };
      const kind = plain(p.properties?.[PING_PROP]);
      // Picked it up first, so a slow run or a retry can't send it twice
      await markSent(card, 'Sending…');
      try {
        const deal = dealForCard(deals, card);
        const { readTranscript } = await import('./memory.js');
        const convo = deal?.id ? await readTranscript(deal.id, 12000).catch(() => '') : '';
        const points = convo ? await changesFrom(convo, kind, card).catch(() => []) : [];
        const { forScriptWriter } = await import('./briefs.js');
        const lines = [
          `${kind} (flagged by Harsh):`,
          ...(points.length ? points.map((x, i) => `${i + 1}. ${x}`) : ['The brand\'s latest email has the details: check the card and the brief.']),
          ...(kind !== 'Script changes' && card.brief ? [`Brief: ${card.brief}`] : []),
        ];
        const { resendScriptChanges } = await import('./inbox.js');
        const r = await resendScriptChanges({ brand: deal?.brand || card.title.split(/\s*[×x]\s*/)[0], creator: deal?.creator || b.creator, feedback: forScriptWriter(lines.join('\n')), title: kind === 'Script changes' ? 'Script changes requested' : kind === 'Brief changed' ? 'Brief changed' : 'Concept changed' });
        await markSent(card, 'Sent ✓');
        done.push(`${r.deal}: ${kind}${points.length ? ` (${points.length} points)` : ''}`);
      } catch (e) {
        await markSent(card, 'Failed');
        const { discord } = await import('./briefs.js');
        await discord(`⚠️ **${card.title}** · couldn't send the ${KINDS[kind]} to Rudraksh: ${String(e.message).slice(0, 200)}. Pick it again on the card once fixed.`, 'pm').catch(() => {});
      }
    }
  }
  return done;
}
