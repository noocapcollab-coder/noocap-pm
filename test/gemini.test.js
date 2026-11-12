import test from 'node:test';
import assert from 'node:assert/strict';
import { toGemini, fromGemini, cleanSchema } from '../lib/gemini.js';
import { callCost } from '../lib/aispend.js';

test('Anthropic request becomes a Gemini request', () => {
  const g = toGemini({
    model: 'claude-haiku', max_tokens: 400, system: [{ type: 'text', text: 'You are the PM', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'classify', description: 'd', input_schema: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['a', 'b'] }, n: { type: ['number', 'null'] } }, required: ['kind', 'gone'] } }],
    tool_choice: { type: 'tool', name: 'classify' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'find_brand', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":1}' }] },
    ],
  });
  assert.equal(g.systemInstruction.parts[0].text, 'You are the PM');
  assert.deepEqual(g.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['classify'] });
  const p = g.tools[0].functionDeclarations[0].parameters;
  assert.equal(p.additionalProperties, undefined);
  assert.deepEqual(p.required, ['kind']);
  assert.equal(p.properties.n.type, 'number'); assert.equal(p.properties.n.nullable, true);
  assert.equal(g.contents.length, 3);
  assert.equal(g.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(g.contents[1].role, 'model');
  assert.equal(g.contents[2].parts[0].functionResponse.name, 'find_brand');
});

test('Gemini response comes back in Anthropic shape', () => {
  const a = fromGemini({ candidates: [{ content: { parts: [{ text: 'Sure' }, { functionCall: { name: 'classify', args: { kind: 'a' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }, 'gemini-flash-latest');
  assert.equal(a.stop_reason, 'tool_use');
  assert.equal(a.content[0].text, 'Sure');
  assert.deepEqual(a.content[1].input, { kind: 'a' });
  assert.ok(a.content[1].id);
  assert.equal(a.usage.input_tokens, 10);
  const t = fromGemini({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'MAX_TOKENS' }] });
  assert.equal(t.content[0].text, 'ab'); assert.equal(t.stop_reason, 'max_tokens');
});

test('enums become strings and Gemini costs nothing', () => {
  assert.deepEqual(cleanSchema({ type: 'integer', enum: [1, 2] }), { type: 'string', enum: ['1', '2'] });
  assert.equal(callCost('gemini-flash-latest', { input_tokens: 1e6, output_tokens: 1e6 }), 0);
});
