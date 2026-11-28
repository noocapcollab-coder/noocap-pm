// Posting calendar (Harsh, Nov 28): for every client, what goes out on which day, which automation posts it and when,
// in one place. Three sources make it up:
//  1. Zernio: posts already scheduled there, plus what went out (or failed) today
//  2. The posting automations (Claude scheduled tasks), replayed against the cards waiting on each board, so each
//     queued card shows the run that will pick it up. The registry below mirrors those tasks' prompts: when one
//     changes its schedule or its rules, change it here too.
//  3. Cards with a POST DATE that editors post by hand (Instagram and Facebook)
import { notion, queryAll, flatten, titleOf } from './notion.js';
import { BOARDS } from './tools.js';

const ZAPI = 'https://zernio.com/api/v1';
const TTL = 2 * 60 * 1000;
let cache = null;
const DAYS = 7;
const BACK = 7; // days of history: what went out last week, and what was due and never went

// ---------- time helpers (pure) ----------
function parts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
export function ymdIn(ms, tz = 'Asia/Kolkata') { const o = parts(ms, tz); return `${o.year}-${o.month}-${o.day}`; }
export function weekdayIn(ms, tz = 'Asia/Kolkata') { return parts(ms, tz).weekday; }
// The instant when the clock in tz reads ymd hh:mm
export function zoned(ymd, hh, mm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = (ms) => { const o = parts(ms, tz); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute) - ms; };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// ---------- the posting automations ----------
// runs(fromMs, toMs) -> run instants; plan(queue, runs) -> [{card, at}] where the card is expected to go out
const dailyRuns = (times, tz, days = null) => (from, to) => {
  const out = [];
  for (let ymd = ymdIn(from - 864e5, tz); Date.parse(ymd) <= to + 2 * 864e5; ymd = addDays(ymd, 1)) {
    for (const [h, m] of times) {
      const t = zoned(ymd, h, m, tz);
      if (t < from || t > to) continue;
      if (days && !days.includes(weekdayIn(t, tz))) continue;
      out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
};

const byPostDate = (a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(a.created).localeCompare(String(b.created));
const hasType = (c, t) => new RegExp(`\\b${t}\\b`, 'i').test(c.type || '');
const autoState = (c) => String(c.raw['TikTok + YT (Auto)'] || '').trim();

export const AUTOMATIONS = [
  {
    id: 'valeri-ttyt', name: 'Valeri TikTok + YouTube auto-post', creator: 'Valeri', platforms: ['TikTok', 'YouTube Shorts'],
    when: 'Three times a day at 5:47 AM, 6:47 PM and 9:47 PM IST, one video each run, published straight away',
    rule: 'Cards at To Post, Ready or Posted with a Hook picked, TikTok Caption, YT Title and YT Description filled, and TikTok + YT (Auto) not posted yet. Oldest POST DATE first. No hook means it never posts.',
    runs: dailyRuns([[5, 47], [18, 47], [21, 47]], 'Asia/Kolkata'),
    pick(cards) {
      const queue = [], held = [];
      for (const c of cards) {
        if (!/^(10|11|12)-/.test(c.status || '') || hasType(c, 'TRIALS')) continue;
        const st = autoState(c);
        if (st && st !== 'Not posted') { if (st === 'Failed' && !/^12-/.test(c.status)) held.push({ card: c, why: 'Failed last time, it is only retried when you say so' }); continue; }
        const live = /^(10|11)-/.test(c.status);
        const hook = /hook\s*[ab]/i.test(c.raw.Hook || '');
        const missing = ['TikTok Caption', 'YT Title', 'YT Description'].filter((k) => !String(c.raw[k] || '').trim());
        if (!hook) { if (live) held.push({ card: c, why: 'No Hook picked yet, so it will not post' }); continue; }
        if (missing.length) { held.push({ card: c, why: `Missing ${missing.join(', ')}` }); continue; }
        queue.push(c);
      }
      return { queue: queue.sort(byPostDate), held };
    },
    plan(queue, runs) { return queue.slice(0, runs.length).map((card, i) => ({ card, at: runs[i] })); },
  },
  {
    id: 'lindsay-ttyt', name: 'Lindsay TikTok + YouTube auto-post', creator: 'Lindsay', platforms: ['TikTok', 'YouTube Shorts'],
    when: 'Once a day at 6:31 PM New York time (5:01 AM IST). It schedules up to 3 videos: 7 PM New York, then 7 PM and 10 PM IST',
    rule: 'Cards at 10- To Post that are not trial reels and whose TikTok + YT (Auto) is empty, oldest POST DATE first. A card whose comment keyword has no live lead magnet yet is held at run time.',
    runs: dailyRuns([[18, 31]], 'America/New_York'),
    pick(cards) {
      const queue = [], held = [];
      for (const c of cards) {
        if (c.status !== '10- To Post' || hasType(c, 'TRIALS') || hasType(c, 'CAROUSEL')) continue;
        const st = autoState(c);
        if (st === 'Failed') { held.push({ card: c, why: 'Failed last time, it is only retried when you say so' }); continue; }
        if (st && st !== 'Not posted') continue;
        queue.push(c);
      }
      return { queue: queue.sort(byPostDate), held };
    },
    plan(queue, runs) {
      const out = [];
      let i = 0;
      for (const r of runs) {
        const ist = ymdIn(r, 'Asia/Kolkata');
        const slots = [r + 29 * 60e3, zoned(ist, 19, 0, 'Asia/Kolkata'), zoned(ist, 22, 0, 'Asia/Kolkata')];
        for (const at of slots) { if (i >= queue.length) return out; out.push({ card: queue[i++], at }); }
      }
      return out;
    },
  },
  {
    id: 'lindsay-carousel', name: 'Lindsay daily carousel', creator: 'Lindsay', platforms: ['Instagram carousel'],
    when: 'Monday to Friday at 2:07 PM IST it builds the carousel and schedules it in Zernio for 7:00 PM IST the same day',
    rule: 'One CAROUSEL card a day from Lindsay\'s board: the one dated today, else the oldest overdue, else the oldest with no date. Cards dated later wait for their day.',
    runs: dailyRuns([[14, 7]], 'Asia/Kolkata', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
    pick(cards) {
      const queue = cards.filter((c) => hasType(c, 'CAROUSEL') && c.title && c.title !== 'Untitled' && !/^(12-|Scheduled|Archive)/i.test(c.status || ''));
      return { queue: queue.sort(byPostDate), held: [] };
    },
    plan(queue, runs) {
      const left = [...queue], out = [];
      for (const r of runs) {
        const day = ymdIn(r, 'Asia/Kolkata');
        const ok = left.filter((c) => !c.date || c.date <= day);
        const pick = ok.find((c) => c.date === day) || ok.filter((c) => c.date).sort(byPostDate)[0] || ok.filter((c) => !c.date).sort((a, b) => String(a.created).localeCompare(String(b.created)))[0];
        if (!pick) continue;
        left.splice(left.indexOf(pick), 1);
        out.push({ card: pick, at: zoned(day, 19, 0, 'Asia/Kolkata') });
      }
      return out;
    },
  },
  {
    id: 'duncan-trials', name: 'Duncan trial reels auto-post', creator: 'Duncan', platforms: ['Instagram trial reels'],
    when: 'Every 3 hours (2:43, 5:43, 8:43, 11:43 IST and so on), every ready card at once, each hook version as its own trial reel',
    rule: 'TRIALS cards at 10- To Post on Duncan\'s planner. After they publish the card moves to Posted.',
    runs: (from, to) => { const out = []; const h0 = Math.floor(from / 36e5) * 36e5; for (let t = h0; t <= to; t += 36e5) { const d = new Date(t); if (d.getUTCHours() % 3 === 0) { const at = t + 13 * 60e3; if (at >= from && at <= to) out.push(at); } } return out; },
    pick(cards) { return { queue: cards.filter((c) => hasType(c, 'TRIALS') && c.status === '10- To Post').sort(byPostDate), held: [] }; },
    plan(queue, runs) { return runs.length ? queue.map((card) => ({ card, at: runs[0] })) : []; },
  },
];

// ---------- reading the boards ----------
const schemaCache = new Map();
async function schema(ds) {
  if (!schemaCache.has(ds)) schemaCache.set(ds, notion('GET', `/data_sources/${ds}`).then((j) => j.properties || {}).catch(() => ({})));
  return schemaCache.get(ds);
}
function matchFilter(props, name, values) {
  const p = props[name];
  if (!p) return null;
  const kind = p.type === 'status' ? 'status' : p.type === 'multi_select' ? 'multi_select' : 'select';
  const op = kind === 'multi_select' ? 'contains' : 'equals';
  const list = values.map((v) => ({ property: name, [kind]: { [op]: v } }));
  return list.length === 1 ? list[0] : { or: list };
}

export function toCard(page, creator) {
  const f = flatten(page);
  return {
    id: page.id, url: page.url, creator, title: titleOf(page), status: f.Status || '', type: f.TYPE || f.Type || '',
    date: String(f['POST DATE'] || '').slice(0, 10) || null, created: page.created_time, raw: f,
  };
}

async function readBoard(creator, ds, filterFor) {
  const props = await schema(ds);
  const filter = filterFor(props);
  if (filter === null) return [];
  return (await queryAll(ds, filter || undefined, { useCache: false })).map((p) => toCard(p, creator));
}

const boardOf = (name) => BOARDS.find((b) => b.creator === name);

// ---------- Zernio ----------
async function z(path, params = {}) {
  const key = process.env.ZERNIO_API_KEY || process.env.Zernio_key || process.env.ZERNIO_KEY;
  if (!key) throw new Error('Zernio key missing');
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const r = await fetch(`${ZAPI}${path}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Zernio ${path} ${r.status}`);
  return r.json();
}
const idOf = (x) => (x && typeof x === 'object' ? x._id || x.id : x) || '';
const PROFILE_NAMES = { David: 'David Iya' };
const PLATFORM = { tiktok: 'TikTok', youtube: 'YouTube Shorts', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', twitter: 'X', threads: 'Threads' };

// Which automation made a Zernio post, from its title or external id
export function zernioBy(p) {
  const t = String(p.title || '');
  if (/^Lindsay carousel/i.test(t)) return 'Lindsay daily carousel';
  if (/^Duncan trial reel/i.test(t)) return 'Duncan trial reels auto-post';
  if (/notion-/i.test(String(p.externalId || p.external_id || ''))) return 'TikTok + YouTube auto-post';
  return 'Scheduled in Zernio';
}

export function zernioItems(posts, accounts, profiles, { fromMs, toMs }) {
  const profName = new Map((profiles || []).map((p) => [String(p._id), PROFILE_NAMES[p.name] || p.name]));
  const accCreator = new Map((accounts || []).map((a) => [String(a._id), profName.get(String(idOf(a.profileId))) || '']));
  const out = [];
  for (const p of posts || []) {
    const pls = p.platforms || [];
    const at = Date.parse(pls.find((x) => x.publishedAt)?.publishedAt || p.publishedAt || p.scheduledFor || '');
    if (!at || at < fromMs || at > toMs) continue;
    const creator = pls.map((x) => accCreator.get(String(idOf(x.accountId)))).find(Boolean) || profName.get(String(idOf(p.profileId))) || 'Other';
    const statuses = pls.map((x) => x.status || p.status);
    const state = statuses.includes('failed') || p.status === 'failed' ? 'failed' : statuses.every((s) => s === 'published') || p.status === 'published' ? 'posted' : 'scheduled';
    out.push({
      source: 'zernio', state, at: new Date(at).toISOString(), creator, by: zernioBy(p),
      title: String(p.title || p.content || '').split('\n')[0].slice(0, 110) || 'Untitled post',
      platforms: [...new Set(pls.map((x) => PLATFORM[x.platform] || x.platform))],
      url: pls.find((x) => x.platformPostUrl)?.platformPostUrl || null,
      trial: pls.some((x) => x.isTrialReel || x.platformSpecificData?.trialParams),
    });
  }
  return out;
}

// Everything that actually went live in the window, from Zernio's synced post list: posts made through Zernio and
// posts editors made by hand in the apps (isExternal). One item per post per platform.
export function postedItems(posts, profileName, { fromMs, toMs, byId = new Map() }) {
  const out = [], seen = new Set();
  for (const p of posts || []) {
    const at = Date.parse(p.publishedAt || '');
    if (!at || at < fromMs || at > toMs) continue;
    const url = p.platformPostUrl || (p.platforms || []).find((x) => x.platformPostUrl)?.platformPostUrl || null;
    const key = url || p._id;
    if (seen.has(key)) continue;
    seen.add(key);
    const creator = profileName.get(String(p.profileId)) || 'Other';
    out.push({
      source: 'zernio', state: 'posted', at: new Date(at).toISOString(), creator,
      by: byId.get(String(p.latePostId || p._id)) || (p.latePostId ? 'Posted through Zernio' : 'Posted by hand'),
      title: String(p.content || p.title || '').split('\n')[0].slice(0, 110) || 'Untitled post',
      platforms: [PLATFORM[p.platform] || p.platform].filter(Boolean), url, postUrl: url,
      trial: (p.platforms || []).some((x) => x.isTrialReel) || /trial/i.test(String(p.mediaProductType || '')),
      views: Number(p.analytics?.views) || null,
    });
  }
  return out;
}

// ---------- manual posts (editors) ----------
const MANUAL_STATUS = /^(9|10|11|12)-|^Scheduled/;
// A card dated before today that is not posted yet is overdue (Harsh, Nov 28: the tab must show what's out and what isn't)
export function manualItems(cards, { from, to, today = from }) {
  return cards.filter((c) => c.date && c.date >= from && c.date <= to && (MANUAL_STATUS.test(c.status || '') || (c.date < today && /^[1-8](\.\d)?-/.test(c.status || ''))) && !hasType(c, 'TRIALS') && !hasType(c, 'CAROUSEL') && !hasType(c, 'REPOST'))
    .map((c) => {
      const ig = String(c.raw['IG + FB (Manual)'] || '');
      const live = String(c.raw['Posted URL'] || c.raw['Video Link'] || '').match(/https?:\/\/\S*(instagram|tiktok|youtu)\S*/i)?.[0] || null;
      const done = /^12-/.test(c.status) || /posted/i.test(ig) || !!live;
      const state = done ? 'posted' : c.date < today ? 'overdue' : /^[1-9](\.\d)?-/.test(c.status) && !/^(10|11)-/.test(c.status) ? 'waiting' : 'manual';
      return {
        source: 'manual', state, day: c.date, creator: c.creator, title: c.title, url: c.url, postUrl: live,
        by: 'Editors, by hand', platforms: ['Valeri', 'Lindsay'].includes(c.creator) ? ['Instagram', 'Facebook'] : ['Instagram'],
        note: done ? null : /^[1-9](\.\d)?-/.test(c.status) && !/^(10|11)-/.test(c.status) ? `Not ready yet: ${c.status}` : c.status, sponsor: hasType(c, 'SPONSOR'),
      };
    });
}

// ---------- putting it together ----------
export async function postingData({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.data;
  const now = Date.now();
  const today = ymdIn(now);
  const last = addDays(today, DAYS - 1);
  const first = addDays(today, -BACK);
  const pastStart = zoned(first, 0, 0, 'Asia/Kolkata');
  const end = zoned(last, 23, 59, 'Asia/Kolkata');
  const errors = [];
  const soft = (label, p) => p.catch((e) => { errors.push(`${label}: ${String(e.message || e).slice(0, 140)}`); return null; });

  const ds = { Valeri: boardOf('Valeri').ds, Lindsay: boardOf('Lindsay').ds, Duncan: boardOf('Duncan').ds };
  const [valeri, lindsayPost, lindsayCar, duncan, dated, zs, zp, zf, acc, prof] = await Promise.all([
    soft('Valeri board', readBoard('Valeri', ds.Valeri, (p) => matchFilter(p, 'Status', ['10- To Post', '11- Ready', '12- Posted']))),
    soft('Lindsay board', readBoard('Lindsay', ds.Lindsay, (p) => matchFilter(p, 'Status', ['10- To Post']))),
    soft('Lindsay carousels', readBoard('Lindsay', ds.Lindsay, (p) => matchFilter(p, 'Type', ['CAROUSEL']))),
    soft('Duncan board', readBoard('Duncan', ds.Duncan, (p) => matchFilter(p, 'TYPE', ['TRIALS']))),
    Promise.all(BOARDS.map((b) => soft(`${b.creator} board`, readBoard(b.creator, b.ds, (p) => (p['POST DATE'] ? { and: [{ property: 'POST DATE', date: { on_or_after: first } }, { property: 'POST DATE', date: { on_or_before: last } }] } : null))))),
    soft('Zernio scheduled', z('/posts', { status: 'scheduled', limit: 100 })),
    soft('Zernio posted', z('/posts', { status: 'published', limit: 100 })),
    soft('Zernio failed', z('/posts', { status: 'failed', limit: 30 })),
    soft('Zernio accounts', z('/accounts')),
    soft('Zernio profiles', z('/profiles')),
  ]);

  const items = [];
  const accounts = acc ? (Array.isArray(acc) ? acc : acc.accounts || []) : [];
  const profiles = prof?.profiles || [];
  const profileName = new Map(profiles.map((p) => [String(p._id), PROFILE_NAMES[p.name] || p.name]));
  // Scheduled and failed come from Zernio's own posts; what went live comes from its synced post list below
  items.push(...zernioItems([...(zs?.posts || []), ...(zf?.posts || [])], accounts, profiles, { fromMs: pastStart, toMs: end }));
  const byId = new Map((zp?.posts || []).map((p) => [String(p._id), zernioBy(p)]));
  const live = await Promise.all(profiles.filter((p) => p.name !== 'Default').map((p) => soft(`Zernio posts ${p.name}`, Promise.all([1, 2].map((page) => z('/analytics', { profileId: p._id, sortBy: 'date', order: 'desc', limit: 40, page, fromDate: first }).catch(() => null))))));
  const livePosts = live.flat().filter(Boolean).flatMap((r) => r.posts || []);
  items.push(...postedItems(livePosts, profileName, { fromMs: pastStart, toMs: now + 60e3, byId }));
  const zernioCreators = new Set(profileName.values());

  const autos = [];
  const boardsFor = { 'valeri-ttyt': valeri, 'lindsay-ttyt': lindsayPost, 'lindsay-carousel': lindsayCar, 'duncan-trials': duncan };
  for (const a of AUTOMATIONS) {
    const cards = boardsFor[a.id];
    const runs = a.runs(now, end);
    const next = a.runs(now, now + 8 * 864e5)[0] || null;
    if (!cards) { autos.push({ id: a.id, name: a.name, creator: a.creator, platforms: a.platforms, when: a.when, rule: a.rule, next: next && new Date(next).toISOString(), queued: null, held: [], error: true }); continue; }
    const { queue, held } = a.pick(cards);
    const plan = a.plan(queue, runs);
    for (const { card, at } of plan) {
      items.push({ source: 'auto', state: 'planned', at: new Date(at).toISOString(), creator: a.creator, by: a.name, title: card.title, url: card.url, platforms: a.platforms, note: card.date ? `POST DATE ${card.date}` : 'No POST DATE' });
    }
    autos.push({
      id: a.id, name: a.name, creator: a.creator, platforms: a.platforms, when: a.when, rule: a.rule,
      next: next && new Date(next).toISOString(), queued: queue.length, inWeek: plan.length,
      held: held.map(({ card, why }) => ({ title: card.title, url: card.url, why })),
    });
  }

  // Cards posted by hand: for creators in Zernio the live post itself is already listed, so a card marked Posted
  // isn't listed twice; their cards still waiting (or overdue) are.
  const allDated = (dated || []).flat().filter(Boolean);
  items.push(...manualItems(allDated, { from: first, to: last, today }).filter((it) => !(it.state === 'posted' && zernioCreators.has(it.creator))));

  const dayOf = (it) => it.day || ymdIn(Date.parse(it.at));
  const byTime = (x, y) => String(x.at || '~').localeCompare(String(y.at || '~')) || x.creator.localeCompare(y.creator);
  const days = [];
  for (let i = -BACK; i < DAYS; i++) {
    const d = addDays(today, i);
    days.push({ date: d, past: i < 0, today: i === 0, items: items.filter((it) => dayOf(it) === d).sort(byTime) });
  }
  const creators = [...new Set(items.map((i) => i.creator).concat(AUTOMATIONS.map((a) => a.creator)))].filter((c) => c && c !== 'Other').sort();
  const data = { generated_at: new Date(now).toISOString(), today, days, automations: autos, creators, zernioCreators: [...zernioCreators], errors };
  cache = { at: Date.now(), data };
  return data;
}
