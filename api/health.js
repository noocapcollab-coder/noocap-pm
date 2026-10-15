// GET /api/health — shows which Anthropic key this deployment is really using (never the full key)
// and tests it with a free request, so key problems are easy to spot.
export default async function handler(req, res) {
  // YouTube connect (/youtube/connect and /youtube/callback are rewritten here): the creator signs in with Google once
  if (req.query?.yt) {
    const Y = await import('../lib/youtube.js');
    const page = (title, body) => { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui;background:#0f1115;color:#e8e8ea;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:520px;padding:28px;border:1px solid #2a2d35;border-radius:14px;background:#16181d"><h2 style="margin-top:0">${title}</h2>${body}</div>`); };
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    try {
      if (req.query.yt === 'connect') { res.setHeader('Location', Y.startConnect({ creator: req.query.creator, k: req.query.k })); return res.status(302).end(); }
      if (req.query.yt === 'callback') {
        if (req.query.error) return page('Not connected', `<p>Google said: ${esc(req.query.error)}. Nothing was shared. You can close this tab.</p>`);
        const r = await Y.finishConnect({ code: req.query.code, state: req.query.state });
        return page('YouTube connected ✓', `<p><b>${esc(r.channel)}</b> is now connected to the NOOCAP PM for ${esc(r.creator)}. The PM can only read audience analytics, nothing else, and you can remove access any time at myaccount.google.com/permissions.</p>${r.snap?.text ? `<pre style="white-space:pre-wrap;background:#0f1115;padding:12px;border-radius:8px">${esc(r.snap.text)}</pre>` : r.snap?.error ? `<p>Connected, but the first numbers failed: ${esc(r.snap.error)}</p>` : ''}<p>You can close this tab.</p>`);
      }
    } catch (e) { return page('Could not connect', `<p>${esc(e.message)}</p>`); }
    return res.status(404).send('Unknown');
  }
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const key = raw.trim().replace(/^["']|["']$/g, '');
  const kind = key.startsWith('sk-ant-api') ? 'normal API key (correct type)'
    : key.startsWith('sk-ant-admin') ? 'ADMIN key (wrong type, cannot chat)'
    : key.startsWith('sk-ant-oat') ? 'Claude Code / subscription token (wrong type)'
    : key ? 'unknown format' : 'MISSING';
  const out = {
    vercel_environment: process.env.VERCEL_ENV || 'unknown',
    deployed_commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown',
    anthropic_key: {
      type: kind,
      starts_with: key.slice(0, 12),
      ends_with: key.slice(-4),
      length: key.length,
      had_spaces_or_quotes: raw !== key,
    },
    workspace_id_set: !!process.env.ANTHROPIC_WORKSPACE_ID,
    notion_token_set: !!process.env.NOTION_TOKEN,
  };
  if (key) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {}),
        },
      });
      const body = await r.json().catch(() => ({}));
      out.anthropic_test = r.ok ? 'OK, Anthropic accepts this key' : `FAILED ${r.status}: ${body?.error?.message || 'unknown error'}`;
    } catch (e) {
      out.anthropic_test = 'Could not reach Anthropic: ' + e.message;
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
