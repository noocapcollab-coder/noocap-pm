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
// The test bank runs inside freeOnly.run(true, ...): every AI call it makes goes to Gemini's free tier when a key is
// set, so running the whole bank after each change costs nothing (Harsh: no extra API spend). Scoped per call chain,
// so a brand email read at the same moment in the same server still goes to Claude.
import { AsyncLocalStorage } from 'node:async_hooks';
export const freeOnly = new AsyncLocalStorage();
export const geminiFirst = () => (/^gemini$/i.test(String(process.env.PM_AI_PROVIDER || '').trim()) || !!freeOnly.getStore()) && hasGemini();

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
      else if (b.type === 'tool_use') { names[b.id] = b.name; parts.push({ functionCall: { name: b.name, args: b.input || {} }, ...(b._gsig ? { thoughtSignature: b._gsig } : {}) }); }
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
    // Newer Gemini models think before answering and count that against the output limit, and they reject a zero
    // thinking budget, so leave thinking on and give it room
    generationConfig: { maxOutputTokens: Math.max(4096, (Number(body.max_tokens) || 1024) * 4), ...(body.temperature != null ? { temperature: body.temperature } : {}) },
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
    // thoughtSignature must go back to Gemini with the call in the next turn (multi-step Ask PM chats)
    if (p.functionCall) content.push({ type: 'tool_use', id: `toolu_gem_${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { _gsig: p.thoughtSignature } : {}) });
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

// A model that hangs (high demand) gets 50 seconds, then the next model is tried, so one slow call never eats the run
async function post(model, payload) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey() }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(50000),
  });
}

// Busy models (503 "high demand") and per-model free quotas (429) are common on the free tier, so try the next model
// Each model has its own free daily quota, so a longer chain means more free requests per day
export const MODEL_CHAIN = () => [...new Set([GEMINI_MODEL(), 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash'])];

// Send an Anthropic-format request to Gemini and get an Anthropic-format response back
export async function gemini(body) {
  if (!hasGemini()) throw new Error('Gemini fallback is not set up (GEMINI_API_KEY missing in Vercel)');
  const payload = toGemini(body);
  let last = '';
  for (const model of MODEL_CHAIN()) {
    let res;
    try { res = await post(model, payload); } catch (e) { last = `Gemini (${model}): ${String(e.message || e).slice(0, 150)}`; continue; }
    if (res.ok) {
      const out = fromGemini(await res.json(), model);
      if (out.content.length) return out;
      last = `${model}: empty answer`;
      continue;
    }
    last = `Gemini ${res.status} (${model}): ${(await res.text()).slice(0, 250)}`;
    if (![429, 500, 503, 504].includes(res.status)) break; // a bad request will fail on every model
  }
  if (/ 429 /.test(last)) quotaAlert(last);
  throw new Error(last);
}

// Every model in the chain is out of free quota: tell Harsh once (discord() dedupes the same headline for 12 hours)
async function quotaAlert(err) {
  try {
    const { discord } = await import('./briefs.js');
    await discord(`⚠️ **Gemini free quota used up for today: brand emails are waiting**\nClaude is also unavailable, so emails stay unread until the Gemini quota resets (about 1:30 PM IST) or Claude is back. Last error: ${String(err).replace(/\s+/g, ' ').slice(0, 160)}`, 'pm');
  } catch { /* best effort */ }
}
