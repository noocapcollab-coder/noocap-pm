// Skool link tracking (Harsh, Nov 23): per-platform tracked links (join-link.vercel.app/<slug>; the old noocap-links.vercel.app host still redirects) that redirect to a
// creator's Skool about page, plus an hourly read of the public Skool member count. Data lives in Supabase
// (project modmsekznxqxgwwpogul: tracked_links, link_clicks, skool_snapshots) and is read here through
// aggregate-only RPCs, so no member emails or raw rows ever reach the browser.

const SB_URL = process.env.LINKS_SUPABASE_URL || 'https://modmsekznxqxgwwpogul.supabase.co';
const SB_KEY = process.env.LINKS_SUPABASE_KEY || 'sb_publishable_gMMSMys65SDzcT0nd_NHxA_H1xYFLXm';
export const LINK_HOST = process.env.LINKS_HOST || 'https://join-link.vercel.app';

async function rpc(fn, args = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Link tracking ${fn} ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

export async function skoolLinksData({ days = 30 } = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const list = (await rpc('link_creators')) || [];
  const creators = await Promise.all(list.map(async ({ creator, skool_url }) => {
    const [links, members] = await Promise.all([
      rpc('link_stats', { p_creator: creator, p_days: d }),
      rpc('member_stats', { p_creator: creator, p_days: d }),
    ]);
    return { creator, skoolUrl: skool_url, ...links, members };
  }));
  return { generated_at: new Date().toISOString(), days: d, linkHost: LINK_HOST, dashboard: `${LINK_HOST}/dashboard/`, creators };
}
