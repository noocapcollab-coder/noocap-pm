// Brand changes on a video, posted into the editor's Discord thread.
// The editor bot (NOOCAP CHANGES) opens a thread "Changes — <video title>" in the editor's channel when Video Intake
// goes to Changes, but it only posts the card details. The PM writes the brand's changes into the row's "Brand Feedback"
// field; this step finds that thread and posts the changes there, so nobody has to paste them by hand.
// Needs DISCORD_BOT_TOKEN (a bot in the server that can see the editor channels) and DISCORD_GUILD_ID in Vercel.
import { notion, plain } from './notion.js';
import { DS } from './tools.js';

const API = 'https://discord.com/api/v10';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function discordApi(method, path, body) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bot ${String(process.env.DISCORD_BOT_TOKEN || '').trim()}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Discord ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Split long feedback into Discord-sized messages (2,000 characters), on line breaks where possible
export function chunks(text, max = 1900) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export async function postFeedbackToThreads() {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) return [];
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const r = await notion('POST', `/data_sources/${DS.intake}/query`, {
    page_size: 20,
    filter: { and: [{ property: 'Status', select: { equals: 'Changes' } }, { property: 'Feedback Posted', checkbox: { equals: false } }, { property: 'Brand Feedback', rich_text: { is_not_empty: true } }, { property: 'Changes Requested At', date: { after: since } }] },
  }).catch(() => ({ results: [] }));
  const rows = r.results || [];
  if (!rows.length) return [];
  const { threads = [] } = await discordApi('GET', `/guilds/${process.env.DISCORD_GUILD_ID}/threads/active`);
  const done = [];
  for (const p of rows) {
    const title = plain(p.properties?.['Video Title']) || '';
    const feedback = (p.properties?.['Brand Feedback']?.rich_text || []).map((t) => t.plain_text).join('');
    const round = Number(plain(p.properties?.Revisions) || 0) || 1;
    // The newest "Changes — <title>" thread (thread ids grow over time)
    const t = threads.filter((x) => /^changes/i.test(x.name || '') && norm(x.name).replace(/^changes/, '') === norm(title)).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))[0];
    // No open thread by that name: the thread the editor bot saved on the row (an older, archived "Changes" thread
    // reopens when a message is posted in it), once the bot has had 20 minutes to open a new one
    const saved = plain(p.properties?.['Changes Thread ID']) || plain(p.properties?.['Discord Thread ID']);
    const waited = Date.now() - Date.parse(plain(p.properties?.['Changes Requested At']) || 0) > 20 * 60e3;
    const target = t?.id || (waited && /^\d{15,}$/.test(String(saved || '')) ? String(saved) : null);
    if (!target || !title) continue; // the editor bot hasn't opened it yet: try again next run
    const parts = chunks(`📝 **Brand changes · round ${round}**\n${feedback}`);
    for (const c of parts) await discordApi('POST', `/channels/${target}/messages`, { content: c, allowed_mentions: { parse: [] } });
    await notion('PATCH', `/pages/${p.id}`, { properties: { 'Feedback Posted': { checkbox: true } } });
    done.push(title);
  }
  return done;
}
