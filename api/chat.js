// Ask the PM · POST /api/chat
// Body: { messages: [{ role: 'user'|'assistant', content: '...' }], channel?: 'dashboard'|'whatsapp'|'discord' }
// Header: x-pm-key: <PM_PASSWORD> (only needed if PM_PASSWORD is set in Vercel)
// Returns: { reply, usage: { input, output, cost_usd }, tools_used: [...] }
import { TOOL_DEFS, runTool, todayIST, DS } from '../lib/tools.js';
import { notion } from '../lib/notion.js';

const MODEL = process.env.PM_MODEL || 'claude-sonnet-5';
// USD per million tokens. Check console.anthropic.com pricing and adjust if needed.
const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
const MAX_TURNS = 8;

const SYSTEM = `You are the NOOCAP PM, the AI project manager for NOOCAP Media, an AI content agency in Mumbai run by Harsh Koli (COO) and Pratham (CEO).
You answer questions from Harsh and Pratham about the whole agency using your tools, which read live Notion data.

What you know about the agency:
- Creators (clients): Brad, Chris, Lindsay, Emtech, Duncan, Valeri (also spelled Valerie), David Iya, Nicole. Dymtro and Jonathan appear in older revenue rows.
- Editors: Abhishek, Prateek, Sumith, Prabal, Parvez. Scriptwriter: Shreya.
- Video flow on each creator board: 1 Idea Assigned, 2 Waiting for Brief, 3 Transcript, 4 Script Draft, 5 Script Approval, 6 To Film, 7 In Edit, 8 Changes, 9 Approval, 10 To Post, 11 Ready, 12 Posted, 13 Repost / Archive. Collapsed stages: 1-5 Scripting, 6 Filming, 7 Editing, 8-9 Review, 10-11 Ready, 12 Posted.
- Editors submit finished videos through the Video Intake form, which means "ready for review". Harsh approves videos and requests changes by changing the status in Notion.
- Brand deals are negotiated in each creator's own inbox; noocapcollab (the team mailbox) is CC'd once a deal is approved and handles production emails. Creators send NOOCAP their invoice and NOOCAP forwards it to the brand.
- NOOCAP earns a percentage cut of each sponsor deal, set per creator in the Creator Cut table.

How to answer:
- Always call a tool for facts. Never guess numbers, names, dates or statuses, and never do arithmetic yourself: quote the totals the tools return. If you need a figure the tools do not give, say so.
- If data is missing or a tool errors, say that plainly and say where in Notion it should be filled in.
- Money is in USD unless the data says otherwise. Dates are in India time (IST).
- Be brief and direct, like a sharp ops manager messaging the founder. Lead with the answer, then the few details that matter. Use short bullet lists for several items and bold only the key numbers.
- You can only read. You cannot send emails, change Notion or message anyone yet. If asked to act, say what should be done and by whom.
- Writing style rules, always: never stack three parallel items for rhythm, never use "it's not X, it's Y" contrasts, and never write chains of short choppy fragments. Write in flowing sentences joined with and, but, so, which, because.`;

function checkAuth(req) {
  const want = process.env.PM_PASSWORD;
  if (!want) return true; // no password set in Vercel = open chat
  const got = req.headers['x-pm-key'] || '';
  return got.length === want.length && got === want;
}

async function callClaude(messages, channel) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: [
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `Today is ${todayIST()} (IST). Channel: ${channel}.${channel === 'whatsapp' ? ' Keep it short and use WhatsApp formatting: *bold*, no markdown headers or tables.' : ''}` },
      ],
      tools: TOOL_DEFS.map((t, i) => (i === TOOL_DEFS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)),
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function logChat({ question, reply, usage, cost, channel, tools, error }) {
  try {
    const rt = (s) => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];
    await notion('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id: DS.agentLog },
      properties: {
        Event: { title: rt('Chat: ' + question.slice(0, 90)) },
        Time: { date: { start: new Date().toISOString() } },
        Area: { select: { name: 'System' } },
        Outcome: { select: { name: error ? 'Error' : 'AI used' } },
        Source: { select: { name: channel === 'whatsapp' ? 'WhatsApp' : channel === 'discord' ? 'Discord' : 'Dashboard chat' } },
        Model: { select: { name: 'Sonnet' } },
        'Tokens In': { number: usage.input + usage.cacheWrite + usage.cacheRead },
        'Tokens Out': { number: usage.output },
        'Cost USD': { number: cost },
        Rule: { rich_text: rt(tools.length ? 'Tools: ' + tools.join(', ') : 'No tools') },
        Details: { rich_text: rt(error ? 'Error: ' + error : 'Q: ' + question + '\nA: ' + reply) },
      },
    });
  } catch (e) {
    console.error('AGENT LOG write failed', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const channel = ['whatsapp', 'discord'].includes(body.channel) ? body.channel : 'dashboard';
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'Send at least one user message' });
  const question = history[history.length - 1].content;

  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const toolsUsed = [];
  const messages = [...history];
  let reply = '';
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const out = await callClaude(messages, channel);
      const u = out.usage || {};
      usage.input += u.input_tokens || 0;
      usage.output += u.output_tokens || 0;
      usage.cacheWrite += u.cache_creation_input_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0;
      messages.push({ role: 'assistant', content: out.content });
      const calls = (out.content || []).filter((c) => c.type === 'tool_use');
      if (out.stop_reason !== 'tool_use' || !calls.length) {
        reply = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
        break;
      }
      const results = await Promise.all(calls.map(async (c) => {
        toolsUsed.push(c.name);
        const data = await runTool(c.name, c.input);
        return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(data).slice(0, 60000) };
      }));
      messages.push({ role: 'user', content: results });
    }
    if (!reply) reply = 'I ran out of steps before finishing that one. Try asking a narrower question.';
  } catch (e) {
    const cost = 0;
    await logChat({ question, reply: '', usage, cost, channel, tools: toolsUsed, error: e.message });
    return res.status(502).json({ error: e.message });
  }

  const cost = Math.round(((usage.input * PRICE.input + usage.output * PRICE.output + usage.cacheWrite * PRICE.cacheWrite + usage.cacheRead * PRICE.cacheRead) / 1e6) * 10000) / 10000;
  await logChat({ question, reply, usage, cost, channel, tools: toolsUsed });
  return res.status(200).json({ reply, usage: { input: usage.input + usage.cacheWrite + usage.cacheRead, output: usage.output, cost_usd: cost }, tools_used: [...new Set(toolsUsed)] });
}
