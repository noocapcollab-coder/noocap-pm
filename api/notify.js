// POST /api/notify { cards: [Notion card links], note? } -> pings the script writer (Rudraksh's Discord channel, tagged)
// about sponsor videos on a creator's board that need a script. No prices ever go in (the scripts channel strips them).
import { checkAuth } from '../lib/auth.js';
import { notion, titleOf, plain } from '../lib/notion.js';
import { discord, tag } from '../lib/briefs.js';

const idOf = (u) => (String(u || '').replace(/-/g, '').match(/[0-9a-f]{32}/i) || [])[0];

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const ids = (b.cards || []).map(idOf).filter(Boolean).slice(0, 10);
    if (!ids.length) return res.status(400).json({ error: 'cards required' });
    const lines = [];
    for (const id of ids) {
      const p = await notion('GET', `/pages/${id}`);
      let post = null, status = '';
      for (const [n, v] of Object.entries(p.properties || {})) {
        if (v.type === 'date' && /post/i.test(n) && v.date?.start) post = v.date.start.slice(0, 10);
        if (n.toLowerCase() === 'status') status = plain(v) || '';
      }
      const when = post ? new Date(post + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : null;
      lines.push(`• **${titleOf(p)}**${when ? ` · goes live ${when}` : ''}${status ? ` · ${status}` : ''}\n  ${p.url}`);
    }
    const creator = String(b.creator || '').trim();
    const msg = `${tag()} 📝 **New sponsor ${ids.length === 1 ? 'video' : 'videos'}${creator ? ` for ${creator}` : ''}, please start the script${ids.length === 1 ? '' : 's'}**\n${lines.join('\n')}${b.note ? `\n${String(b.note).slice(0, 500)}` : '\nThe brief is inside each Notion page.'}`;
    const ok = await discord(msg, 'scripts');
    return res.status(ok ? 200 : 502).json({ ok, sent: lines.length });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
}
