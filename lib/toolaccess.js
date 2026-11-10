// Tool access hand-off (Harsh, Nov 10). After the script is approved the PM asks the brand for access to their tool on
// noocaptools@gmail.com. Brands answer with steps for us ("share your CapCut UID, register on Dreamina and send that
// UID too"), and before this those steps sat in the inbox until Harsh passed them on by hand.
//   1. The brand's reply goes on the video card as "🔑 Tool access from <brand>" and to the card's editor in their
//      Discord channel (#<name>-editor). No editor on the card yet: the PM channel, so the brand isn't left waiting.
//   2. Whatever the brand needs back (UIDs, the account email) the editor types into the card's "For the brand" field.
//      The heartbeat emails it to the brand in the deal's thread and clears the field.
import { notion, plain } from './notion.js';
import { BOARDS } from './tools.js';

export const FOR_BRAND = 'For the brand';
const OUTBOX_DS = '12116e41-602e-431f-9907-3154545889ab';
const API = 'https://discord.com/api/v10';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const idOf = (u) => (String(u || '').match(/[0-9a-f]{32}/i) || [])[0] || null;
const today = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

// The brand's email is about getting into their tool: an invite, a login, a UID, credits, a code
export function isAccessReply(text) {
  const t = String(text || '');
  return /\b(uid|user ?id|access|invite[ds]?|invitation|log ?in|sign ?up|register(ed)?|account|credits?|coupon|promo code|redeem|activat(e|ed|ion)|upgrad(e|ed)|pro plan|workspace|seat|whitelist(ed)?|onboard(ing)?)\b/i.test(t);
}

// Lines safe for an editor: no money, no invoices (editors and creator boards never see money)
export function editorSafe(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/[$€£₹]|\b(usd|eur|inr|rate|fee|invoice|payment|paid|pay(out)?|budget|price)\b/i.test(l))
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''));
}

// Did we ask this deal's brand for tool access (sent, not just drafted)?
export async function accessAsked(dealId) {
  if (!dealId) return false;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: dealId } }, { property: 'Kind', select: { equals: 'Tool access' } }, { property: 'Status', select: { equals: 'Sent' } }] } }).catch(() => ({ results: [] }));
  return (r.results || []).length > 0;
}

async function discordApi(method, path, body) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bot ${String(process.env.DISCORD_BOT_TOKEN || '').trim()}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Discord ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// "#prabal-editor" for PRABAL; null when there is no such channel or no bot
async function editorChannel(editor) {
  if (!editor || !process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) return null;
  const chans = await discordApi('GET', `/guilds/${process.env.DISCORD_GUILD_ID}/channels`).catch(() => []);
  return (chans || []).find((c) => c.type === 0 && norm(c.name) === norm(editor) + 'editor')?.id || null;
}
// EDITOR_DISCORD_IDS="Prateek:123" wins; otherwise the person in the editor's channel whose Discord name matches
async function editorMention(editor, channel) {
  const name = norm(editor);
  const map = Object.fromEntries(String(process.env.EDITOR_DISCORD_IDS || '').split(',').map((x) => x.split(':').map((y) => y.trim())).filter(([n, id]) => n && /^\d{15,}$/.test(id || '')).map(([n, id]) => [norm(n), id]));
  if (map[name]) return map[name];
  const msgs = await discordApi('GET', `/channels/${channel}/messages?limit=100`).catch(() => []);
  const hit = (Array.isArray(msgs) ? msgs : []).map((m) => m.author || {}).find((a) => !a.bot && [a.global_name, a.username].some((n) => norm(n) && (norm(n).includes(name) || name.includes(norm(n)))));
  return hit?.id || null;
}

// Ensure every board has the "For the brand" field (rich text)
let ensured = false;
export async function ensureForBrandField() {
  if (ensured) return;
  for (const b of BOARDS) {
    try { const ds = await notion('GET', `/data_sources/${b.ds}`); if (!ds.properties?.[FOR_BRAND]) await notion('PATCH', `/data_sources/${b.ds}`, { properties: { [FOR_BRAND]: { rich_text: {} } } }); } catch { /* that board only */ }
  }
  ensured = true;
}

export function editorMessage({ brand, creator, title, cardUrl, lines, at }) {
  return [
    `🔑 ${at ? `<@${at}> ` : ''}**Tool access from ${brand}** for "${title || `${brand} × ${creator}`}"`,
    `The brand replied about access on noocaptools@gmail.com:`,
    ...lines.slice(0, 25).map((l) => '> ' + l),
    `If they need something back (a UID, the account email), type it in **${FOR_BRAND}** on the card and the PM emails it to ${brand}.`,
    cardUrl ? `→ <${cardUrl}>` : '',
  ].filter(Boolean).join('\n');
}

// A brand email on a deal where we asked for access: onto the card, and to whoever edits it
export async function routeAccessReply({ deal, email, latest, discord }) {
  if (!deal?.linkedVideo || !(await accessAsked(deal.id))) return null;
  if (!isAccessReply(latest)) return null;
  const lines = editorSafe(latest).filter((l) => !/^(best|thanks|regards|cheers)[,!.]?$/i.test(l)).slice(0, 40);
  if (!lines.length) return null;
  const cardId = idOf(deal.linkedVideo);
  await ensureForBrandField();
  const card = await notion('GET', `/pages/${cardId}`);
  const title = plain(card.properties?.['Video Title']) || Object.values(card.properties || {}).map((p) => (p.type === 'title' ? plain(p) : '')).find(Boolean) || '';
  const editor = plain(card.properties?.EDITOR) || '';
  // Once per brand email: the same reply can arrive twice (catch-up sweeps)
  const label = `🔑 Tool access from ${deal.brand} ${today()}`;
  const kids = (await notion('GET', `/blocks/${cardId}/children?page_size=100`).catch(() => ({ results: [] }))).results || [];
  const sig = lines.join(' ').slice(0, 120);
  for (const b of kids) {
    if (b.type !== 'toggle' || !/^🔑 Tool access from/.test((b.toggle.rich_text || []).map((x) => x.plain_text).join(''))) continue;
    const inner = (await notion('GET', `/blocks/${b.id}/children?page_size=100`).catch(() => ({ results: [] }))).results || [];
    if (inner.map((x) => (x[x.type]?.rich_text || []).map((r) => r.plain_text).join('')).join(' ').slice(0, 120) === sig) return { duplicate: true };
  }
  const items = [...lines, `Need to send something back? Type it in "${FOR_BRAND}" on this card and the PM emails it to ${deal.brand}.`];
  await notion('PATCH', `/blocks/${cardId}/children`, { children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: label } }], children: items.map((l) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: String(l).slice(0, 1900) } }] } })) } }] });
  const cardUrl = card.url || deal.linkedVideo;
  const ch = await editorChannel(editor).catch(() => null);
  if (ch) {
    const at = await editorMention(editor, ch).catch(() => null);
    // The video's own thread in that channel ("🎬 CapCut × Chris") when there is one, so everything for it is together
    let target = ch;
    try {
      const { threads = [] } = await discordApi('GET', `/guilds/${process.env.DISCORD_GUILD_ID}/threads/active`);
      const want = norm(title).slice(0, 40);
      const th = want && threads.filter((t) => t.parent_id === ch).find((t) => norm(t.name).includes(want) && !/^changes/i.test(norm(t.name)));
      if (th) target = th.id;
    } catch { /* the channel itself */ }
    await discordApi('POST', `/channels/${target}/messages`, { content: editorMessage({ brand: deal.brand, creator: deal.creator, title, cardUrl, lines, at }).slice(0, 1990), allowed_mentions: at ? { users: [at] } : { parse: [] } });
    return { to: `${editor}${target !== ch ? ' (video thread)' : ''}`, card: cardUrl };
  }
  // No editor (or no channel for them) yet: the team channel, so it doesn't wait on someone setting the editor
  await discord(editorMessage({ brand: deal.brand, creator: deal.creator, title, cardUrl, lines }) + `\n_No editor on the card yet: set one, or whoever records the demo handles it._`, 'pm', { now: true });
  return { to: 'PM channel (no editor on the card)', card: cardUrl };
}

// Heartbeat: what editors typed in "For the brand" goes to the brand in the deal's thread, then the field is cleared
export async function sendForTheBrand(deals, { createDraft }) {
  await ensureForBrandField();
  const out = [];
  for (const b of BOARDS) {
    const r = await notion('POST', `/data_sources/${b.ds}/query`, { page_size: 20, filter: { property: FOR_BRAND, rich_text: { is_not_empty: true } } }).catch(() => ({ results: [] }));
    for (const card of r.results || []) {
      const text = plain(card.properties?.[FOR_BRAND]).trim();
      if (!text) continue;
      const cid = card.id.replace(/-/g, '');
      const deal = deals.find((d) => idOf(d.linkedVideo) === cid);
      if (!deal || !deal.threadId || deal.channel === 'WhatsApp') continue; // no email thread to answer in: leave it for a person
      // The brand's first name from our access email ("Hi Mia,")
      const asked = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: { and: [{ property: 'Deal', relation: { contains: deal.id } }, { property: 'Kind', select: { equals: 'Tool access' } }] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] }).catch(() => ({ results: [] }));
      const first = String(plain(asked.results?.[0]?.properties?.Body) || '').match(/^Hi\s+([^,<\n]+)/i)?.[1]?.trim() || 'there';
      const body = `Hi ${first},\n\nHere are the details you asked for:\n\n${text}\n\nPlease let us know once it's set up.\n\nBest,\n${deal.creator || 'Our'}'s Team`.replace(/^Our's/m, 'Our');
      const d = await createDraft({ kind: 'Tool access', deal, subject: `Re: ${deal.threadSubject || ''}`.replace(/^Re:\s*Re:/i, 'Re:'), body, notify: false, sameAs: text.slice(0, 60), why: `The editor filled "${FOR_BRAND}" on the card: sending it to ${deal.brand}.` });
      if (!d) continue;
      await notion('PATCH', `/pages/${card.id}`, { properties: { [FOR_BRAND]: { rich_text: [] } } });
      await notion('PATCH', `/blocks/${card.id}/children`, { children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: `📤 Sent to ${deal.brand} ${today()}` } }], children: text.split('\n').filter(Boolean).slice(0, 20).map((l) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: l.slice(0, 1900) } }] } })) } }] }).catch(() => {});
      out.push(`${deal.brand} × ${deal.creator}`);
    }
  }
  return out;
}

// Hourly catch-up: brand replies that arrived after our access email but weren't handed over (an email older than
// 36 hours only gets recorded, as with CapCut × Chris on Nov 9). Reads the deal's conversation record; the card note
// check stops the same reply going out twice.
export async function catchUpAccess(deals, { discord }) {
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 50, filter: { and: [{ property: 'Kind', select: { equals: 'Tool access' } }, { property: 'Status', select: { equals: 'Sent' } }, { property: 'Sent At', date: { past_week: {} } }] } }).catch(() => ({ results: [] }));
  const { pageLines } = await import('./memory.js');
  const out = [];
  const seen = new Set();
  for (const row of r.results || []) {
    const dealId = row.properties?.Deal?.relation?.[0]?.id;
    const sentAt = row.properties?.['Sent At']?.date?.start;
    if (!dealId || !sentAt || seen.has(dealId)) continue;
    seen.add(dealId);
    const deal = deals.find((d) => d.id.replace(/-/g, '') === dealId.replace(/-/g, ''));
    if (!deal?.linkedVideo || !deal.lastBrand || Date.parse(deal.lastBrand) <= Date.parse(sentAt)) continue;
    const lines = await pageLines(deal.id).catch(() => []);
    const sentDay = String(sentAt).slice(0, 10);
    for (const l of lines) {
      const m = l.match(/^📨\s*(\d{4}-\d{2}-\d{2})\s*·\s*brand[^\n]*\n([\s\S]*)$/);
      if (!m || m[1] < sentDay) continue;
      const res = await routeAccessReply({ deal, email: {}, latest: m[2], discord }).catch((e) => ({ error: e.message }));
      if (res && !res.duplicate && !res.error) out.push(`${deal.brand} × ${deal.creator} → ${res.to}`);
    }
  }
  return out;
}
