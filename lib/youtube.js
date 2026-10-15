// YouTube audience (age, gender, countries, devices) for a creator's own channel, through the YouTube Analytics API.
// The creator connects once with Google (read-only); the PM keeps an encrypted refresh token in the "YouTube Audience"
// Notion database and refreshes the numbers weekly.
//
// Vercel env: YT_CLIENT_ID, YT_CLIENT_SECRET (an OAuth "Web application" client in the same Google Cloud project as the
// YouTube key, with redirect URI https://noocap-pm.vercel.app/youtube/callback). PM_PUBLIC_URL sets the site address.
import crypto from 'node:crypto';
import { notion, plain } from './notion.js';

export const YT_DS = '6eb5b6ab-cb18-4977-9549-8d637988b2d7';
const SCOPES = ['https://www.googleapis.com/auth/yt-analytics.readonly', 'https://www.googleapis.com/auth/youtube.readonly'];
const base = () => String(process.env.PM_PUBLIC_URL || 'https://noocap-pm.vercel.app').replace(/\/$/, '');
const redirect = () => `${base()}/youtube/callback`;
const rt = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 1990) } }];
const rtLong = (s) => { const t = String(s ?? ''); const out = []; for (let i = 0; i < t.length && out.length < 50; i += 1990) out.push({ type: 'text', text: { content: t.slice(i, i + 1990) } }); return out; };
const readLong = (p) => (p?.rich_text || []).map((t) => t.plain_text).join('');

export const ytReady = () => !!(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET);

// ---------- signing (connect links) and encryption (the stored token) ----------
const secret = () => String(process.env.PM_HOOK_SECRET || process.env.YT_CLIENT_SECRET || '');
const sign = (s) => crypto.createHmac('sha256', secret()).update(String(s)).digest('base64url').slice(0, 24);
export const connectLink = (creator) => `${base()}/youtube/connect?creator=${encodeURIComponent(creator)}&k=${sign('yt:' + creator)}`;
const encKey = () => crypto.createHash('sha256').update('yt-token:' + String(process.env.YT_CLIENT_SECRET || '')).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
function decrypt(blob) {
  const [iv, tag, data] = String(blob || '').split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ---------- connect flow ----------
export function startConnect({ creator, k }) {
  if (!ytReady()) throw new Error('YT_CLIENT_ID and YT_CLIENT_SECRET are not set in Vercel yet.');
  if (!creator || k !== sign('yt:' + creator)) throw new Error('This connect link is not valid. Copy it again from the PM.');
  const q = new URLSearchParams({ client_id: process.env.YT_CLIENT_ID, redirect_uri: redirect(), response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: `${creator}|${sign('state:' + creator)}` });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function google(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Google ${r.status}`);
  return j;
}
const api = async (url, token) => {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `YouTube ${r.status}`);
  return j;
};

async function rowFor(creator) {
  const r = await notion('POST', `/data_sources/${YT_DS}/query`, { page_size: 1, filter: { property: 'Creator', title: { equals: creator } } });
  return (r.results || [])[0] || null;
}

export async function finishConnect({ code, state }) {
  const [creator, sig] = String(state || '').split('|');
  if (!creator || sig !== sign('state:' + creator)) throw new Error('The sign-in came back without a valid state. Start again from the connect link.');
  const tok = await google('https://oauth2.googleapis.com/token', { code, client_id: process.env.YT_CLIENT_ID, client_secret: process.env.YT_CLIENT_SECRET, redirect_uri: redirect(), grant_type: 'authorization_code' });
  if (!tok.refresh_token) throw new Error('Google did not return a long-term token. Remove the app at myaccount.google.com/permissions and connect again.');
  const ch = await api('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', tok.access_token);
  const c = (ch.items || [])[0];
  if (!c) throw new Error('That Google account has no YouTube channel. Sign in with the account that owns the channel (or pick the right brand account).');
  const now = new Date().toISOString();
  const props = { Creator: { title: rt(creator) }, Channel: { rich_text: rt(c.snippet?.title) }, 'Channel ID': { rich_text: rt(c.id) }, Token: { rich_text: rt(encrypt(tok.refresh_token)) }, 'Connected At': { date: { start: now } }, Subscribers: { number: Number(c.statistics?.subscriberCount || 0) } };
  const row = await rowFor(creator);
  if (row) await notion('PATCH', `/pages/${row.id}`, { properties: props });
  else await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: YT_DS }, properties: props });
  const snap = await refreshAudience(creator).catch((e) => ({ error: e.message }));
  return { creator, channel: c.snippet?.title, snap };
}

// ---------- the numbers ----------
const day = (d) => d.toISOString().slice(0, 10);
const AGE = { 'age13-17': '13–17', 'age18-24': '18–24', 'age25-34': '25–34', 'age35-44': '35–44', 'age45-54': '45–54', 'age55-64': '55–64', 'age65-': '65+' };
const country = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code); } catch { return code; } };

export async function refreshAudience(creator) {
  const row = await rowFor(creator);
  if (!row) throw new Error(`${creator} hasn't connected YouTube yet.`);
  const refresh = decrypt(readLong(row.properties?.Token));
  const { access_token: at } = await google('https://oauth2.googleapis.com/token', { client_id: process.env.YT_CLIENT_ID, client_secret: process.env.YT_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' });
  const end = new Date(Date.now() - 2 * 864e5); // YouTube Analytics lags about two days
  const start90 = new Date(end.getTime() - 89 * 864e5), start28 = new Date(end.getTime() - 27 * 864e5);
  const report = (q) => api(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: 'channel==MINE', ...q })}`, at);
  const [ag, geo, dev, tot, ch] = await Promise.all([
    report({ startDate: day(start90), endDate: day(end), metrics: 'viewerPercentage', dimensions: 'ageGroup,gender' }),
    report({ startDate: day(start90), endDate: day(end), metrics: 'views', dimensions: 'country', sort: '-views', maxResults: '10' }),
    report({ startDate: day(start90), endDate: day(end), metrics: 'views', dimensions: 'deviceType', sort: '-views' }),
    report({ startDate: day(start28), endDate: day(end), metrics: 'views,estimatedMinutesWatched,subscribersGained,averageViewDuration' }),
    api('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', at),
  ]);
  const ages = {}, gender = {};
  for (const [a, g, p] of ag.rows || []) { ages[AGE[a] || a] = (ages[AGE[a] || a] || 0) + p; gender[g] = (gender[g] || 0) + p; }
  const totalGeo = (geo.rows || []).reduce((s, r) => s + r[1], 0) || 1;
  const totalDev = (dev.rows || []).reduce((s, r) => s + r[1], 0) || 1;
  const t = (tot.rows || [])[0] || [];
  const c = (ch.items || [])[0] || {};
  const data = {
    channel: c.snippet?.title, subscribers: Number(c.statistics?.subscriberCount || 0), total_views: Number(c.statistics?.viewCount || 0),
    period: { audience: `${day(start90)} to ${day(end)}`, totals: `${day(start28)} to ${day(end)}` },
    last28: { views: t[0] || 0, watch_hours: Math.round((t[1] || 0) / 60), subscribers_gained: t[2] || 0, avg_view_seconds: Math.round(t[3] || 0) },
    age: Object.entries(ages).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    gender: Object.entries(gender).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    countries: (geo.rows || []).map(([k, v]) => [country(k), Math.round((v / totalGeo) * 1000) / 10]),
    devices: (dev.rows || []).map(([k, v]) => [String(k).toLowerCase(), Math.round((v / totalDev) * 1000) / 10]),
  };
  const text = audienceText(data);
  await notion('PATCH', `/pages/${row.id}`, { properties: { 'Updated At': { date: { start: new Date().toISOString() } }, Subscribers: { number: data.subscribers }, Channel: { rich_text: rt(data.channel) }, Audience: { rich_text: rtLong(text) }, 'Audience JSON': { rich_text: rtLong(JSON.stringify(data)) } } });
  return { ...data, text };
}

const pct = (xs, n = 4) => xs.slice(0, n).map(([k, v]) => `${k} ${v}%`).join(', ');
export function audienceText(d) {
  const g = Object.fromEntries(d.gender || []);
  return [
    `${d.channel} · ${Number(d.subscribers).toLocaleString('en-US')} subscribers`,
    `Last 28 days: ${Number(d.last28.views).toLocaleString('en-US')} views, ${Number(d.last28.watch_hours).toLocaleString('en-US')} watch hours, +${d.last28.subscribers_gained} subscribers`,
    `Gender (90 days): ${g.male != null ? `${g.male}% male` : ''}${g.female != null ? `, ${g.female}% female` : ''}`,
    `Top age groups: ${pct(d.age, 3)}`,
    `Top countries (views): ${pct(d.countries, 5)}`,
    `Devices: ${pct(d.devices, 3)}`,
  ].join('\n');
}

// The latest saved snapshot for every connected creator (no Google call)
export async function audiences() {
  const r = await notion('POST', `/data_sources/${YT_DS}/query`, { page_size: 50 }).catch(() => ({ results: [] }));
  return (r.results || []).map((p) => {
    let data = null; try { data = JSON.parse(readLong(p.properties?.['Audience JSON']) || 'null'); } catch { /* none yet */ }
    return { creator: plain(p.properties?.Creator), channel: plain(p.properties?.Channel), updated: plain(p.properties?.['Updated At']), text: readLong(p.properties?.Audience), data };
  });
}
export async function audienceFor(creator) {
  return (await audiences()).find((a) => String(a.creator).toLowerCase() === String(creator || '').toLowerCase()) || null;
}

// Heartbeat: refresh anyone whose numbers are older than 7 days
export async function refreshStale() {
  if (!ytReady()) return [];
  const done = [];
  for (const a of await audiences()) {
    if (a.updated && Date.now() - Date.parse(a.updated) < 7 * 864e5) continue;
    try { await refreshAudience(a.creator); done.push(a.creator); } catch (e) { done.push(`${a.creator} (failed: ${String(e.message).slice(0, 80)})`); }
  }
  return done;
}
