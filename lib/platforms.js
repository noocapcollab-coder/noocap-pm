// Where a brand video gets posted (Harsh, Nov 26: "brands mention the platforms and I don't know where the video needs
// to go"). Every deal carries a "Platforms" multi-select on the Brand Deals page: Instagram, TikTok, YouTube Shorts,
// YouTube, Facebook, LinkedIn, X, Newsletter, or "All platforms" when the brand asked for everywhere.
// Filled from the brief when the deal is made, and every hour for open deals that still have none, from the
// deliverables, the deal memory (the brand's emails, summarised) and the lead the deal came from. A value Harsh or the
// PM already set is never overwritten.
import { notion, plain, queryAll } from './notion.js';
import { DS } from './tools.js';

export const PLATFORM_OPTIONS = ['Instagram', 'TikTok', 'YouTube Shorts', 'YouTube', 'Facebook', 'LinkedIn', 'X', 'Newsletter', 'All platforms'];

const RULES = [
  ['All platforms', /\ball (?:social |the |your |of your )?(?:platforms|channels|socials)\b|\bevery (?:platform|channel)\b|\bcross[- ]?post(?:ed|ing)? (?:on|to|across) all\b|\beverywhere\b/i],
  ['Instagram', /\binstagram\b|\bIG\b|\binsta\b|\breels?\b/i],
  ['TikTok', /\btik\s?tok\b|\btt\b/i],
  ['YouTube Shorts', /\b(?:youtube|yt)\s*shorts?\b|\bshorts\b/i],
  ['YouTube', /\byoutube\b(?!\s*shorts?)|\byt\b(?!\s*shorts?)/i],
  ['Facebook', /\b(?:[Ff]acebook|FACEBOOK|FB)\b/],
  ['LinkedIn', /\blinked\s?in\b/i],
  ['X', /\btwitter\b|\b(?:on|to) X\b|\bX \(twitter\)/],
  ['Newsletter', /\bnewsletter\b/i],
];

// Pure. "1 IG reel + TikTok cross-post, no YouTube" -> ['Instagram', 'TikTok']
export function platformsFromText(text) {
  const t = String(text || '').replace(/\b(?:no|not|without|except|excluding|apart from)\s+(?:on\s+|a\s+|any\s+)?(tik\s?tok|youtube(?:\s+shorts?)?|instagram|ig|facebook|linkedin|twitter|newsletter|shorts)\b/gi, '');
  const found = RULES.filter(([, re]) => re.test(t)).map(([n]) => n);
  return found.includes('All platforms') ? ['All platforms'] : found;
}

const LIVE = ['Paid', 'Lost'];

// Hourly: open deals with no Platforms yet. dry=true only reports.
export async function fillDealPlatforms({ dry = false } = {}) {
  const [deals, leads] = await Promise.all([
    queryAll(DS.deals, undefined, { useCache: false }),
    queryAll(DS.leads, { property: 'Platforms', multi_select: { is_not_empty: true } }, { useCache: false }).catch(() => []),
  ]);
  if (!deals.length || !deals[0].properties?.Platforms) return [];
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const leadPlats = new Map();
  for (const l of leads) {
    const k = key(plain(l.properties?.Brand)) + '|' + key(plain(l.properties?.Creator));
    const v = (l.properties?.Platforms?.multi_select || []).map((s) => s.name).filter((n) => PLATFORM_OPTIONS.includes(n) || n === 'YouTube Shorts');
    if (v.length && !leadPlats.has(k)) leadPlats.set(k, v);
  }
  const out = [];
  for (const p of deals) {
    const pr = p.properties || {};
    if ((pr.Platforms?.multi_select || []).length) continue;
    if (LIVE.includes(plain(pr['Deal Stage']))) continue;
    const brand = plain(pr['Brand Name']), creator = plain(pr.Creator);
    const text = [plain(pr.Deliverables), plain(pr['Deal Memory']), plain(pr['Agent Notes']), plain(pr.Notes)].join('\n');
    let plats = platformsFromText(text);
    if (!plats.length) plats = leadPlats.get(key(brand) + '|' + key(creator)) || [];
    if (!plats.length) continue;
    out.push(`${brand} × ${creator}: ${plats.join(', ')}`);
    if (!dry) await notion('PATCH', `/pages/${p.id}`, { properties: { Platforms: { multi_select: plats.map((name) => ({ name })) } } }).catch(() => out.pop());
  }
  return out;
}

// Brands that want UGC (Harsh, Nov 27: "sort our brand deals by the brands that want UGC"). UGC = content made for the
// brand to run as its own ads or post on its own channels, rather than (or as well as) a post on the creator's account.
// "Wants UGC" is ticked every hour from the deliverables, the deal memory (the brand's emails, summarised) and the
// notes. It is only ever ticked, never cleared, so a tick Harsh adds by hand stays.
export function wantsUgc(text) {
  const t = String(text || '');
  if (/\b(no|not|without)\s+(any\s+)?UGC\b/i.test(t)) return false;
  return /\bUGC\b|user[- ]generated (content|videos?)|\bad creatives?\b|\b(for|in|as) (our|their) (paid |own )?(ads|ad campaigns|advertising)\b|\braw (footage|video) for (our|their) ads\b|\bnot (be )?posted on (your|the creator'?s|his|her) (account|channel|page)\b/i.test(t);
}

export async function fillDealUgc({ dry = false } = {}) {
  const deals = await queryAll(DS.deals, undefined, { useCache: false });
  if (!deals.length || !deals[0].properties?.['Wants UGC']) return [];
  const out = [];
  for (const p of deals) {
    const pr = p.properties || {};
    if (pr['Wants UGC']?.checkbox) continue;
    const text = [plain(pr.Deliverables), plain(pr['Deal Memory']), plain(pr['Agent Notes']), plain(pr.Notes)].join('\n');
    if (!wantsUgc(text)) continue;
    out.push(`${plain(pr['Brand Name'])} × ${plain(pr.Creator)}`);
    if (!dry) await notion('PATCH', `/pages/${p.id}`, { properties: { 'Wants UGC': { checkbox: true } } }).catch(() => out.pop());
  }
  // The leads too (the creators' own inboxes), only the ones not ticked yet
  const leads = await queryAll(DS.leads, { property: 'Wants UGC', checkbox: { equals: false } }, { useCache: false }).catch(() => []);
  for (const p of leads) {
    const pr = p.properties || {};
    const text = [plain(pr.Offer), plain(pr.Deliverables), plain(pr['Thread Text']), plain(pr.Notes), plain(pr['Next Step'])].join('\n');
    if (!wantsUgc(text)) continue;
    out.push(`lead ${plain(pr.Brand)} × ${plain(pr.Creator)}`);
    if (!dry) await notion('PATCH', `/pages/${p.id}`, { properties: { 'Wants UGC': { checkbox: true } } }).catch(() => out.pop());
  }
  return out;
}
