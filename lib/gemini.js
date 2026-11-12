// Gemini fallback (Harsh, 13 Nov 2026). When the Anthropic API is out (spend limit or no credit), every AI call in the
// PM is sent to Google Gemini on its free tier instead, so brand emails keep being read. The PM speaks the Anthropic
// Messages format everywhere, so this file only translates: an Anthropic request goes in, and an Anthropic-shaped
// response comes out (text blocks, tool_use blocks, stop_reason, usage). Callers never know which model answered.
//   GEMINI_API_KEY   the key from aistudio.google.com (set in Vercel, never in code)
//   GEMINI_MODEL     optional, defaults to gemini-flash-latest
//   PM_AI_PROVIDER   "gemini" sends every call to Gemini even while Anthropic works (for testing)
// Gemini's free tier may use inputs to improve Google's models; Harsh accepted that trade-off on 13 Nov 2026.

export const geminiKey = () => (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
export const hasGemini = () => !!geminiKey();
export const GEMINI_MODEL = () => (process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
export const geminiFirst = () => /^gemini$/i.test(String(process.env.PM_AI_PROVIDER || '').trim()) && hasGemini();

// Gemini accepts an OpenAPI subset of JSON Schema, so drop what it rejects and turn ["string","null"] into nullable
const KEEP = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'propertyOrdering', 'title']);
export function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue;
    if (k === 'properties') o.properties = Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, cleanSchema(pv)]));
    else if (k === 'items' || k === 'anyOf') o[k] = cleanSchema(v);
    else if (k === 'type' && Array.isArray(v)) { const t = v.filter((x) => x !== 'null'); o.type = t[0] || 'string'; if (t.length < v.length) o.nullable = true; }
    else o[k] = v;
  }
  if (o.type === 'object' && o.properties && !Object.keys(o.properties).length) delete o.properties;
  if (o.enum) { o.enum = o.enum.map(String); o.type = 'string'; }
  if (Array.isArray(o.required) && o.properties) o.required = o.required.filter((r) => r in o.properties);
  return o;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n') : String(c ?? ''));

// Anthropic request -> Gemini generateContent body
export function toGemini(body = {}) {
  const names = {}; // tool_use id -> tool name, needed for Gemini's functionResponse
  const contents = [];
  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const parts = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if ((b.type === 'image' || b.type === 'document') && b.source?.type === 'base64') parts.push({ inlineData: { mimeType: b.source.media_type || (b.type === 'document' ? 'application/pdf' : 'image/jpeg'), data: b.source.data } });
      else if ((b.type === 'image' || b.type === 'document') && b.source?.type === 'text') parts.push({ text: b.source.data });
      else if (b.type === 'tool_use') { names[b.id] = b.name; parts.push({ functionCall: { name: b.name, args: b.input || {} } }); }
      else if (b.type === 'tool_result') parts.push({ functionResponse: { name: names[b.tool_use_id] || 'tool', response: { content: textOf(b.content), ...(b.is_error ? { error: true } : {}) } } });
    }
    if (!parts.length) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); // Gemini wants turns to alternate
    else contents.push({ role, parts });
  }
  const sys = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text || '').filter(Boolean).join('\n\n') : '';
  const out = {
    contents,
    generationConfig: { maxOutputTokens: Math.max(1024, Number(body.max_tokens) || 1024), ...(body.temperature != null ? { temperature: body.temperature } : {}), thinkingConfig: { thinkingBudget: 0 } },
  };
  if (sys) out.systemInstruction = { parts: [{ text: sys }] };
  if (body.tools?.length) {
    out.tools = [{ functionDeclarations: body.tools.map((t) => ({ name: t.name, description: String(t.description || t.name).slice(0, 4000), parameters: cleanSchema(t.input_schema || { type: 'object' }) })) }];
    const tc = body.tool_choice;
    out.toolConfig = { functionCallingConfig: tc?.type === 'tool' ? { mode: 'ANY', allowedFunctionNames: [tc.name] } : tc?.type === 'any' ? { mode: 'ANY' } : { mode: 'AUTO' } };
  }
  return out;
}

// Gemini response -> Anthropic response
export function fromGemini(json = {}, model = GEMINI_MODEL()) {
  const cand = (json.candidates || [])[0] || {};
  const content = [];
  let n = 0;
  for (const p of cand.content?.parts || []) {
    if (p.thought) continue;
    if (p.functionCall) content.push({ type: 'tool_use', id: `toolu_gem_${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {} });
    else if (p.text) {
      const prev = content[content.length - 1];
      if (prev?.type === 'text') prev.text += p.text; else content.push({ type: 'text', text: p.text });
    }
  }
  const u = json.usageMetadata || {};
  return {
    id: json.responseId || `gem_${Date.now()}`, type: 'message', role: 'assistant', model, provider: 'gemini', content,
    stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: u.promptTokenCount || 0, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
  };
}

async function post(model, payload) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey() }, body: JSON.stringify(payload),
  });
}

// Send an Anthropic-format request to Gemini and get an Anthropic-format response back
export async function gemini(body) {
  if (!hasGemini()) throw new Error('Gemini fallback is not set up (GEMINI_API_KEY missing in Vercel)');
  const model = GEMINI_MODEL();
  const payload = toGemini(body);
  let res = await post(model, payload);
  if (res.status === 400) {
    // Some Gemini models refuse a zero thinking budget: retry with thinking on and more room for it
    const text = await res.text();
    if (!/thinking/i.test(text)) throw new Error(`Gemini 400: ${text.slice(0, 300)}`);
    delete payload.generationConfig.thinkingConfig;
    payload.generationConfig.maxOutputTokens = Math.max(payload.generationConfig.maxOutputTokens * 4, 4096);
    res = await post(model, payload);
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const out = fromGemini(await res.json(), model);
  if (!out.content.length) throw new Error('Gemini returned an empty answer');
  return out;
}
