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

// Only the steps: no quoted earlier email, no signature (the rep's name, title, agency, email), no addresses, and the
// email's hard line wraps joined back into sentences (Harsh, Nov 10: "just the instructions")
export function instructionsOnly(text) {
  let t = String(text || '').replace(/\r/g, '');
  // the earlier email quoted underneath ("On Mon, Nov 9, 2026 at 10:27 PM noocap collab <…> wrote:")
  t = t.split(/\n\s*On [^\n]{0,200}?(?:\n[^\n]{0,200}?){0,3}wrote:\s*(?:\n|$)|\n-{2,}\s*Original Message|\n\s*From:\s/i)[0];
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  let lines = t.split('\n').map((l) => l.trim());
  // the signature: from the sign-off or the first "Name | Title" / email line to the end
  const sig = lines.findIndex((l) => /^(best|thanks|thank you|regards|kind regards|best regards|warm(ly| regards)|cheers|sincerely)[,!.]?$/i.test(l) || /\S\s\|\s\S/.test(l) || /[\w.+-]+@[\w-]+\.[\w.]+/.test(l) && l.split(/\s+/).length <= 3);
  if (sig > 0) lines = lines.slice(0, sig);
  lines = lines.filter((l) => !/[\w.+-]+@[\w-]+\.[\w.]+/.test(l) || /noocaptools@/i.test(l));
  // join wrapped lines: a line that doesn't end a sentence continues on the next unless that one starts a new item
  const out = [];
  for (const l of lines) {
    if (!l) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    const prev = out[out.length - 1];
    const newItem = /^(\d+[.)]|[-•*]|step\b)/i.test(l);
    if (prev && !newItem && !/[.:!?)]$/.test(prev)) out[out.length - 1] = `${prev} ${l}`;
    else out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.filter((l) => l !== '' ).filter((l) => !/^(hi|hello|hey|dear)\b[^.!?]{0,40}[,!]?$/i.test(l));
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
    `🔑 ${at ? `<@${at}> ` : ''}**${lines.length === 1 && /access is now on/.test(lines[0]) ? 'Tool access granted' : 'Tool access steps'}** for "${title || creator || 'this video'}"`,
    `For the demo account noocaptools@gmail.com:`,
    ...lines.slice(0, 25).map((l) => '> ' + l),
    `If they need something back (a UID, the account email), type it in **${FOR_BRAND}** on the card and the PM sends it on.`,
    cardUrl ? `→ <${cardUrl}>` : '',
  ].filter(Boolean).join('\n');
}

// Which sentences are about the tool account, and whether there is anything to DO (Nov 11: Yulia's "access has been
// granted ... the video link gives a 404, please resend" went to the editor whole, and the PM stopped answering her)
const ACCESS_RE = /\b(uid|user ?id|access|log ?in|login|sign ?up|register|account|invite|invitation|redeem|coupon|promo code|code|credits?|activat\w*|upgrad\w*|pro plan|workspace|seat|whitelist\w*|enabled?|download|install|profile|avatar|click|copy|website|dashboard)\b/i;
const TODO_RE = /\b(uid|user ?id|register|sign ?up|download|install|log ?in|login|invite link|invitation link|redeem|coupon|promo code|code|click|copy|share your|send (us|me|over)|create an? account|accept the invit\w*|verify)\b/i;
const GRANTED_RE = /\b(access|account)\b[^.!?]{0,60}\b(granted|enabled|activated|upgraded|added|given|live|ready)\b|\b(granted|enabled|activated|upgraded)\b[^.!?]{0,40}\b(access|account)\b/i;
export function accessPart(lines) {
  const sentences = [];
  for (const l of lines) {
    if (/^(\d+[.)]|[-•*])\s/.test(l) || /:$/.test(l)) sentences.push(l);
    else sentences.push(...(l.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [l]).map((x) => x.trim()).filter(Boolean));
  }
  const keep = sentences.filter((x) => ACCESS_RE.test(x) || /^(\d+[.)]|[-•*])\s/.test(x));
  const other = sentences.filter((x) => !keep.includes(x) && !/^(thanks?|thank you|apologies|sorry|hope|looking forward|great|perfect|okay|ok)\b/i.test(x));
  const todo = keep.some((x) => TODO_RE.test(x));
  const granted = !todo && keep.some((x) => GRANTED_RE.test(x));
  return { steps: todo ? keep : [], granted, other };
}
const shortHash = (t) => { let h = 0; for (const c of String(t).replace(/\s+/g, ' ').trim().slice(0, 600)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36); };

// A brand email on a deal where we asked for access: onto the card, and to whoever edits it
export async function routeAccessReply({ deal, email, latest, discord, emailDate }) {
  if (!deal?.linkedVideo || !(await accessAsked(deal.id))) return null;
  if (!isAccessReply(latest)) return null;
  const part = accessPart(editorSafe(instructionsOnly(latest).join('\n')));
  // only the account part goes to the editor; anything else in the email (a broken link, a question) is the PM's to answer
  const answerToo = part.other.length > 0;
  if (!part.steps.length && !part.granted) return null;
  const lines = part.steps.length ? part.steps.slice(0, 40) : ['The brand says access is now on noocaptools@gmail.com. Log in and check it works before recording.'];
  const ref = shortHash(latest);
  const cardId = idOf(deal.linkedVideo);
  await ensureForBrandField();
  const card = await notion('GET', `/pages/${cardId}`);
  const title = plain(card.properties?.['Video Title']) || Object.values(card.properties || {}).map((p) => (p.type === 'title' ? plain(p) : '')).find(Boolean) || '';
  const editor = plain(card.properties?.EDITOR) || '';
  // Once per brand email: the same reply can arrive twice (catch-up sweeps)
  const label = `🔑 Tool access ${part.steps.length ? 'steps' : 'granted'} ${today()} · ref ${ref}`;
  const kids = (await notion('GET', `/blocks/${cardId}/children?page_size=100`).catch(() => ({ results: [] }))).results || [];
  const sig = lines.join(' ').slice(0, 120);
  for (const b of kids) {
    const head = (b.toggle?.rich_text || []).map((x) => x.plain_text).join('');
    if (b.type !== 'toggle' || !/^🔑 Tool access/.test(head)) continue;
    if (head.includes(`ref ${ref}`)) return { duplicate: true, answerToo };
    // a note made after this email arrived already covers it (posts made before the ref existed, Nov 10)
    const when = Date.parse(emailDate || email?.date || '');
    if (Number.isFinite(when) && Date.parse(b.created_time) >= when) return { duplicate: true, answerToo };
    const inner = (await notion('GET', `/blocks/${b.id}/children?page_size=100`).catch(() => ({ results: [] }))).results || [];
    if (inner.map((x) => (x[x.type]?.rich_text || []).map((r) => r.plain_text).join('')).join(' ').slice(0, 120) === sig) return { duplicate: true, answerToo };
  }
  const items = [...lines, `Need to send something back? Type it in "${FOR_BRAND}" on this card and the PM sends it on.`];
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
    return { to: `${editor}${target !== ch ? ' (video thread)' : ''}`, card: cardUrl, answerToo };
  }
  // No editor (or no channel for them) yet: the team channel, so it doesn't wait on someone setting the editor
  await discord(editorMessage({ brand: deal.brand, creator: deal.creator, title, cardUrl, lines }) + `\n_No editor on the card yet: set one, or whoever records the demo handles it._`, 'pm', { now: true });
  return { to: 'PM channel (no editor on the card)', card: cardUrl, answerToo };
}

// Heartbeat: what editors typed in "For the brand" goes to the brand in the deal's thread, then the field is cleared
export async function sendForTheBrand(deals, { createDraft }) {
  await ensureForBrandField();
  const out = [];
  for (const b of BOARDS) {
    const r = await notion('POST', `/data_sources/${b.ds}/query`, { page_size: 20, filter: { property: FOR_BRAND, rich_text: { is_not_empty: true } } }).catch(() => ({ results: [] }));
    for (const card of r.results || []) {
      const text = String(plain(card.properties?.[FOR_BRAND]) || '').trim();
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
      const res = await routeAccessReply({ deal, email: {}, latest: m[2], discord, emailDate: `${m[1]}T00:00:00+05:30` }).catch((e) => ({ error: e.message }));
      if (res && !res.duplicate && !res.error) out.push(`${deal.brand} × ${deal.creator} → ${res.to}`);
    }
  }
  return out;
}

// Editors answer where they read the steps: in the Discord thread (Prateek posted the CapCut and Dreamina UIDs there,
// Nov 10, and nothing reached the brand). Every 15 minutes the PM reads replies under its own "🔑 Tool access steps"
// posts in the editor channels and their threads, and puts them in the card's "For the brand" field, which the sender
// below emails on. It waits until the editor has been quiet for 10 minutes so a reply typed in two messages goes as one.
// What an editor typed under a tool-access post, as the text the brand gets.
// A later message that repeats an earlier one replaces it ("7676…" then "CapCut ID: … Dreamina UID: 7676…").
// System check Nov 11: an editor's "ok" / "done" / "thanks" under a post is chat, never details for the brand,
// so a reply made only of acknowledgements gives no text (it would have gone out as "Here are the details you asked for: ok").
const ACK = /^(ok(ay)?|k|done|thanks?|thank you|ty|noted|got it|sure|yes|on it|will do|cool|great|👍|✅)[\s.!🙏👍]*$/i;
export function editorReplyText(lines) {
  const said = (lines || []).map((t) => String(t || '').trim()).filter((t) => t && !ACK.test(t));
  return said.filter((t, i, a) => !a.slice(i + 1).some((later) => later.includes(t))).join('\n').slice(0, 1800);
}

export async function pickUpEditorReplies() {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) return [];
  const g = process.env.DISCORD_GUILD_ID;
  const chans = (await discordApi('GET', `/guilds/${g}/channels`).catch(() => [])).filter((c) => c.type === 0 && /-editor$/.test(c.name));
  const { threads = [] } = await discordApi('GET', `/guilds/${g}/threads/active`).catch(() => ({}));
  const where = [...chans.map((c) => c.id), ...threads.filter((t) => chans.some((c) => c.id === t.parent_id)).map((t) => t.id)];
  const out = [];
  for (const ch of where) {
    const msgs = await discordApi('GET', `/channels/${ch}/messages?limit=30`).catch(() => []);
    if (!Array.isArray(msgs) || !msgs.length) continue;
    const list = [...msgs].reverse(); // oldest first
    const at = list.map((m, i) => (m.author?.bot && /🔑[\s\S]*Tool access (steps|granted)/.test(m.content || '') ? i : -1)).filter((i) => i >= 0).pop();
    if (at === undefined) continue;
    const after = list.slice(at + 1);
    if (after.some((m) => m.author?.bot && /^📤/.test(m.content || ''))) continue; // already picked up
    const said = after.filter((m) => !m.author?.bot).map((m) => ({ t: String(m.content || '').replace(/<@!?\d+>/g, '').trim(), at: Date.parse(m.timestamp) })).filter((m) => m.t);
    if (!said.length || Date.now() - said[said.length - 1].at < 10 * 60e3) continue;
    const text = editorReplyText(said.map((m) => m.t));
    const cardId = idOf(list[at].content);
    if (!cardId || !text) continue;
    const card = await notion('GET', `/pages/${cardId}`).catch(() => null);
    if (!card) continue;
    // already sent from the card after the post (someone used the field): just acknowledge, never send twice
    const kids = (await notion('GET', `/blocks/${cardId}/children?page_size=100`).catch(() => ({ results: [] }))).results || [];
    const sentSince = kids.some((b) => b.type === 'toggle' && /^📤 Sent to/.test((b.toggle.rich_text || []).map((x) => x.plain_text).join('')) && Date.parse(b.created_time) >= Date.parse(list[at].timestamp));
    if (sentSince) { await discordApi('POST', `/channels/${ch}/messages`, { content: '📤 Already sent to the brand from the card.', allowed_mentions: { parse: [] } }).catch(() => {}); continue; }
    if (!String(plain(card.properties?.[FOR_BRAND]) || '').trim()) await notion('PATCH', `/pages/${cardId}`, { properties: { [FOR_BRAND]: { rich_text: [{ type: 'text', text: { content: text } }] } } });
    await discordApi('POST', `/channels/${ch}/messages`, { content: `📤 Got it. This goes to the brand in the next few minutes:\n> ${text.split('\n').join('\n> ')}`, allowed_mentions: { parse: [] } }).catch(() => {});
    out.push(plain(card.properties?.['Video Title']) || cardId);
  }
  return out;
}
