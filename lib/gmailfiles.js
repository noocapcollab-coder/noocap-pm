// Attachments too big for n8n to pass along (Vercel takes at most 4.5 MB per request) arrive with only their name and
// size. The PM fetches them from the noocapcollab Gmail itself, through the n8n "PM · Drive" workflow (read-only Gmail
// message and attachment calls), so a brief PDF still lands on the card and reaches the script writer (Emergent x Chris,
// Nov 19).
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/';
const MAX = 15 * 1024 * 1024;

async function gmailGet(path) {
  const hook = process.env.N8N_DRIVE_WEBHOOK;
  if (!hook) throw new Error('N8N_DRIVE_WEBHOOK is not set');
  const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hook-secret': process.env.PM_HOOK_SECRET || '' }, body: JSON.stringify({ method: 'GET', url: GMAIL + path }) });
  let j = {};
  try { j = await res.json(); } catch { /* empty */ }
  if (!res.ok || j.ok === false) throw new Error('Gmail: ' + (j.error || `n8n returned ${res.status}`));
  return j.data ?? j;
}

export function partsWithFiles(payload, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) out.push({ filename: payload.filename, mimeType: payload.mimeType || '', size: payload.body.size || 0, attachmentId: payload.body.attachmentId });
  for (const p of payload.parts || []) partsWithFiles(p, out);
  return out;
}

export const needsFetch = (a) => a && !a.data && a.filename && (!a.size || a.size <= MAX);

// Fills in .data for attachments that came without it. Never throws: a file it can't get stays as it was.
export async function hydrateAttachments(email) {
  const missing = (email?.attachments || []).filter(needsFetch);
  if (!missing.length || !email.gmailId) return email;
  try {
    const msg = await gmailGet(`${encodeURIComponent(email.gmailId)}?format=full`);
    const parts = partsWithFiles(msg.payload);
    for (const a of missing) {
      const p = parts.find((x) => x.filename === a.filename) || parts.find((x) => x.filename.toLowerCase() === String(a.filename).toLowerCase());
      if (!p) continue;
      try {
        const r = await gmailGet(`${encodeURIComponent(email.gmailId)}/attachments/${encodeURIComponent(p.attachmentId)}`);
        if (r?.data) { a.data = Buffer.from(String(r.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64'); a.mimeType = a.mimeType || p.mimeType; a.fetched = true; }
      } catch (e) { console.error('attachment fetch', a.filename, e.message); }
    }
  } catch (e) { console.error('gmail message fetch', e.message); }
  return email;
}

// Brief documents (PDF, Word, slides) the brand attached in this thread over the last `hours`, fetched from Gmail. Used
// when a brief update has no file of its own: the brief PDF came in an earlier email that was held, so it never reached
// the card (Emergent x Chris, Nov 19). `skip` filters out contracts, invoices and the like.
export async function threadBriefFiles(threadId, { hours = 48, skip = /contract|agreement|invoice|receipt|w-?9|nda/i, limit = 2 } = {}) {
  if (!threadId) return [];
  try {
    const hook = process.env.N8N_DRIVE_WEBHOOK;
    if (!hook) return [];
    const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hook-secret': process.env.PM_HOOK_SECRET || '' }, body: JSON.stringify({ method: 'GET', url: `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full` }) });
    const j = await res.json().catch(() => ({}));
    const msgs = (j.data || j).messages || [];
    const since = Date.now() - hours * 36e5;
    const out = [];
    for (const m of msgs.slice().reverse()) {
      if (Number(m.internalDate || 0) < since) continue;
      const from = ((m.payload?.headers || []).find((h) => /^from$/i.test(h.name)) || {}).value || '';
      if (/noocap/i.test(from)) continue;
      for (const p of partsWithFiles(m.payload)) {
        if (out.length >= limit || skip.test(p.filename) || !/\.(pdf|docx?|pptx?)$/i.test(p.filename) || out.some((o) => o.filename === p.filename)) continue;
        const a = { filename: p.filename, mimeType: p.mimeType, size: p.size };
        await hydrateAttachments({ gmailId: m.id, attachments: [a] });
        if (a.data) out.push(a);
      }
    }
    return out;
  } catch (e) { console.error('thread brief files', e.message); return []; }
}
