// GET /api/health — shows which Anthropic key this deployment is really using (never the full key)
// and tests it with a free request, so key problems are easy to spot.
export default async function handler(req, res) {
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
