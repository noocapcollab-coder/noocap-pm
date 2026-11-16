// Trial reels: how the Instagram trial reels we post through Zernio are doing, per creator (Harsh, Nov 16).
// Only posts Zernio itself marks as trial reels (isTrialReel) count. Hook variants of the same video are grouped
// into one batch. Account-wide numbers (followers) are left out on purpose: this tab is trial reels only.

const API = 'https://zernio.com/api/v1';
const TTL = 10 * 60 * 1000;
let cache = null;

async function z(path, params = {}) {
  const key = process.env.ZERNIO_API_KEY || process.env.Zernio_key || process.env.ZERNIO_KEY;
  if (!key) throw new Error('The Zernio key (Zernio_key or ZERNIO_API_KEY) is not set in Vercel, or this deploy is older than the key, so trial reel numbers cannot load yet');
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const r = await fetch(`${API}${path}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${key}` } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error(`Zernio ${path} ${r.status}: ${(j && (j.error || j.message)) || t.slice(0, 160)}`);
  return j;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const day = (iso) => String(iso || '').slice(0, 10);

// A trial reel is an Instagram reel published through Zernio that was not shared to the main feed.
export function isTrial(p) {
  const pl = (p.platforms && p.platforms[0]) || {};
  const ig = (p.platform || pl.platform) === 'instagram';
  const reel = !p.mediaProductType || p.mediaProductType === 'REELS';
  return ig && reel && p.isSharedToFeed !== true && (p.status || pl.status) === 'published';
}

// The opening line of the caption, used as the batch name (hook variants of one video share a caption)
export function captionKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 140);
}
export function captionTitle(text) {
  const first = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || 'Untitled reel';
  return first.length > 90 ? first.slice(0, 87) + '…' : first;
}

export function reelRow(p) {
  const a = p.analytics || {};
  const pl = (p.platforms && p.platforms[0]) || {};
  const views = n(a.views || a.impressions);
  return {
    id: p.latePostId || p._id, url: p.platformPostUrl || pl.platformPostUrl || '', at: p.publishedAt || p.scheduledFor || null,
    accountId: pl.accountId || p.accountId || '', username: pl.accountUsername || '', profileId: p.profileId || '',
    caption: p.content || '', title: p.title || '', thumb: p.thumbnailUrl || '',
    views, reach: n(a.reach), likes: n(a.likes), comments: n(a.comments), shares: n(a.shares), saves: n(a.saves),
    follows: a.follows == null ? null : n(a.follows),
    avgWatchSec: a.igReelsAvgWatchTime ? Math.round(n(a.igReelsAvgWatchTime) / 100) / 10 : null,
    lengthSec: a.videoDurationSeconds ? n(a.videoDurationSeconds) : null,
    skipRate: a.reelsSkipRate == null ? null : n(a.reelsSkipRate),
    engagement: a.engagementRate == null ? null : n(a.engagementRate),
    updated: a.lastUpdated || null,
  };
}

const sum = (xs, k) => xs.reduce((s, x) => s + (x[k] || 0), 0);

// "Duncan trial reel Hook 2 V1 Pixel Game" -> "Hook 2 V1 Pixel Game"
export const cleanTitle = (t) => String(t || '').replace(/^\S+\s+trial reel\s+/i, '').trim();
const pid = (x) => (x && typeof x === 'object' ? x._id : x) || '';

// posts: Zernio analytics rows. trials: [{ id, title, accountId, at, url }] from /v1/posts where isTrialReel is true
// (when given, only those count, and trials not yet in analytics show as just posted). accounts, profiles: from Zernio.
export function summarize({ posts = [], trials = null, accounts = [], profiles = [] }, now = new Date()) {
  let reels = posts.filter(isTrial).map(reelRow);
  if (trials) {
    const byId = Object.fromEntries(trials.map((t) => [t.id, t]));
    reels = reels.filter((r) => byId[r.id]).map((r) => ({ ...r, title: cleanTitle(byId[r.id].title) }));
    const seen = new Set(reels.map((r) => r.id));
    for (const t of trials) if (!seen.has(t.id)) reels.push({ ...reelRow({ latePostId: t.id, content: t.caption || '', publishedAt: t.at, platformPostUrl: t.url, platforms: [{ accountId: t.accountId, accountUsername: t.username }] }), title: cleanTitle(t.title), pending: true });
  }
  reels.sort((a, z) => String(z.at).localeCompare(String(a.at)));
  const profName = Object.fromEntries(profiles.map((p) => [p._id, p.name]));
  const igAccounts = accounts.filter((a) => a.platform === 'instagram' || !a.platform);

  const creators = igAccounts.map((acc) => {
    const mine = reels.filter((r) => r.accountId === acc._id || (!r.accountId && r.username === acc.username));
    const batches = {};
    for (const r of mine) {
      const k = captionKey(r.caption) || r.id;
      (batches[k] ||= { title: captionTitle(r.caption), reels: [] }).reels.push(r);
    }
    const batchList = Object.values(batches).map((b) => {
      b.reels.sort((a, z) => z.views - a.views);
      const first = b.reels.reduce((m, r) => (!m || String(r.at) < String(m) ? r.at : m), null);
      return { title: b.title, postedAt: first, count: b.reels.length, views: sum(b.reels, 'views'), reach: sum(b.reels, 'reach'), saves: sum(b.reels, 'saves'), shares: sum(b.reels, 'shares'), comments: sum(b.reels, 'comments'), likes: sum(b.reels, 'likes'), best: b.reels[0], reels: b.reels };
    }).sort((a, z) => String(z.postedAt).localeCompare(String(a.postedAt)));
    const views = sum(mine, 'views');
    const counted = mine.filter((r) => !r.pending);
    const followsKnown = mine.filter((r) => r.follows != null);
    return {
      accountId: acc._id, username: acc.username, name: profName[pid(acc.profileId)] || acc.displayName || acc.username,
      picture: acc.profilePicture || '',
      reels: mine.length, batches: batchList.length, views, reach: sum(mine, 'reach'), perReel: counted.length ? Math.round(views / counted.length) : 0,
      likes: sum(mine, 'likes'), comments: sum(mine, 'comments'), shares: sum(mine, 'shares'), saves: sum(mine, 'saves'),
      follows: followsKnown.length ? sum(followsKnown, 'follows') : null,
      best: mine.slice().sort((a, z) => z.views - a.views)[0] || null,
      firstAt: mine.reduce((m, r) => (!m || String(r.at) < String(m) ? r.at : m), null), lastAt: mine[0]?.at || null,
      batchList,
    };
  }).sort((a, z) => z.views - a.views);

  const connected = new Set(igAccounts.map((a) => pid(a.profileId)));
  const waiting = profiles.filter((p) => p.name && !p.isDefault && p.name !== 'Default' && !connected.has(p._id)).map((p) => p.name);
  const last7 = new Date(now.getTime() - 7 * 864e5).toISOString();
  return {
    generated_at: now.toISOString(),
    totals: {
      creators: creators.filter((c) => c.reels).length, reels: reels.length, views: sum(reels, 'views'), reach: sum(reels, 'reach'),
      saves: sum(reels, 'saves'), shares: sum(reels, 'shares'), comments: sum(reels, 'comments'), likes: sum(reels, 'likes'),
      reels7d: reels.filter((r) => String(r.at) >= last7).length,
    },
    creators, waiting,
    updated: reels.reduce((m, r) => (r.updated && (!m || r.updated > m) ? r.updated : m), null),
  };
}

async function allPosts(fromDate) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await z('/analytics', { source: 'late', platform: 'instagram', fromDate, limit: 40, page });
    out.push(...(j.posts || []));
    if (!j.pagination || page >= (j.pagination.pages || 1)) break;
  }
  return out;
}

// Every post Zernio marks as a trial reel (title, account, link), newest first
async function trialPosts() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await z('/posts', { status: 'published', limit: 40, page, fields: '_id,title,content,platforms' });
    for (const p of j.posts || []) for (const pl of p.platforms || []) {
      if (pl.platform !== 'instagram' || !pl.isTrialReel) continue;
      const acc = pl.accountId || {};
      out.push({ id: p._id, title: p.title || '', caption: p.content || '', accountId: pid(acc), username: acc.username || '', at: pl.publishedAt || null, url: pl.platformPostUrl || '' });
    }
    if (!j.pagination || page >= (j.pagination.pages || 1)) break;
  }
  return out;
}

export async function trialsData({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.data;
  const fromDate = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  const [posts, trials, acc, prof] = await Promise.all([allPosts(fromDate), trialPosts().catch(() => null), z('/accounts'), z('/profiles').catch(() => ({ profiles: [] }))]);
  const accounts = (Array.isArray(acc) ? acc : acc.accounts || []).filter((a) => a.platform === 'instagram' && a.isActive !== false);
  const data = summarize({ posts, trials, accounts, profiles: prof.profiles || [] });
  cache = { at: Date.now(), data };
  return data;
}
