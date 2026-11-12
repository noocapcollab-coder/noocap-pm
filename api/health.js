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
    payment_keys_secret: process.env.PAYMENT_KEYS_SECRET ? (process.env.PAYMENT_KEYS_SECRET.length >= 16 ? 'set' : 'too short') : 'missing',
    pm_password_set: !!process.env.PM_PASSWORD, cron_secret_set: !!process.env.CRON_SECRET, boards_key_set: !!process.env.BOARDS_KEY,
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
  // ?gemini=1 runs one tiny tool call through the Gemini fallback, the same path brand emails take when Claude is out
  const G = await import('../lib/gemini.js');
  out.gemini = { key_set: G.hasGemini(), model: G.GEMINI_MODEL(), forced: G.geminiFirst() };
  if (G.hasGemini() && req.query?.gemini) {
    try {
      const r = await G.gemini({ max_tokens: 200, tools: [{ name: 'record', description: 'Record the brand', input_schema: { type: 'object', properties: { brand: { type: 'string' }, price: { type: ['number', 'null'] } }, required: ['brand'] } }], tool_choice: { type: 'tool', name: 'record' },
        messages: [{ role: 'user', content: 'Email: "Hi, Lemlist here, we would love a reel with Valeri for $1,500." Record it.' }] });
      const call = r.content.find((c) => c.type === 'tool_use');
      out.gemini.test = call ? `OK: ${JSON.stringify(call.input)}` : `answered without the tool: ${JSON.stringify(r.content).slice(0, 200)}`;
    } catch (e) { out.gemini.test = 'FAILED: ' + String(e.message).slice(0, 300); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
