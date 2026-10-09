// Small Notion helper: query with paging and retries, flatten properties into plain values.
const NOTION_VERSION = '2025-09-03';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function notion(method, path, body) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch('https://api.notion.com/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + process.env.NOTION_TOKEN,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      // Notion says how long to back off on a rate limit; wait at least that long
      const after = Number(res.headers?.get?.('retry-after')) || 0;
      await sleep(Math.max(after * 1000, 800 * attempt));
      continue;
    }
    const text = await res.text();
    throw new Error(`Notion ${res.status}: ${text.slice(0, 300)}`);
  }
}

// Warm-instance cache so a few questions in a row don't re-read every board
const cache = new Map();
const CACHE_MS = 60 * 1000;

export function clearCache() { cache.clear(); }

export async function queryAll(ds, filter, { maxPages = 1000, useCache = true } = {}) {
  const key = ds + JSON.stringify(filter || {});
  const hit = cache.get(key);
  if (useCache && hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const rows = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const res = await notion('POST', `/data_sources/${ds}/query`, body);
    rows.push(...(res.results || []).filter((p) => !p.in_trash && !p.archived));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && rows.length < maxPages);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

export function plain(p) {
  if (!p) return null;
  switch (p.type) {
    case 'title': return (p.title || []).map((t) => t.plain_text).join('').trim() || null;
    case 'rich_text': return (p.rich_text || []).map((t) => t.plain_text).join('').trim() || null;
    case 'select': return p.select?.name || null;
    case 'status': return p.status?.name || null;
    case 'multi_select': return (p.multi_select || []).map((o) => o.name).join(', ') || null;
    case 'people': return (p.people || []).map((u) => u.name || '').join(', ') || null;
    case 'number': return p.number ?? null;
    case 'checkbox': return !!p.checkbox;
    case 'date': return p.date?.start || null;
    case 'url': return p.url || null;
    case 'email': return p.email || null;
    case 'phone_number': return p.phone_number || null;
    case 'files': return (p.files || []).length ? `${p.files.length} file(s)` : null;
    case 'relation': return (p.relation || []).length ? `${p.relation.length} linked` : null;
    case 'formula': {
      const f = p.formula || {};
      return f.string ?? f.number ?? f.boolean ?? f.date?.start ?? null;
    }
    case 'unique_id': return p.unique_id?.number != null ? `${p.unique_id.prefix ? p.unique_id.prefix + '-' : ''}${p.unique_id.number}` : null;
    case 'created_time': return p.created_time || null;
    case 'last_edited_time': return p.last_edited_time || null;
    default: return null;
  }
}

// Turn a page into { _id, _url, _created, <Prop>: value } dropping empty values
export function flatten(page) {
  const out = { _id: page.id, _url: page.url, _created: page.created_time, _edited: page.last_edited_time };
  for (const [name, p] of Object.entries(page.properties || {})) {
    const v = plain(p);
    if (v === null || v === '' || v === false) continue;
    out[name] = v;
  }
  return out;
}

export function titleOf(page) {
  for (const p of Object.values(page.properties || {})) if (p.type === 'title') return plain(p) || 'Untitled';
  return 'Untitled';
}
