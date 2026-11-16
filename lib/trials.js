// Trial reels: how the Instagram trial reels we post through Zernio are doing, per creator (Harsh, Nov 16).
// Reads Zernio's analytics for posts made through Zernio, groups hook variants of the same video into one batch,
// and adds each account's follower growth since its first trial reel. Needs ZERNIO_API_KEY.

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
    caption: p.content || '', thumb: p.thumbnailUrl || '',
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

// accounts: [{ _id, username, displayName, profileId, profilePicture }]
// followerStats: { accounts: [...], stats: { [accountId]: [{date, followers}] } }
// profiles: [{ _id, name }]  (profiles with no account show as "not connected yet")
export function summarize({ posts = [], accounts = [], followerStats = null, profiles = [] }, now = new Date()) {
  const reels = posts.filter(isTrial).map(reelRow).sort((a, z) => String(z.at).localeCompare(String(a.at)));
  const statAcc = Object.fromEntries((followerStats?.accounts || []).map((a) => [a._id, a]));
  const series = followerStats?.stats || {};
  const igAccounts = accounts.filter((a) => a.platform === 'instagram' || !a.platform);
  const profName = Object.fromEntries(profiles.map((p) => [p._id, p.name]));

  const creators = igAccounts.map((acc) => {
    const mine = reels.filter((r) => r.accountId === acc._id || (!r.accountId && r.username === acc.username));
    const batches = {};
    for (const r of mine) {
      const k = captionKey(r.caption);
      (batches[k] ||= { title: captionTitle(r.caption), reels: [] }).reels.push(r);
    }
    const batchList = Object.values(batches).map((b) => {
      b.reels.sort((a, z) => z.views - a.views);
      const first = b.reels.reduce((m, r) => (!m || String(r.at) < String(m) ? r.at : m), null);
      return { title: b.title, postedAt: first, count: b.reels.length, views: sum(b.reels, 'views'), saves: sum(b.reels, 'saves'), shares: sum(b.reels, 'shares'), comments: sum(b.reels, 'comments'), best: b.reels[0], reels: b.reels };
    }).sort((a, z) => String(z.postedAt).localeCompare(String(a.postedAt)));

    const firstAt = mine.reduce((m, r) => (!m || String(r.at) < String(m) ? r.at : m), null);
    const pts = (series[acc._id] || []).slice().sort((a, z) => a.date.localeCompare(z.date));
    const now0 = statAcc[acc._id]?.currentFollowers ?? (pts.length ? pts[pts.length - 1].followers : null);
    // followers on (or just before) the day of the first trial reel; if tracking started later, the earliest point
    let base = null, baseDate = null;
    if (firstAt && pts.length) {
      const d = day(firstAt);
      const before = pts.filter((p) => p.date <= d);
      const pick = before.length ? before[before.length - 1] : pts[0];
      base = pick.followers; baseDate = pick.date;
    }
    const views = sum(mine, 'views');
    const perReel = mine.length ? Math.round(views / mine.length) : 0;
    const followsKnown = mine.filter((r) => r.follows != null);
    return {
      accountId: acc._id, username: acc.username, name: profName[acc.profileId] || acc.displayName || acc.username,
      picture: acc.profilePicture || statAcc[acc._id]?.profilePicture || '',
      reels: mine.length, batches: batchList.length, views, reach: sum(mine, 'reach'), perReel,
      likes: sum(mine, 'likes'), comments: sum(mine, 'comments'), shares: sum(mine, 'shares'), saves: sum(mine, 'saves'),
      reelFollows: followsKnown.length ? sum(followsKnown, 'follows') : null,
      best: mine.slice().sort((a, z) => z.views - a.views)[0] || null,
      firstAt, lastAt: mine[0]?.at || null,
      followers: now0, followersAtStart: base, followersStartDate: baseDate,
      followersGained: now0 != null && base != null ? now0 - base : null,
      followerTrend: pts.filter((p) => !baseDate || p.date >= baseDate).map((p) => ({ date: p.date, followers: p.followers })),
      batchList,
    };
  }).sort((a, z) => z.views - a.views);

  const connected = new Set(igAccounts.map((a) => a.profileId));
  const waiting = profiles.filter((p) => p.name && !p.isDefault && p.name !== 'Default' && !connected.has(p._id)).map((p) => p.name);
  const last7 = new Date(now.getTime() - 7 * 864e5).toISOString();
  return {
    generated_at: now.toISOString(),
    totals: {
      creators: creators.filter((c) => c.reels).length, reels: reels.length, views: sum(reels, 'views'), reach: sum(reels, 'reach'),
      saves: sum(reels, 'saves'), shares: sum(reels, 'shares'), comments: sum(reels, 'comments'),
      followersGained: creators.reduce((s, c) => s + (c.followersGained || 0), 0),
      reels7d: reels.filter((r) => String(r.at) >= last7).length, views7d: sum(reels.filter((r) => String(r.at) >= last7), 'views'),
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

export async function trialsData({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.data;
  const fromDate = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  const [posts, acc, prof] = await Promise.all([allPosts(fromDate), z('/accounts'), z('/profiles').catch(() => ({ profiles: [] }))]);
  const accounts = (Array.isArray(acc) ? acc : acc.accounts || []).filter((a) => a.platform === 'instagram' && a.isActive !== false);
  const ids = accounts.map((a) => a._id).slice(0, 25).join(',');
  const followerStats = ids ? await z('/accounts/follower-stats', { accountIds: ids, fromDate, granularity: 'daily' }).catch(() => null) : null;
  const data = summarize({ posts, accounts, followerStats, profiles: prof.profiles || [] });
  cache = { at: Date.now(), data };
  return data;
}
