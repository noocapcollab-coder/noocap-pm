// Posted links, found on their own (Harsh, Nov 15): when a sponsor video's post date comes, the PM looks at the
// creator's own feeds for the post, writes the links on the card, moves the card to 12- Posted and the deal to Posted.
// From there the normal flow runs (posted-links email to the brand, invoice draft in Approvals).
//   Instagram: Zernio, which syncs every reel on a connected account, also ones posted from the phone (ZERNIO_API_KEY).
//   YouTube:   the channel's public feed (youtube.com/feeds/videos.xml?channel_id=...), free and needs no key.
// Only creators listed in POSTED_LINK_CREATORS are watched. Nothing is guessed: two possible posts, or none a day
// after the post date, means a Discord ping instead.
import { notion, plain } from './notion.js';
import { discord, log } from './briefs.js';
import { todayIST } from './tools.js';

// creator -> where their posts are. Add a creator here once their accounts are connected.
export const POSTED_LINK_CREATORS = {
  Lindsay: { zernioAccount: '6ae20c15861c17bfb82dd8eb', youtubeChannel: process.env.YT_CHANNEL_LINDSAY || 'UCgugjY9T1jv41UcKmaZ5NLQ' /* youtube.com/@AutomateAIConsulting */ },
};

const DAY = 864e5;
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w@\s.]/g, ' ');
// "Readdy AI" -> ["readdy"], "Teamily AI" -> ["teamily"], "PromoCut" -> ["promocut"]. Generic words never match alone.
const GENERIC = new Set(['ai', 'app', 'the', 'inc', 'io', 'co', 'labs', 'lab', 'hq', 'tech', 'studio', 'video', 'tools']);
export function brandKeys(brand) {
  const base = String(brand || '').replace(/\s*[×x]\s+.*$/i, '').trim();
  const parts = words(base).split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
  const joined = words(base).replace(/\s+/g, '');
  return [...new Set([...parts, joined.length >= 4 ? joined : null].filter(Boolean))];
}
export function mentionsBrand(text, brand) {
  const t = words(text).replace(/\s+/g, ' ');
  const flat = t.replace(/[\s.]/g, '');
  return brandKeys(brand).some((k) => new RegExp(`(^|[^a-z0-9])@?${k}([^a-z0-9]|$)`).test(t) || (k.length >= 6 && flat.includes(k)));
}
// Posts published from 2 days before the post date to 5 days after, that name the brand
export function matchPosts(posts, { brand, postDate }) {
  const start = Date.parse(postDate) - 2 * DAY;
  const end = Date.parse(postDate) + 6 * DAY;
  return posts.filter((p) => { const at = Date.parse(p.at); return at >= start && at <= end && mentionsBrand(p.text, brand); });
}

export async function instagramPosts(accountId, fromDate) {
  const key = process.env.ZERNIO_API_KEY;
  if (!key || !accountId) return null;
  const u = `https://zernio.com/api/v1/analytics?accountId=${accountId}&platform=instagram&fromDate=${fromDate}&limit=40&view=summary`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Zernio ${r.status}`);
  const j = await r.json();
  return (j.posts || []).map((p) => ({ platform: 'instagram', url: p.platformPostUrl || p.platforms?.[0]?.platformPostUrl, text: p.content || '', at: p.publishedAt })).filter((p) => p.url);
}

export function parseYoutubeFeed(xml) {
  return String(xml || '').split('<entry>').slice(1).map((e) => {
    const g = (re) => (e.match(re) || [])[1] || '';
    const id = g(/<yt:videoId>([^<]+)</);
    return { platform: 'youtube', url: id ? `https://www.youtube.com/shorts/${id}` : g(/<link rel="alternate" href="([^"]+)"/), text: `${g(/<title>([^<]*)</)} ${g(/<media:description>([\s\S]*?)<\/media:description>/)}`, at: g(/<published>([^<]+)</) };
  }).filter((p) => p.url);
}
export async function youtubePosts(channelId) {
  if (!channelId) return null;
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  if (!r.ok) throw new Error(`YouTube feed ${r.status}`);
  return parseYoutubeFeed(await r.text());
}

// Writes each link to the card's matching column (IG Link / YT Link / TikTok Link, or Posted URL) and moves it to 12
async function writeCard(cardId, found) {
  const page = await notion('GET', `/pages/${cardId}`);
  const props = page.properties || {};
  const col = (re) => Object.keys(props).find((k) => props[k].type === 'url' && re.test(k));
  const out = {};
  const ig = found.find((p) => p.platform === 'instagram');
  const yt = found.find((p) => p.platform === 'youtube');
  const igCol = col(/^(ig|instagram)\b/i); const ytCol = col(/^(yt|youtube)\b/i); const postedCol = col(/posted/i);
  if (ig && igCol && !props[igCol].url) out[igCol] = { url: ig.url };
  if (yt && ytCol && !props[ytCol].url) out[ytCol] = { url: yt.url };
  if (postedCol && !props[postedCol].url && (ig || yt)) out[postedCol] = { url: (ig || yt).url };
  const st = Object.keys(props).find((k) => k.toLowerCase() === 'status');
  if (st) {
    const opt = props[st].type === 'status' ? 'status' : 'select';
    out[st] = { [opt]: { name: '12- Posted' } };
  }
  await notion('PATCH', `/pages/${cardId}`, { properties: out });
}

// deal: from openDeals; video: from videoInfo (num, postDate, id, title, url)
export async function findPostedLinks(deal, video, report = { drafts: [], errors: [] }) {
  const where = POSTED_LINK_CREATORS[deal.creator];
  if (!where || !video || !(video.num >= 10 && video.num <= 12) || !video.postDate) return null;
  const today = todayIST();
  if (video.postDate > today) return null; // not due yet
  if (Date.parse(today) - Date.parse(video.postDate) > 10 * DAY) return null; // old card, leave it to a person
  const from = new Date(Date.parse(video.postDate) - 2 * DAY).toISOString().slice(0, 10);
  const [ig, yt] = await Promise.all([
    instagramPosts(where.zernioAccount, from).catch((e) => { report.errors.push(`posted links IG ${deal.brand}: ${e.message}`); return null; }),
    youtubePosts(where.youtubeChannel).catch((e) => { report.errors.push(`posted links YT ${deal.brand}: ${e.message}`); return null; }),
  ]);
  const igHits = ig ? matchPosts(ig, { brand: deal.brand, postDate: video.postDate }) : [];
  const ytHits = yt ? matchPosts(yt, { brand: deal.brand, postDate: video.postDate }) : [];
  const lateBy = Math.floor((Date.parse(today) - Date.parse(video.postDate)) / DAY);
  const once = async (event, mark, text) => {
    const seen = await notion('POST', `/data_sources/4215bfda-0191-4e77-a40b-4c2d8b6e0d70/query`, { page_size: 1, filter: { and: [{ property: 'Event', title: { starts_with: event } }, { property: 'Details', rich_text: { contains: mark } }] } }).then((r) => (r.results || []).length > 0).catch(() => true);
    if (seen) return;
    await discord(text, 'pm');
    await log({ event: `${event}: ${deal.brand} × ${deal.creator}`, outcome: 'Alert', email: { messageId: '' }, deal, details: mark, area: 'Brand deals', creator: deal.creator }).catch(() => {});
  };
  if (igHits.length > 1 || ytHits.length > 1) {
    await once('Posted links unclear', `${video.id} several`, `🔎 **${deal.brand} × ${deal.creator}**: I found more than one post naming ${deal.brand} around ${video.postDate}, so I didn't pick one.\n${[...igHits, ...ytHits].map((p) => `• ${p.url}`).join('\n')}\nAdd the right link on the card and set it to 12- Posted. → ${video.url}`);
    return null;
  }
  const found = [...(hadIg ? [] : igHits), ...ytHits];
  // The card already has its Instagram link (put there by hand or an earlier run): only a missing YouTube Short is looked for
  const had = `${video.postedUrl || ''}\n${deal.postedLinks || ''}`;
  const hadIg = /instagram\.com/i.test(had);
  if (hadIg && !ytHits.length) return null;
  if (!igHits.length && !hadIg) {
    if (lateBy >= 1) await once('Posted links not found', `${video.id} none`, `🔎 **${deal.brand} × ${deal.creator}** was due to go live ${video.postDate}, but I can't find a ${ig ? 'reel' : 'post'} naming ${deal.brand} on ${deal.creator}'s Instagram${ig ? '' : ' (Zernio isn\'t connected to the PM yet)'}. If it's live, add the link on the card and set it to 12- Posted. → ${video.url}`);
    return null;
  }
  await writeCard(video.id, found);
  const links = [...new Set([...String(deal.postedLinks || '').split(/\s+/).filter((u) => /^https?:/.test(u)), ...found.map((p) => p.url)])].join('\n');
  deal.postedLinks = links;
  await log({ event: `Posted links found: ${deal.brand} × ${deal.creator}`, outcome: 'Changed', email: { messageId: '' }, deal, details: `${video.id} ${links}`, area: 'Brand deals', creator: deal.creator }).catch(() => {});
  await discord(`🔗 **Live: ${deal.brand} × ${deal.creator}**\n${found.map((x) => `• ${x.platform === 'instagram' ? 'Instagram' : 'YouTube'}: ${x.url}`).join('\n')}\nCard moved to 12- Posted, so the posted-links email and the invoice draft come next.${!ytHits.length && POSTED_LINK_CREATORS[deal.creator].youtubeChannel ? ' (No YouTube Short found yet.)' : ''}`, 'pm').catch(() => {});
  report.drafts.push(`Posted links found: ${deal.brand} × ${deal.creator}`);
  return { found, num: 12 };
}
