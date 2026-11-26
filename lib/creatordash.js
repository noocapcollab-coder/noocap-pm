// A creator's own dashboard (Harsh, Nov 27): audience, content performance and brand deals with full amounts, on a
// private key link (creator.html?k=<key>). Only the main numbers, nothing internal. The key decides the creator,
// from env CREATOR_DASH_KEYS ("Valeri:<key>,..."), never the page.
import { queryAll, flatten } from './notion.js';
import { trialsData } from './trials.js';

const DEALS_DS = '70d26268-6d57-4d45-abf7-a599c6f8e0f4';
const API = 'https://zernio.com/api/v1';
// Each creator's Zernio profile. Add a line to give another creator a dashboard.
export const PROFILES = { Valeri: '6ae20a7e2a23e988816d78b0' };
const TTL = 10 * 60 * 1000;
const cache = new Map();

export function creatorForDashKey(k) {
  const key = String(k || '');
  if (key.length < 20) return null;
  for (const pair of String(process.env.CREATOR_DASH_KEYS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(i + 1).trim() === key) return pair.slice(0, i).trim();
  }
  return null;
}

async function z(path, params = {}) {
  const key = process.env.ZERNIO_API_KEY || process.env.Zernio_key || process.env.ZERNIO_KEY;
  if (!key) throw new Error('Zernio key missing');
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const r = await fetch(`${API}${path}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Zernio ${path} ${r.status}`);
  return r.json();
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ymd = (d) => d.toISOString().slice(0, 10);

// Deal stage -> what the creator sees. Lost deals are left out.
export function dealStatus(stage) {
  if (stage === 'Lost') return null;
  if (stage === 'Paid') return 'Paid';
  if (stage === 'Invoiced' || stage === 'Posted') return 'Awaiting payment';
  return 'In progress';
}

export function dealsView(rows) {
  const deals = rows.map((r) => {
    const status = dealStatus(r['Deal Stage']);
    if (!status) return null;
    return { brand: r['Brand Name'] || 'Brand', status, amount: n(r['Invoice Amount']) || n(r['Final Rate USD']) || null, paidDate: r['Paid Date'] || null, started: r._created };
  }).filter(Boolean);
  const order = { 'Paid': 2, 'Awaiting payment': 1, 'In progress': 0 };
  deals.sort((a, b) => order[b.status] - order[a.status] || String(b.paidDate || b.started).localeCompare(String(a.paidDate || a.started)));
  const sum = (s) => deals.filter((d) => d.status === s).reduce((t, d) => t + (d.amount || 0), 0);
  return { deals, earned: sum('Paid'), awaiting: sum('Awaiting payment'), inProgress: sum('In progress') };
}

// Daily metrics -> last-30 vs previous-30 totals, per-platform last 30, and 12 weekly buckets
export function contentView(daily, now = new Date()) {
  const d30 = ymd(new Date(now - 30 * 864e5)), d60 = ymd(new Date(now - 60 * 864e5));
  const last = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 }, prev = { views: 0, posts: 0 };
  const platforms = {};
  const weeks = [];
  for (let i = 11; i >= 0; i--) weeks.push({ start: ymd(new Date(now - (i + 1) * 7 * 864e5)), views: 0 });
  for (const d of daily || []) {
    const m = d.metrics || {};
    if (d.date >= d30) {
      for (const k of Object.keys(last)) last[k] += k === 'posts' ? n(d.postCount) : n(m[k]);
      for (const [p, pm] of Object.entries(d.platformMetrics || {})) {
        const t = (platforms[p] ||= { platform: p, views: 0, likes: 0, posts: 0 });
        t.views += n(pm.views); t.likes += n(pm.likes); t.posts += n(pm.postCount);
      }
    } else if (d.date >= d60) { prev.views += n(m.views); prev.posts += n(d.postCount); }
    for (let i = weeks.length - 1; i >= 0; i--) if (d.date >= weeks[i].start) { weeks[i].views += n(m.views); break; }
  }
  const change = prev.views ? Math.round(((last.views - prev.views) / prev.views) * 100) : null;
  return { last30: last, prev30: prev, viewsChange: change, platforms: Object.values(platforms).sort((a, b) => b.views - a.views), weeks };
}

// Trial reels for one Instagram account: totals plus each video's batch of hook versions, newest first
export function trialsView(data, igId) {
  const c = igId && (data?.creators || []).find((x) => x.accountId === igId);
  if (!c || !c.reels) return null;
  const r = (x) => x && { url: x.url, thumb: x.thumb, views: x.views, title: x.title || '' };
  return {
    reels: c.reels, videos: c.batches, views: c.views, perReel: c.perReel, saves: c.saves, shares: c.shares, follows: c.follows,
    best: r(c.best),
    batches: (c.batchList || []).slice(0, 12).map((b) => ({ title: b.title, postedAt: b.postedAt, count: b.count, views: b.views, saves: b.saves, best: r(b.best),
      versions: b.reels.map((x) => ({ title: x.title, views: x.views, url: x.url, pending: !!x.pending })) })),
  };
}

export async function creatorDash(creator, { fresh = false } = {}) {
  const hit = cache.get(creator);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.data;
  const profileId = PROFILES[creator];
  const now = new Date();
  const [accs, daily, top, trials, dealRows] = await Promise.all([
    profileId ? z('/accounts/follower-stats', { profileId, granularity: 'daily', fromDate: ymd(new Date(now - 90 * 864e5)) }).catch(() => null) : null,
    profileId ? z('/analytics/daily-metrics', { profileId, fromDate: ymd(new Date(now - 84 * 864e5)) }).catch(() => null) : null,
    profileId ? z('/analytics', { profileId, sortBy: 'views', order: 'desc', limit: 8, fromDate: ymd(new Date(now - 90 * 864e5)) }).catch(() => null) : null,
    profileId ? trialsData({ fresh }).catch(() => null) : null,
    queryAll(DEALS_DS, { property: 'Creator', select: { equals: creator } }, { useCache: !fresh }).then((r) => r.map(flatten)),
  ]);
  const accounts = (accs?.accounts || []).map((a) => {
    const hist = (accs.stats?.[a._id] || []).map((s) => ({ date: s.date, followers: n(s.followers) }));
    const first = hist[0]?.followers;
    return { id: a._id, platform: a.platform, username: a.username, followers: n(a.currentFollowers), since: hist[0]?.date || null, gained: first != null ? n(a.currentFollowers) - first : null, history: hist };
  });
  const data = {
    creator,
    updated: now.toISOString(),
    audience: accounts.length ? { total: accounts.reduce((t, a) => t + a.followers, 0), accounts } : null,
    content: daily ? contentView(daily.dailyData, now) : null,
    top: (top?.posts || []).map((p) => ({ platform: p.platform, url: p.platformPostUrl, thumb: p.thumbnailUrl, title: String(p.content || '').split('\n')[0].slice(0, 90), at: p.publishedAt, views: n(p.analytics?.views), likes: n(p.analytics?.likes), saves: n(p.analytics?.saves) })),
    trials: trialsView(trials, accounts.find((a) => a.platform === 'instagram')?.id),
    ...dealsView(dealRows),
  };
  cache.set(creator, { at: Date.now(), data });
  return data;
}
