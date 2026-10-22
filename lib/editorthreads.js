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


// The editor's Discord id, so the post tags them. EDITOR_DISCORD_IDS="Prateek:123,Sumith:456" in Vercel wins;
// otherwise it's the person in the thread (or the editor's channel) whose Discord name matches the editor on the row.
async function editorMention(editor, threadId) {
  const name = norm(editor);
  if (!name) return '';
  const map = Object.fromEntries(String(process.env.EDITOR_DISCORD_IDS || '').split(',').map((x) => x.split(':').map((y) => y.trim())).filter(([n, id]) => n && /^\d{15,}$/.test(id || '')).map(([n, id]) => [norm(n), id]));
  if (map[name]) return `<@${map[name]}>`;
  const look = async (ch) => {
    const msgs = await discordApi('GET', `/channels/${ch}/messages?limit=100`).catch(() => []);
    const hit = (Array.isArray(msgs) ? msgs : []).map((m) => m.author || {}).find((a) => !a.bot && [a.global_name, a.username].some((n) => norm(n).includes(name) || (norm(n) && name.includes(norm(n)))));
    return hit ? hit.id : null;
  };
  let id = await look(threadId);
  if (!id) { const t = await discordApi('GET', `/channels/${threadId}`).catch(() => null); if (t?.parent_id) id = await look(t.parent_id); }
  return id ? `<@${id}>` : '';
}

// Image blocks under the newest "Brand feedback · round N" heading on the Video Intake page
async function roundImages(pageId, round) {
  const r = await notion('GET', `/blocks/${pageId}/children?page_size=100`);
  const blocks = r.results || [];
  let start = -1;
  blocks.forEach((b, i) => { const t = (b.heading_3?.rich_text || []).map((x) => x.plain_text).join(''); if (b.type === 'heading_3' && t.startsWith(`Brand feedback · round ${round} `)) start = i; });
  if (start < 0) return [];
  const out = [];
  for (const b of blocks.slice(start + 1)) {
    if (b.type === 'heading_3') break;
    if (b.type !== 'image') continue;
    const url = b.image?.file?.url || b.image?.external?.url;
    if (url) out.push(url);
  }
  return out.slice(0, 6);
}

// Upload images to a Discord channel/thread as attachments (Notion's file links expire, Discord's copies don't)
async function postImages(channel, urls, content) {
  const form = new FormData();
  const files = [];
  for (const [i, u] of urls.entries()) {
    const res = await fetch(u);
    if (!res.ok) continue;
    const type = res.headers.get('content-type') || 'image/png';
    const ext = (type.split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg');
    form.append(`files[${files.length}]`, new Blob([Buffer.from(await res.arrayBuffer())], { type }), `brand-screenshot-${i + 1}.${ext}`);
    files.push(i);
  }
  if (!files.length) return;
  form.append('payload_json', JSON.stringify({ content, allowed_mentions: { parse: [] } }));
  const res = await fetch(`${API}/channels/${channel}/messages`, { method: 'POST', headers: { authorization: `Bot ${String(process.env.DISCORD_BOT_TOKEN || '').trim()}` }, body: form });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    if (!title) continue;
    const editor = plain(p.properties?.Editor);
    // Where to post: the editor bot's open "Changes — <title>" thread; after 20 minutes without one, the thread saved
    // on the row; and if the PM can't post there (no access) or there's none, a new "Changes — <title>" thread the
    // PM opens itself in the editor's channel. One video failing never stops the others.
    const tries = t?.id ? [t.id] : waited ? [/^\d{15,}$/.test(String(saved || '')) ? String(saved) : null, 'new'].filter(Boolean) : [];
    if (!tries.length) continue; // the editor bot may still open its thread: try again next run
    let posted = false, lastErr = null;
    for (const option of tries) {
      try {
        const target = option === 'new' ? await openChangesThread(editor, title) : option;
        if (!target) continue;
        const at = await editorMention(editor, target).catch(() => '');
        const parts = chunks(`${at ? at + ' ' : ''}📝 **Brand changes · round ${round}**\n${feedback}`);
        for (const [i, c] of parts.entries()) await discordApi('POST', `/channels/${target}/messages`, { content: c, allowed_mentions: i === 0 && at ? { users: [at.replace(/\D/g, '')] } : { parse: [] } });
        // The brand's screenshots for this round, as real image files in the thread
        const pics = await roundImages(p.id, round).catch(() => []);
        if (pics.length) await postImages(target, pics, `🖼️ The brand's screenshots (${pics.length})`).catch((e) => console.error('Feedback images', e.message));
        await notion('PATCH', `/pages/${p.id}`, { properties: { 'Feedback Posted': { checkbox: true }, ...(option === 'new' ? { 'Changes Thread ID': { rich_text: [{ type: 'text', text: { content: target } }] } } : {}) } });
        posted = true;
        break;
      } catch (e) { lastErr = e; }
    }
    if (posted) done.push(title);
    else if (lastErr) console.error(`Editor thread for ${title}:`, lastErr.message);
  }
  return done;
}

// Images from a brand email the PM had already handled without them (they arrived before n8n passed images on):
// post them into the editor's "Changes — <title>" thread for that row
export async function postLateImages(rowId, urls, note) {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID || !urls.length) return false;
  const p = await notion('GET', `/pages/${rowId}`);
  const title = plain(p.properties?.['Video Title']) || '';
  const { threads = [] } = await discordApi('GET', `/guilds/${process.env.DISCORD_GUILD_ID}/threads/active`);
  const t = threads.filter((x) => /^changes/i.test(x.name || '') && norm(x.name).replace(/^changes/, '') === norm(title)).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))[0];
  const saved = plain(p.properties?.['Changes Thread ID']) || plain(p.properties?.['Discord Thread ID']);
  const target = t?.id || (/^\d{15,}$/.test(String(saved || '')) ? String(saved) : null);
  if (!target) return false;
  await postImages(target, urls, note);
  return true;
}

// The editor's own channel ("#abhishek-editor", "#prateek-editor"): a new "Changes — <title>" thread there
async function openChangesThread(editor, title) {
  if (!editor || !process.env.DISCORD_GUILD_ID) return null;
  const chans = await discordApi('GET', `/guilds/${process.env.DISCORD_GUILD_ID}/channels`);
  const want = norm(editor) + 'editor';
  const ch = (chans || []).find((c) => c.type === 0 && norm(c.name) === want);
  if (!ch) return null;
  const th = await discordApi('POST', `/channels/${ch.id}/threads`, { name: `Changes — ${title}`.slice(0, 100), type: 11, auto_archive_duration: 10080 });
  return th?.id || null;
}
