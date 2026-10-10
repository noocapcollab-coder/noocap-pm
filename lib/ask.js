// The PM chat brain (used by POST /api/chat and the WhatsApp webhook)
// Body: { messages: [{ role: 'user'|'assistant', content: '...' }], channel?: 'dashboard'|'whatsapp'|'discord' }
// Header: x-pm-key: <PM_PASSWORD> (only needed if PM_PASSWORD is set in Vercel)
// Returns: { reply, usage: { input, output, cost_usd }, tools_used: [...], model }
// Tip: start a message with "deep:" to force the stronger model.
import { TOOL_DEFS, runTool, todayIST, DS, loadMemory, memoryBlock } from './tools.js';
import { buildSnapshot } from './snapshot.js';
import { notion, clearCache } from './notion.js';
import { proposeUpdate, proposeCreate, executeProposal, PROPOSE_TOOL, CREATE_TOOL } from './actions.js';
import { createDraft } from './outbox.js';
import { openDeals } from './briefs.js';

const DRAFT_TOOL = {
  name: 'draft_email',
  description: 'Put an email to a brand into the Approvals tab (PM OUTBOX). You write the subject and body; it is only sent after Harsh taps Send in Approvals. Use for any email the user wants sent to a brand about a deal. attach "Script PDF" makes a PDF of the script from the linked video page; "Invoice" attaches the deal\'s Invoice File.',
  input_schema: {
    type: 'object',
    properties: {
      brand: { type: 'string', description: 'Brand name of the deal' },
      creator: { type: 'string' },
      kind: { type: 'string', enum: ['Script', 'Follow-up', 'Posted links', 'Invoice', 'Payment chase', 'Reply', 'Counter', 'Other'], description: 'For a creator-inbox lead use Follow-up, Counter (a new price) or Reply' },
      price: { type: 'number', description: 'For a creator-inbox lead: the USD price this email offers, if any (it must also be written in the body)' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Full email body with greeting and sign-off "Best,\\n{Creator}\'s Team" (no personal names)' },
      attach: { type: 'string', enum: ['None', 'Script PDF', 'Invoice'] },
      to: { type: 'string', description: 'Only if different from the deal\'s Brand Email' },
    },
    required: ['brand', 'kind', 'subject', 'body'],
  },
};

async function draftFromChat(input) {
  const deals = await openDeals();
  const b = String(input.brand || '').toLowerCase();
  let hits = deals.filter((d) => d.brand.toLowerCase().includes(b));
  if (input.creator) hits = hits.filter((d) => String(d.creator || '').toLowerCase().startsWith(String(input.creator).toLowerCase().slice(0, 4)));
  if (!hits.length) {
    // Not a brand deal: maybe a creator-inbox lead (Chris's negotiations), including lost ones
    const L = await import('./leads.js');
    const kind = { 'Follow-up': 'Lead follow-up', Other: 'Reply' }[input.kind] || input.kind;
    const r = await L.draftForLead({ brand: input.brand, creator: input.creator, kind, subject: input.subject, body: input.body, price: input.price });
    if (!r.not_found) return r;
    return { error: `No brand deal or creator-inbox lead found for "${input.brand}". Try find_brand with another spelling.` };
  }
  if (hits.length > 1) return { needs_choice: true, matches: hits.map((d) => `${d.brand} × ${d.creator}`) };
  const deal = hits[0];
  const r = await createDraft({ kind: input.kind, deal, subject: input.subject, body: input.body, to: input.to, attach: input.attach || 'None', video: deal.linkedVideo, why: 'Drafted from chat', notify: false });
  if (r.skipped) return { error: 'A draft of this kind for this deal is already waiting in Approvals. Edit that one instead.' };
  return { drafted: true, to: input.to || deal.brandEmail || '(no brand email on the deal, add it in Approvals)', note_for_you: 'Tell the user it is waiting in the Approvals tab (📬 at the top). It is NOT sent.' };
}
import { saveChat } from './chats.js';

// Pass a brand's script notes (or a doc link with their comments) to the script writer: the same ping, card note and
// "Shreya revising" step the inbox does on its own. Used when an email slipped past, e.g. "send Zeely's comments to Shreya".
const SCRIPT_NOTES_TOOL = {
  name: 'send_script_notes',
  description: 'Send a brand\'s script feedback to the script writer (Shreya) on Discord, add it to the video card and move the card back to Script Draft. Use when the user asks to pass script comments/notes/feedback to the script writer. Put the exact notes, or the doc link where the comments are, in notes. Never include rates or money.',
  input_schema: {
    type: 'object',
    properties: {
      brand: { type: 'string' },
      creator: { type: 'string' },
      notes: { type: 'string', description: 'The feedback itself, or "The brand left comments in this doc: <link>" plus anything they said (e.g. filming can start after)' },
    },
    required: ['brand', 'notes'],
  },
};

// Two models: Haiku (cheap) for everyday lookups, Sonnet (stronger) for questions that need thinking.
const MODELS = {
  Haiku: { id: process.env.PM_MODEL_FAST || 'claude-haiku-4-5-20251001', price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  Sonnet: { id: process.env.PM_MODEL_SMART || 'claude-sonnet-5', price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
};
// USD per million tokens. Check console.anthropic.com pricing and adjust if needed.
const MAX_TURNS = 8;
const ALL_TOOLS = [...TOOL_DEFS, DRAFT_TOOL, SCRIPT_NOTES_TOOL, CREATE_TOOL, PROPOSE_TOOL];

// Small talk gets an instant free reply, no AI call at all
const SMALL_TALK = [
  { re: /^(hi+|hey+|hello+|yo|hii+|good (morning|afternoon|evening)|gm)\b[\s!.]*$/i, reply: 'Hey 👋' },
  { re: /^(thanks?|thank you|thx|ty|cool|great|nice|perfect|awesome|ok+|okay+|k|got it|done|👍|🙏)[\s!.]*$/i, reply: '👍' },
  { re: /^(bye|good ?night|gn|see you|cya)[\s!.]*$/i, reply: 'Talk soon.' },
];

// Send to Sonnet only when the question needs reasoning, writing or several steps
function pickModel(question) {
  const q = question.toLowerCase();
  if (/^(deep|think|sonnet)\s*:/.test(q)) return 'Sonnet';
  const heavy = /\b(collect|owe|owed|outstanding|unpaid|payment|invoice|revenue|money|why|analy[sz]e|analysis|compare|comparison|trend|forecast|predict|plan|strategy|strateg|should (we|i)|recommend|suggest|advice|advise|improve|summar(y|ise|ize)|brief|report|review|draft|write|email|message to|explain|breakdown|insight|what if|priorit)/;
  const questionMarks = (question.match(/\?/g) || []).length;
  if (heavy.test(q) || question.length > 220 || questionMarks >= 2) return 'Sonnet';
  return 'Haiku';
}

const SYSTEM = `You are the NOOCAP PM, the AI project manager for NOOCAP Media, an AI content agency in Mumbai run by Harsh Koli (COO) and Pratham (CEO).
You answer questions from Harsh and Pratham about the whole agency using your tools, which read live Notion data.

What you know about the agency:
- Creators (clients): Brad, Chris, Lindsay, Emtech, Duncan, Valeri (also spelled Valerie), David Iya, Nicole, Dmytro. Jonathan appears in older revenue rows.
- Editors: Abhishek, Prateek, Sumith, Prabal, Parvez. Scriptwriter: Shreya.
- Video flow on each creator board: 1 Idea Assigned, 2 Waiting for Brief, 3 Transcript, 4 Script Draft, 5 Script Approval, 6 To Film, 7 In Edit, 8 Changes, 9 Approval, 10 To Post, 11 Ready, 12 Posted, 13 Repost / Archive. Collapsed stages: 1-5 Scripting, 6 Filming, 7 Editing, 8-9 Review, 10-11 Ready, 12 Posted.
- Editors submit finished videos through the Video Intake form, which means "ready for review". Harsh approves videos and requests changes by changing the status in Notion.
- Brand deals are negotiated in each creator's own inbox; noocapcollab (the team mailbox) is CC'd once a deal is approved and handles production emails. Creators send NOOCAP their invoice and NOOCAP forwards it to the brand.
- NOOCAP earns a percentage cut of each sponsor deal, set per creator in the Creator Cut table.

How to answer:
- When the question names a creator, every item in your answer must belong to that creator. Check the creator on each row before listing it, and never pad the answer with other creators' deals or with deals that are only in negotiation.
- For payments to collect, money owed, unpaid or outstanding invoices, call money_to_collect (with the creator if one is named) and answer only from it: list what is invoiced and waiting, then what is posted but not invoiced, with amounts. Contracts or other promised sends are not payments.
- The AGENCY SNAPSHOT below is the live dashboard: every creator's week and pipeline, today's and upcoming posts, late cards, editors, every brand deal and creator-inbox offer with its next step, Approvals, money, client revenue and automation health. Answer from it first. Call tools only for detail it doesn't hold (a script or brief's text, a deal's full email history, older periods), and never say you have no record of something the snapshot lists.
- Whenever a question names a brand, call find_brand first: it searches deals, creator-inbox leads, video cards, recent emails and drafts at once and tolerates spelling. Only say you have no record after find_brand finds nothing, and then say which spelling you searched.
- For "any new brand deals / offers" questions, call both deals (stage Inbound or Negotiating, or recent) and leads.
- For how many videos were edited or delivered, and editor performance, use editor_output (Video Intake has the full history). Use team_activity only for board status moves and Shreya's scripts. Never say data is missing before checking the right tool.
- For anything about a posting date ("what's posting today", "this week", "tomorrow"), call pipeline with post_date_from and post_date_to set to those dates and no other filters. Every card with that POST DATE counts, on every creator board, whatever its stage; list each one with its creator, stage and whether it is ready (10- To Post or 11- Ready) or already posted.
- Always call a tool for facts. Never guess numbers, names, dates or statuses, and never do arithmetic yourself: quote the totals the tools return. If you need a figure the tools do not give, say so.
- If data is missing or a tool errors, say that plainly and say where in Notion it should be filled in.
- Money is in USD unless the data says otherwise. Dates are in India time (IST).
- Be brief and direct, like a sharp ops manager messaging the founder. Lead with the answer, then the few details that matter. Use short bullet lists for several items and bold only the key numbers.
- Never offer menus or options. Do not list things the user could ask, do not suggest next questions, and do not end with offers like "want me to…" or "let me know if…". Answer what was asked and stop. If a request is unclear, make the most sensible reading and answer that.
- You can add new videos with propose_create (title plus a brief you are given or write yourself, and fields like post date or type). When you write a brief, make it practical for the scriptwriter and editor: the hook, the key points, the call to action, and any sponsor must-mentions, and show the whole brief in your reply.
- You can change Notion with propose_update: video status, editor and post date on creator boards, Video Intake rows, brand deal fields, and sponsor revenue Paid / Cut Collected. Every change waits for the user to tap Confirm, so after proposing say in one short line what will change and never claim it is done. If several items match, ask which one in one line. Do not propose changes the user did not ask for.
- Script feedback for the script writer: send_script_notes passes a brand's notes or comment-doc link to Shreya right away (internal only, no confirm needed). Find the notes or link first (find_brand shows recent emails), and tell the user what was sent.
- Never tell the user a brand or deal doesn't exist, and never ask which creator, before calling find_brand: the snapshot only lists open brand deals, while find_brand also covers creator-inbox leads (Chris's negotiations, including Lost ones), videos, recent emails and drafts. Names are spelling-tolerant ("eleven labs" finds "ElevenCreative by ElevenLabs").
- Emails for a creator-inbox lead (e.g. "follow up with ElevenLabs at $1,000"): use draft_email with that brand, kind Follow-up or Counter, and price; it goes out from Chris's inbox in the brand's thread and reopens a Lost lead. Mention what they offered before (from find_brand) if relevant.
- Emails to brands: write them with draft_email. They wait in the Approvals tab until Harsh taps Send, so never say an email was sent. The system also drafts follow-ups, script emails, posted links, invoices and payment reminders on its own.

Memory and learning:
- The PM MEMORY list is what Harsh and Pratham have taught you. Treat it as true and follow it in every answer. It explains how to read the data, but for current numbers and statuses the live tools win.
- Keep learning. Whenever the user says "remember", corrects you, or tells you a lasting fact, rule, definition or preference about the agency or how you should answer, call remember with one clear self-contained sentence, then confirm in a few words like "Saved to memory (MEM-4)".
- If you got something wrong and the user corrects it, save the correction so you never repeat the mistake.
- If a new fact replaces an older memory, call forget on the old one first. If the user says forget something, call forget.
- Do not save one-off questions, today's figures or statuses (those live in Notion), or your own assumptions. Only save what the user actually told you.
- If asked what you remember, list the PM MEMORY items with their ids.
- Writing style rules, always: never stack three parallel items for rhythm, never use "it's not X, it's Y" contrasts, and never write chains of short choppy fragments. Write in flowing sentences joined with and, but, so, which, because.`;

async function callClaude(messages, channel, memoryText, modelId, snapshot = '') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {}),
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1500,
      system: [
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: memoryText, cache_control: { type: 'ephemeral' } },
        ...(snapshot ? [{ type: 'text', text: snapshot, cache_control: { type: 'ephemeral' } }] : []),
        { type: 'text', text: `Today is ${todayIST()} (IST). Channel: ${channel}.${channel === 'whatsapp' ? ' Keep it short and use WhatsApp formatting: *bold*, no markdown headers or tables.' : ''}` },
      ],
      tools: ALL_TOOLS.map((t, i) => (i === ALL_TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)),
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function logChat({ question, reply, usage, cost, channel, tools, error, model = 'Sonnet' }) {
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
        Model: { select: { name: model } },
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

async function logAction({ reply, outcome, channel }) {
  try {
    const rt = (s) => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];
    await notion('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id: DS.agentLog },
      properties: {
        Event: { title: rt((outcome === 'Changed' ? 'Changed in Notion: ' : outcome === 'Skipped' ? 'Change cancelled' : 'Change failed: ') + reply.replace(/^✅ Done:\n- /, '').slice(0, 80)) },
        Time: { date: { start: new Date().toISOString() } },
        Area: { select: { name: 'System' } },
        Outcome: { select: { name: outcome } },
        Source: { select: { name: channel === 'whatsapp' ? 'WhatsApp' : channel === 'discord' ? 'Discord' : 'Dashboard chat' } },
        Model: { select: { name: 'None' } },
        'Approved By': { select: { name: 'Harsh' } },
        Details: { rich_text: rt(reply) },
      },
    });
  } catch (e) {
    console.error('AGENT LOG write failed', e.message);
  }
}

const out = (status, data) => ({ status, data });

// The PM's brain, shared by the dashboard chat (/api/chat) and WhatsApp (/api/whatsapp).
// body: { messages, channel, chatId, confirm?, cancel? }  ->  { status, data: { reply, meta, pending, chatId, ... } }
export async function ask(body = {}) {
  const channel = ['whatsapp', 'discord'].includes(body.channel) ? body.channel : 'dashboard';
  const chatId = typeof body.chatId === 'string' && /^[0-9a-f-]{32,36}$/i.test(body.chatId) ? body.chatId : null;
  // WhatsApp keeps its own chat page (with delivery markers), so it saves the conversation itself
  const save = body.save === false ? async () => chatId : saveChat;
  const thread = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  const history = thread.slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  const question = history.length ? history[history.length - 1].content : '';
  if (!body.confirm && !body.cancel && (!history.length || history[history.length - 1].role !== 'user')) return out(400, { error: 'Send at least one user message' });

  // Confirm or cancel a proposed change (no AI call)
  if (body.confirm || body.cancel) {
    let reply;
    let outcome = 'Changed';
    if (body.cancel) {
      reply = 'Cancelled. Nothing was changed.';
      outcome = 'Skipped';
    } else {
      try {
        const result = await executeProposal(body.confirm);
        clearCache();
        reply = result.done.length ? '✅ Done:\n' + result.summary.split('\n').map((l) => '- ' + l).join('\n') : '';
        if (result.failed.length) {
          outcome = 'Error';
          reply += (reply ? '\n\n' : '') + '⚠️ Could not change:\n' + result.failed.map((f) => `- ${f.title}: ${f.error}`).join('\n');
        }
      } catch (e) {
        outcome = 'Error';
        reply = '⚠️ ' + e.message;
      }
    }
    const [savedId] = await Promise.all([
      save({ chatId, channel, messages: [...thread, { role: 'assistant', content: reply, meta: body.cancel ? 'cancelled' : 'change', at: new Date().toISOString() }] }).catch(() => chatId),
      logAction({ reply, outcome, channel }),
    ]);
    return out(200, { reply, meta: body.cancel ? 'cancelled' : 'change', usage: { input: 0, output: 0, cost_usd: 0 }, tools_used: [], model: 'none', chatId: savedId });
  }

  const small = SMALL_TALK.find((t) => t.re.test(question.trim()));
  if (small) {
    const savedId = await save({ chatId, channel, messages: [...thread, { role: 'assistant', content: small.reply, meta: 'free', at: new Date().toISOString() }] }).catch(() => chatId);
    return out(200, { reply: small.reply, meta: 'free', usage: { input: 0, output: 0, cost_usd: 0 }, tools_used: [], model: 'none', chatId: savedId });
  }

  const modelName = pickModel(question);
  const model = MODELS[modelName];

  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const toolsUsed = [];
  const pending = [];
  const messages = [...history];
  let reply = '';
  let memoryText;
  try {
    memoryText = memoryBlock(await loadMemory());
  } catch (e) {
    memoryText = 'PM MEMORY could not be loaded right now (' + String(e.message).slice(0, 120) + '). Answer without it and do not claim to remember anything.';
  }
  // The whole dashboard, so the PM knows every page without picking a tool first
  const snapshot = await buildSnapshot().catch((e) => `AGENCY SNAPSHOT unavailable right now (${String(e.message).slice(0, 100)}). Use the tools.`);
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const out = await callClaude(messages, channel, memoryText, model.id, snapshot);
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
        let data;
        if (c.name === 'propose_update' || c.name === 'propose_create') {
          try { data = await (c.name === 'propose_create' ? proposeCreate : proposeUpdate)(c.input || {}); } catch (e) { data = { error: String(e.message).slice(0, 300) }; }
          if (data.proposal) {
            pending.push(data.proposal);
            data = { proposed_change: data.proposal.summary, note_for_you: data.note_for_you };
          }
        } else if (c.name === 'send_script_notes') {
          try {
            const I = await import('./inbox.js');
            const r = await I.resendScriptChanges({ brand: c.input?.brand, creator: c.input?.creator, feedback: c.input?.notes });
            data = r.ok ? { sent_to_script_writer: true, deal: r.deal, video_card: r.video || null } : { error: 'The Discord ping to the script writer failed, the notes are saved on the video card', deal: r.deal };
          } catch (e) { data = { error: String(e.message).slice(0, 300) }; }
        } else if (c.name === 'draft_email') {
          try { data = await draftFromChat(c.input || {}); } catch (e) { data = { error: String(e.message).slice(0, 300) }; }
        } else {
          data = await runTool(c.name, c.input, { channel });
        }
        return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(data).slice(0, 60000) };
      }));
      messages.push({ role: 'user', content: results });
    }
    if (!reply) reply = 'I ran out of steps before finishing that one. Try asking a narrower question.';
  } catch (e) {
    const cost = 0;
    await logChat({ question, reply: '', usage, cost, channel, tools: toolsUsed, error: e.message, model: modelName });
    return out(502, { error: e.message });
  }

  const P = model.price;
  const cost = Math.round(((usage.input * P.input + usage.output * P.output + usage.cacheWrite * P.cacheWrite + usage.cacheRead * P.cacheRead) / 1e6) * 10000) / 10000;
  const uniqueTools = [...new Set(toolsUsed)];
  const meta = [modelName, uniqueTools.length ? 'read ' + uniqueTools.join(', ') : '', '$' + cost.toFixed(4) + ' (≈₹' + (cost * 88).toFixed(2) + ')'].filter(Boolean).join(' · ');
  const [savedId] = await Promise.all([
    save({ chatId, channel, messages: [...thread, { role: 'assistant', content: reply, meta, at: new Date().toISOString(), pending }] }).catch((e) => { console.error('chat save failed', e.message); return chatId; }),
    logChat({ question, reply, usage, cost, channel, tools: toolsUsed, model: modelName }),
  ]);
  return out(200, { reply, meta, usage: { input: usage.input + usage.cacheWrite + usage.cacheRead, output: usage.output, cost_usd: cost }, tools_used: uniqueTools, model: modelName, chatId: savedId, pending });
}
