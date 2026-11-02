// New sponsor videos on a creator's board (added by the team in Notion, e.g. a WhatsApp deal) -> tell the script
// writer once, in his Discord channel. Email deals already get this ping from the brief catcher; those are skipped
// because their card link is already in the Agent Log. No prices ever go to the scripts channel.
import { notion, queryAll } from './notion.js';
import { BOARDS, DS, readVideo } from './tools.js';
import { discord, tag, log } from './briefs.js';

const NEW_DAYS = 5;
const bare = (id) => String(id || '').replace(/-/g, '');
// Needs a script: idea assigned through script draft
export const needsScript = (v) => v.sponsor && [1, 2, 3, 4].includes(parseInt(v.status, 10));

async function pingedBefore(id) {
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { property: 'Details', rich_text: { contains: bare(id) } } }).catch(() => ({ results: [1] }));
  return (r.results || []).length > 0;
}

export async function pingNewSponsorScripts() {
  const since = new Date(Date.now() - NEW_DAYS * 864e5).toISOString();
  const found = [];
  await Promise.all(BOARDS.map(async (b) => {
    let pages = [];
    try { pages = await queryAll(b.ds, { timestamp: 'created_time', created_time: { on_or_after: since } }, { useCache: false }); } catch { return; }
    for (const p of pages) { const v = readVideo(p, b.creator); if (needsScript(v)) found.push(v); }
  }));
  const fresh = [];
  for (const v of found) if (!(await pingedBefore(v.id))) fresh.push(v);
  if (!fresh.length) return [];
  const byCreator = {};
  for (const v of fresh) (byCreator[v.creator] ||= []).push(v);
  for (const [creator, vids] of Object.entries(byCreator)) {
    const when = (d) => (d ? ` · goes live ${new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : '');
    const lines = vids.map((v) => `• **${v.title}**${when(v.post_date)} · ${v.status}\n  ${v.url}`).join('\n');
    const ok = await discord(`${tag()} 📝 **New sponsor ${vids.length === 1 ? 'video' : 'videos'} for ${creator}, please start the script${vids.length === 1 ? '' : 's'}**\n${lines}\nThe brief is inside the Notion page.`, 'scripts');
    if (ok) for (const v of vids) await log({ event: `Script ping: ${v.title} × ${creator}`, outcome: 'Alert', email: { messageId: '' }, details: `Rudraksh told about the new sponsor video. Card ${bare(v.id)} ${v.url}` }).catch(() => {});
  }
  return fresh.map((v) => `${v.title} × ${v.creator}`);
}
