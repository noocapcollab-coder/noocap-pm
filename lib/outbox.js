// PM OUTBOX: every email to a brand is a draft first. Harsh approves in the PM app, then n8n sends it from noocapcollab.
import { notion, plain, clearCache, pageIdOf } from './notion.js';
import { DS, todayIST, istStamp } from './tools.js';
import { schemaOf } from './actions.js';
import { setIf, discord, uploadToNotion } from './briefs.js';
import { buildScriptPdf } from './pdf.js';
import { claude, costOf, PRICES } from './claude.js';
import { playbook } from './playbook.js';
import { buildMime, threadSubject } from './mime.js';
import { CREATOR_DOMAINS } from './creatordomains.js';

export const OUTBOX_DS = '12116e41-602e-431f-9907-3154545889ab';
// Drafts are short, plain follow-ups and replies: Haiku writes them well at a third of Sonnet's price.
// PM_MODEL_SMART in Vercel switches back if a draft ever needs the bigger model.
const SMART = process.env.PM_MODEL_SMART || 'claude-haiku-4-5-20251001';
export const STAGES = ['Inbound', 'Negotiating', 'Price Agreed', 'Signed', 'Brief Received', 'Script Sent', 'Script Approved', 'In Production', 'Submitted', 'Approved', 'Posted', 'Invoiced', 'Paid'];
export const stageBefore = (stage, target) => { const a = STAGES.indexOf(stage || 'Inbound'); const b = STAGES.indexOf(target); return a === -1 || a < b; };
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
const rtLong = (s) => { const out = []; const t = String(s || ''); for (let i = 0; i < t.length && out.length < 90; i += 1900) out.push({ type: 'text', text: { content: t.slice(i, i + 1900) } }); return out; };
const addDays = (n) => new Date(Date.now() + 5.5 * 36e5 + n * 864e5).toISOString().slice(0, 10);
const pageIdFromUrl = (u) => pageIdOf(u);
const appUrl = () => process.env.PM_PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '');

// A draft the second reader flags never sends itself, in 'team' mode too: the check already ran (and cost), so its
// verdict must hold the draft for Harsh. In team mode the flags were only logged, so the flagged Dreamina $3,000 chase
// and the OiiOii follow-up claiming "the brief and contract we sent" both auto-sent (system check, Nov 11).
export const secondReadHolds = (mode) => !['off', 'shadow'].includes(String(mode || '').toLowerCase());

// ---------- writing emails ----------
// Emails sign off as the creator's team, never with a person's name: "Best,\nLindsay's Team"
const possessive = (n) => `${n}'s`;
export const teamSign = (creator) => `Best,\n${creator ? possessive(String(creator).trim()) + ' Team' : 'The Team'}`;
// Whatever sign-off the AI wrote, the email ends with exactly one team signature
export function withSignature(body, sig) {
  let lines = String(body || '').replace(/\s+$/, '').split('\n');
  const from = Math.max(0, lines.length - 6);
  let k = -1; // the last sign-off line ("Best,") near the end
  for (let i = lines.length - 1; i >= from; i--) if (/^\s*(best|thanks|thank you|cheers|regards|kind regards|warm regards|warmly|sincerely|all the best)\s*,?\s*$/i.test(lines[i])) { k = i; break; }
  if (k >= 0) lines = lines.slice(0, k);
  while (lines.length > 1 && /^\s*(harsh|noocap media|[\w .'’|-]{0,40}\bteam( \| noocap media)?)?\s*$/i.test(lines[lines.length - 1])) lines.pop();
  return `${lines.join('\n').replace(/\s+$/, '')}\n\n${sig}`;
}
// Brands read em dashes as "written by AI", so none ever leave in an email, whoever wrote the draft
export const noDashes = (v) => String(v ?? '')
  .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
  .replace(/^[ \t]*[—–][ \t]*/gm, '')
  .replace(/[ \t]*[—–][ \t]*(?=[,.;:!?)]|$)/gm, '')
  .replace(/[ \t]*[—–][ \t]*/g, ', ')
  .replace(/,[ \t]*,/g, ',');
export function fixSignature(body, sendFrom) {
  const who = String(sendFrom || '');
  if (!who || /noocapcollab/i.test(who)) return body;
  return String(body || '').replace(/(\n\s*(?:Best|Thanks|Cheers|Regards),?\s*\n\s*)([A-Z][\w ]{1,30})'s Team(\s*)$/i, (m, pre, name, end) => (name.trim().toLowerCase() === who.toLowerCase() ? m : `${pre}${who}'s Team${end}`));
}
const EMAIL_TOOL = {
  name: 'email',
  description: 'The email to send',
  input_schema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string', description: 'Plain text body including greeting and the signature' } }, required: ['subject', 'body'] },
};
const PURPOSE = {
  'Script': 'Send the script for the brand to review and approve. The script PDF is attached. Ask them to approve or share feedback.',
  'Follow-up': 'Politely follow up because the brand has not replied. Keep it short and make the next step easy.',
  'Posted links': 'Share that the video is live and give the posted link(s).',
  'Invoice': 'Send the invoice, short. If facts.posted_links is given, first say the video is live and list each link on its own line with its platform (Instagram:, YouTube Shorts:, TikTok:), written exactly. Then one sentence saying the invoice for facts.amount is attached, and when facts.pay_link is given ask them to pay using this link: facts.pay_link, written exactly. With a pay link, never add bank, PayPal or "Payment details" lines and never repeat their billing address (Harsh, Nov 15: pay through the link only). Only when there is no pay_link and facts.our_company_and_payment_details is given, add its payment details lines under "Payment details:". One short thank-you line at most, no recap of the work, no due-date sentence.',
  'Billing details': 'Ask the brand for the company details we need to raise the invoice: registered company name, the email the invoice should go to, full billing address, and VAT or tax ID if they have one. Say it is for the invoice for this collaboration (facts.amount_usd, only if it reads naturally). If facts.reminder is "yes", this is a gentle reminder of our earlier request. Two or three short sentences.',
  'Payment chase': 'Politely remind the brand that the invoice is unpaid, mention when it was sent and the amount, and ask for a payment date.',
  'Draft video': 'Share the edited video with the brand for review. Give the Frame.io link, say which round it is if it is a revised cut, and ask for their approval or feedback.',
  'Reply': 'Reply to the brand\'s latest message (facts.their_latest_message) and nothing else. Answer what they asked us using only the facts. Never write filler like "we will send it shortly", "we will get back to you" or "we will confirm soon": anything we must provide comes from Harsh first (facts.we_provide), so give exactly that. Never echo back points the brand said are still undecided on their side, and never ask them for details they did not offer.',
  'Quote': 'First reply to a brand about a collaboration. Say we are interested in working with them, give our rate for facts.deliverables at exactly facts.price_usd, and say briefly what it includes (facts.includes, if given). Invite them to go ahead. Only mention the deliverables in facts.deliverables: do not pitch bundles, dedicated videos or other packages, and do not offer a discount.',
  'Counter': 'The brand offered less than our rate. Thank them and say we can do facts.price_usd for facts.deliverables. Keep it warm and short, and do not hint at going lower. If facts.first_reply is true, also say we are interested in working with them and what the rate includes (facts.includes).',
  'Close deal': 'The price is agreed at facts.price_usd. Say that works, ask them to share the brief, and say we are adding noocapcollab@gmail.com (our team) to this thread, who will handle the rest from here.',
  'Rate hold': 'The brand offered far below our rate (facts.their_offer_usd). Thank them and say plainly that our rate for facts.deliverables is facts.price_usd: if that works we can proceed, otherwise we will have to pass on this collaboration. Friendly, two or three sentences, no negotiation.',
  'Decline': 'Politely decline the collaboration because the budget does not work for us. Thank them, keep the door open for the future, two or three sentences. Do not mention any price.',
  'Lead follow-up': 'The brand has gone quiet. First read facts.conversation: the latest email in the thread, with the earlier messages quoted under it. Write the natural next message from our side that picks up exactly where the conversation stopped and makes it easy for them to reply. Greet them by first name (facts.contact_name, or the name the brand signed with in the conversation; just "Hi," if there is none). Refer to what was actually discussed (their product, the platforms, anything they asked or we promised). Do not restate a price they have already been given; only if facts.lock_in_this_week is true, offer facts.price_usd (down from facts.usual_price_usd) if they can confirm this week. Never mention any other number, and if facts.mention_no_price is true do not mention any price or amount at all, even one from the conversation. If the brand\'s last message offered a budget far below our rate or said they have no budget, do not negotiate: say kindly that our rate stands and we would be glad to go ahead if it works for them. End with the signature only, with no extra sign-off line before it. If facts.nudge_number is 2, keep it to one or two short sentences. If facts.nudge_number is 3, it is the last check-in: one or two short sentences that close the loop kindly (for example, that we will assume the timing is not right for now and they can reply whenever it is), without any pressure. Two to four sentences otherwise, warm and human, never pushy, and never invent details that are not in the conversation.',
  'Other': 'Write the email described.',
};

let lastWriteCost = 0;
let costColumn = false;
// While the AI is paused, an invoice email is still needed (raising one doesn't need any thinking): a plain written one
export function plainInvoiceEmail(deal, facts = {}, signature) {
  const amount = facts.amount || (deal.finalRate ? `$${deal.finalRate}` : 'the agreed fee');
  const what = `the ${deal.brand} × ${deal.creator} video`;
  const to = facts.billed_to ? `, billed to ${facts.billed_to}` : '';
  const body = `Hi,\n\nThanks for sending over the details. Here is the invoice for ${amount} for ${what}${to}.\n\nYou can pay here: {{invoice_link}}\n\nLet us know if you need anything else from our end.\n\n${signature || teamSign(deal?.creator)}`;
  return { subject: `Invoice: ${deal.brand} × ${deal.creator}`, body, cost: 0 };
}

const hexOf = (u) => (String(u || '').replace(/-/g, '').match(/[0-9a-f]{32}/i) || [''])[0].toLowerCase();
export async function writeEmail({ kind, deal, facts = {}, instructions = '', signature }) {
  if (kind === 'Invoice') { const { aiPaused } = await import('./pause.js'); if (aiPaused()) return plainInvoiceEmail(deal, facts, signature); }
  // NOOCAP's playbook (standard answers and how we handled past situations), once Harsh has set it Live
  const book = await playbook().catch(() => '');
  const convo = deal?.id ? await (await import('./memory.js')).readTranscript(deal.id, 14000).catch(() => '') : '';
  const lessons = await (await import('./lessons.js')).lessonsFor(`${kind} ${PURPOSE[kind] || ''} ${instructions || ''} ${JSON.stringify(facts).slice(0, 1500)}`, { areas: ['Emails'] }).catch(() => '');
  // The brand's wiki page: everything known about this brand from every past deal (lib/wiki.js)
  const W = await import('./wiki.js');
  const wiki = W.wikiPrompt(await W.wikiFor(deal?.brand).catch(() => ''));
  const out = await claude({
    _job: 'drafts',
    model: SMART,
    max_tokens: 900,
    system: `You write short, warm, professional emails from NOOCAP Media (an agency that makes sponsored videos for creators) to brand partners. Rules: sound like a real person, no filler, no hype. Never stack three parallel items for rhythm, never use "it's not X, it's Y" contrasts, and never write chains of short choppy fragments; write flowing sentences joined with and, but, so, because. Never use em dashes or en dashes (— or –) anywhere; use a comma, a full stop or "and" instead. Do not invent facts, dates, amounts or links that are not given. Only mention a posting or go-live date when Facts gives go_live, and then use exactly that date, never one from the conversation. Never promise to send or confirm something later (\"shortly\", \"right away\", \"within a few hours\"): give the thing if it is in Facts, otherwise leave the promise out. Today is ${new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10)}. For a reply, answer only what the brand asks in their latest message in one or two short paragraphs, and do not repeat dates, payments or events from earlier in the thread. Before writing a reply, work out every separate question or request in the brand's latest message (a date, a file, a link, a change, a yes/no, access, a detail) and make sure the email answers each one, in their order and in their own words for things (their product names, their portal, the format they asked for); when the brand wiki says how this brand works (where scripts or drafts go, what they always need, mistakes made with them before, decisions from Harsh), follow it. If one of their asks has no answer in Facts, leave it out rather than guess. Greet the person by first name only when the brand's latest message is signed with that name or they introduced themselves by it; otherwise write \"Hi there,\" (never guess a name from an email address or the brand name). Never sign with a person's name. End with this signature exactly:\n${signature || teamSign(deal?.creator)}${book ? `\n\nNOOCAP PLAYBOOK: how we normally answer brands, our standard terms and example replies from our real emails. Use it to give specific, confident answers in our usual style. The facts of this deal and the brand's latest message always win over the playbook, and never quote a rate or term from it for a different creator or deliverable than it names.\n${book}` : ''}`,
    tools: [EMAIL_TOOL],
    tool_choice: { type: 'tool', name: 'email' },
    messages: [{ role: 'user', content: `Purpose: ${PURPOSE[kind] || PURPOSE.Other}\n${instructions ? 'Extra instructions: ' + instructions + '\n' : ''}\nDeal: ${deal.brand} × ${deal.creator || 'creator'} (stage ${deal.stage || '?'})\n${wiki}${deal.memory ? `What has happened in this deal so far (the whole conversation, ours and theirs). Use it so the email fits where things really stand: never ask for something they already gave, never repeat what we already sent, and never contradict what was agreed:\n${deal.memory}\n` : ''}${lessons ? `\n${lessons}\n` : ''}${convo ? `\nThe whole email conversation of this deal, word for word (oldest first). Answer the latest brand message in it, and never contradict or repeat what is already there:\n${convo}\n` : ''}Facts: ${JSON.stringify(facts)}` }],
  });
  const call = (out.content || []).find((c) => c.type === 'tool_use');
  const cost = costOf(out.usage, /haiku/i.test(SMART) ? PRICES.haiku : PRICES.sonnet);
  lastWriteCost += cost; // picked up by the next createDraft, so each draft carries what it cost to write
  const mail = { ...(call?.input || { subject: `${deal.brand} × ${deal.creator}`, body: '' }), cost };
  // An email never says "here is" / "attached" for a file it does not carry (Dreamina x Chris, Nov 14: Jenny asked for
  // the cover image and caption and the draft said "Here is the cover image and caption" with nothing attached; the
  // lesson alone did not stop it, test bank case dreamina-cover-caption-ask-2026-11-14). Write it once more with that
  // rule spelled out, and if it still claims a file, take those sentences out.
  if (!instructions.includes(NO_FAKE_ATTACH) && claimsMissingAttachment(mail.body, facts, kind)) {
    const again = await writeEmail({ kind, deal, facts, instructions: `${instructions ? instructions + ' ' : ''}${NO_FAKE_ATTACH}`, signature }).catch(() => null);
    if (again?.body) { again.cost = (again.cost || 0) + cost; return again; }
  }
  if (instructions.includes(NO_FAKE_ATTACH) && claimsMissingAttachment(mail.body, facts, kind)) mail.body = dropAttachClaims(mail.body);
  // A filler promise ("as soon as possible", "right away", "we will publish it immediately") gets one rewrite with the
  // rule spelled out, so the draft does not land in Approvals held for it. The lesson alone did not stop it: lesson
  // "No filler promises or placeholders" seen 13 times, and test bank case capcut-chris-cleared-to-post-nov16 kept
  // failing on fresh wording (system check, Nov 18)
  const givenText = `${JSON.stringify(facts || {})}\n${instructions}`;
  if (needsFillerRewrite(mail.body, instructions) && (PLACEHOLDER.test(mail.body) || hasUngivenFiller(mail.body, givenText))) {
    const again = await writeEmail({ kind, deal, facts, instructions: `${instructions ? instructions + ' ' : ''}${NO_FILLER}`, signature }).catch(() => null);
    if (again?.body && !FILLER.test(again.body) && !PLACEHOLDER.test(again.body)) { again.cost = (again.cost || 0) + cost; return again; }
  }
  // Still a filler promise after the rewrite: take that sentence out, as NO_FILLER says, instead of handing back the
  // first draft with it (test bank capcut-chris-cleared-to-post-nov16 failed at 20:57 and 22:16 UTC on Nov 18 with
  // "shortly" and "as soon as it is live" still in the reply; bug hunter, Nov 19)
  if (mail.body && FILLER.test(mail.body)) mail.body = dropFillerSentences(mail.body, givenText);
  // A follow-up chases only the script, brief, contract or cut it is about. Billing details have their own reminder flow,
  // capped at 3 and skipped for portal payers, so a chase never asks for them (Polar x Valeri, Nov 21: follow-up 3 on the
  // revised cut also asked Ushni for company billing details though Billing Reminders Sent was 3, Polar pays via Gusto
  // and she had asked US for our details; the night check rejected it). Write it once more with the rule, then take
  // the billing ask out of whatever is left.
  if (kind === 'Follow-up' && mail.body && BILLING_ASK.test(mail.body)) {
    if (!instructions.includes(NO_BILLING_IN_FOLLOWUP)) {
      const again = await writeEmail({ kind, deal, facts, instructions: `${instructions ? instructions + ' ' : ''}${NO_BILLING_IN_FOLLOWUP}`, signature }).catch(() => null);
      if (again?.body && !BILLING_ASK.test(again.body)) { again.cost = (again.cost || 0) + cost; return again; }
    }
    mail.body = dropBillingAsk(mail.body);
  }
  // A creator's business or legal details come only from Harsh (rule 71). The writer still filled in Su Wern's
  // agreement form with made-up ones after the lesson and the preflight hold (test bank
  // topview-lindsay-agreement-details-nov21 failed at 11:56, 13:07 and 16:16 UTC on Nov 21: "Business Name: Lindsay
  // Creative LLC, Legal Name: Lindsay Smith, 123 Maple Street"), so those lines are taken out and the draft says Harsh
  // has to give them (bug hunter, Nov 21)
  if (mail.body) {
    const det = dropUngivenDetails(mail.body, `${givenText}\n${signature || ''}`);
    if (det.dropped) { mail.body = det.body; mail.needsYou = NEEDS_DETAILS; }
  }
  // A link in the email must come from what this email was written from: the facts, the instructions, this deal's own
  // emails or the playbook. A link the writer lifted from the brand wiki or a lesson example is another campaign's
  // (Tripo 3D x Lindsay, Nov 18: a Higgsfield brief link went to Rajeshwari as the answer to her account-email question;
  // test bank tripo-lindsay-account-email-wrong-link-nov18 kept writing it back in). Write once more without it, then
  // take out any line that still carries one.
  const allowed = [JSON.stringify(facts || {}), instructions, convo, deal?.memory, JSON.stringify({ ...(deal || {}), memory: undefined }), book, signature || ''].join('\n');
  if (mail.body && foreignLinks(mail.body, allowed).length) {
    if (!instructions.includes(NO_FOREIGN_LINKS)) {
      const again = await writeEmail({ kind, deal, facts, instructions: `${instructions ? instructions + ' ' : ''}${NO_FOREIGN_LINKS}`, signature }).catch(() => null);
      if (again?.body && !foreignLinks(again.body, allowed).length) { again.cost = (again.cost || 0) + cost; return again; }
    }
    mail.body = dropForeignLinks(mail.body, allowed);
  }
  if (mail.body) mail.body = withSignature(mail.body, signature || teamSign(deal?.creator));
  return mail;
}

export const NO_BILLING_IN_FOLLOWUP = 'This is a follow-up: ask only about the script, brief, contract or video we are waiting on. Never ask for billing, company or invoice details in it.';
export const BILLING_ASK = /\b(billing|company|invoic\w*)\s+(details|address|email|info\w*)\b|\bcompany name\b/i;
// Takes the billing-details ask out of a follow-up: the "and share the company billing details ..." part of a sentence
// first, then any sentence still asking for them. Pure.
export function dropBillingAsk(body) {
  return String(body || '').split('\n').map((line) => {
    if (!BILLING_ASK.test(line)) return line;
    let l = line.replace(/,?\s+(?:and|as well as|plus)\s+(?:to\s+)?(?:share|send|provide|confirm|pass)\b[^.?!]*?\b(?:billing|company|invoic\w*)\b[^.?!]*/i, '');
    if (!BILLING_ASK.test(l)) return l;
    l = l.split(/(?<=[.?!])\s+/).filter((sen) => !BILLING_ASK.test(sen)).join(' ');
    return l;
  }).filter((line, i, all) => line.trim() || !all[i - 1] || all[i - 1].trim()).join('\n').replace(/\n{3,}/g, '\n\n');
}
export const NEEDS_DETAILS = "the brand asked for the creator's business or legal details, which only Harsh gives: the made-up ones were taken out, so send him the ask and put his answer in its own reply";
// "Business Name: ...", "Legal Address: ...", "Tax ID: ..." with a value, and any sample-looking name or address
const DETAIL_LINE = /^\s*[-•*]?\s*(?:(?:business|legal|company|registered|full legal|entity|billing|mailing|contact|creator(?:'|’)?s?)\s+)?(?:name|address|email|entity|tax\s*id|ein|vat(?:\s*(?:id|number))?|bank(?:\s*details)?|account\s*number|iban|swift|routing(?:\s*number)?)\s*:\s*(\S.*)$/i;
const SAMPLE_IDENTITY = /\b\d{2,4}\s+(?:main|maple|elm|oak|pine|fake|example|sample)\s+(?:st|street|ave|avenue|road|rd|lane|ln|blvd)\b|\b(?:john|jane)\s+doe\b|@(?:example|noocap)\.com\b/i;
const normDetail = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').trim();
// Takes out detail lines whose value is not in given (the facts and instructions the email was written from) and any
// line with a sample-looking identity, plus the lead-in ("here are Lindsay's details:") once nothing follows it.
// Returns { body, dropped }. Pure.
export function dropUngivenDetails(body, given = '') {
  const ok = normDetail(given);
  let dropped = 0;
  const kept = String(body || '').split('\n').filter((line) => {
    const m = line.match(DETAIL_LINE);
    const ungiven = m && !(normDetail(m[1]) && ok.includes(normDetail(m[1])));
    if (ungiven || (SAMPLE_IDENTITY.test(line) && !ok.includes(normDetail(line.match(SAMPLE_IDENTITY)[0])))) { dropped++; return false; }
    return true;
  });
  if (!dropped) return { body: String(body || ''), dropped: 0 };
  const left = kept.filter((line) => DETAIL_LINE.test(line));
  const out = (left.length ? kept : kept.filter((line) => !/:\s*$/.test(line) || !/\b(details?|information|info|below)\b/i.test(line))).join('\n').replace(/\n{3,}/g, '\n\n');
  return { body: out, dropped };
}
export const NO_FILLER = 'Never promise timing or later action: no "as soon as possible", "right away", "shortly", "immediately", "today", "soon" or "within N days". Say only what is true now (for example "we will share the live link here once it is up" becomes "we will share the live link here"), or leave the sentence out. Never leave a fill-in in square brackets ([ad code], [date], [name]): if a value is not in Facts, leave that sentence out.';
// true when a freshly written body holds a filler promise and has not been rewritten for it yet. Pure.
export function needsFillerRewrite(body, instructions = '') {
  return !!body && !String(instructions).includes(NO_FILLER) && (FILLER.test(String(body)) || PLACEHOLDER.test(String(body)));
}
export const NO_FOREIGN_LINKS = 'Use only links that appear in Facts or in this deal\'s own emails. Never copy a link from the brand wiki, the lessons or another campaign, and if the brand asks for something Facts does not give, leave it out instead of sending a different link.';
const URL_RE = /https?:\/\/[^\s<>()"'\]]+/gi;
const urlKey = (u) => String(u).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[.,;:!?)\]*_]+$/, '').replace(/\/$/, '');
// Links in body that appear nowhere in the allowed text (compared without scheme, www and trailing punctuation). Pure.
export function foreignLinks(body, allowed = '') {
  const ok = String(allowed || '').toLowerCase().replace(/https?:\/\/(www\.)?/g, '');
  return [...new Set((String(body || '').match(URL_RE) || []).map(urlKey))].filter((k) => k && !ok.includes(k));
}
export function dropForeignLinks(body, allowed = '') {
  const bad = foreignLinks(body, allowed);
  if (!bad.length) return body;
  return String(body).split('\n').filter((line) => !(line.match(URL_RE) || []).some((u) => bad.includes(urlKey(u)))).join('\n').replace(/\n{3,}/g, '\n\n');
}
export const NO_FAKE_ATTACH = 'Nothing is attached to this email and Facts gives no file, image, caption or link, so never write "here is", "here\'s", "attached", "please find" or "enclosed" about a file, image, caption, video or document. If the brand asks for something that is not in Facts, do not claim to send it and do not promise it.';
const FILEISH = '(?:image|cover|caption|file|script|video|cut|edit|invoice|pdf|document|contract|thumbnail|draft|screenshot|receipt|deck|brief|photo|copy|assets?)s?';
// "The cover image and caption are attached" counts too (test bank dreamina-cover-caption-ask-2026-11-14 failed on it,
// Nov 18 13:26 UTC: the old pattern only knew "attached is/are" word order, bug hunter)
const ATTACH_CLAIM = new RegExp(`\\b(?:here(?:'|’)?s|here (?:is|are))\\b[^.!?\\n]{0,40}\\b${FILEISH}\\b|\\b(?:attached (?:is|are)|i(?:'|’)ve attached|we(?:'|’)ve attached|we have attached|i have attached|please find|please see (?:the )?attached|enclosed (?:is|are)|attaching)\\b|\\b${FILEISH}\\b[^.!?\\n]{0,40}\\b(?:is|are) (?:attached|enclosed|included)\\b`, 'i');
const CARRIES_FILES = new Set(['Script', 'Invoice', 'Draft video', 'Posted links']);
// true when the body hands over something ("here is the cover image") while the email carries nothing: no link in the
// body and no file, link or caption in facts, and the kind is not one that always goes out with its file
export function claimsMissingAttachment(body, facts = {}, kind = 'Reply') {
  if (!body || CARRIES_FILES.has(kind)) return false;
  if (/https?:\/\//i.test(body)) return false;
  const f = JSON.stringify(facts || {});
  if (/https?:\/\/|"[^"]*(attach|file|link|url|caption|pdf|image|cover)[^"]*"\s*:/i.test(f)) return false;
  return String(body).split(/(?<=[.!?])\s+|\n+/).some((s) => ATTACH_CLAIM.test(s) && !/\?\s*$/.test(s));
}
// Takes out the sentences that promise timing ("we'll post it shortly"), keeping questions. When nothing would be left
// but the greeting, the body is returned as it was, so the draft is held for Harsh instead of going out empty. Pure.
// given: the facts and instructions the email was written from. A timing line whose time words come from them (Harsh's
// own answer on WhatsApp, "Brad can film it this week") is kept, because then it is his date, not a filler promise.
export function fillerGiven(sentence, given = '') {
  const m = String(sentence).match(FILLER);
  if (!m || !given) return false;
  const tail = m[0].trim().toLowerCase().split(/\s+/).slice(-2).join(' ');
  return tail.length > 2 && String(given).toLowerCase().includes(tail);
}
// true when the body holds a filler sentence (not a question) whose timing did not come from given. Pure.
export function hasUngivenFiller(body, given = '') {
  return String(body || '').split(/(?<=[.!?])\s+|\n+/).some((x) => FILLER.test(x) && !/\?\s*$/.test(x) && !fillerGiven(x, given));
}
export function dropFillerSentences(body, given = '') {
  const out = String(body).split('\n').map((line) => line.split(/(?<=[.!?])\s+/).filter((x) => !(FILLER.test(x) && !/\?\s*$/.test(x) && !fillerGiven(x, given))).join(' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const words = out.replace(/^(hi|hello|hey|dear)\b[^\n]*\n?/i, '').replace(/\n\s*(best|thanks|regards|cheers)\b[^\n]*(\n[^\n]*)?\s*$/i, '').trim();
  return words.length >= 20 ? out : String(body);
}
export function dropAttachClaims(body) {
  return String(body).split('\n').map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => !(ATTACH_CLAIM.test(s) && !/\?\s*$/.test(s))).join(' ')).join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- drafts ----------
export async function pendingDraft(dealId, kind) {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, {
    page_size: 1,
    filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Kind', select: { equals: kind } }, { property: 'Deal', relation: { contains: dealId } }] },
  });
  return (res.results || [])[0] || null;
}

// A draft Harsh rejected, or one the PM retired or expired, is not written again straight away. Before this, the next
// heartbeat (every 10 minutes) wrote the same email again with the AI as soon as the old draft left Approvals, and the
// answered-thread sweep removed it again: the same follow-up was paid for over and over all day.
export const REDRAFT_COOLDOWN_H = Number(process.env.REDRAFT_COOLDOWN_H) || 72;
export function cooldownFilter({ dealId, leadId, kind, hours = REDRAFT_COOLDOWN_H, now = Date.now() }) {
  const since = new Date(now - hours * 36e5).toISOString();
  return { and: [
    dealId ? { property: 'Deal', relation: { contains: dealId } } : { property: 'Lead', relation: { contains: leadId } },
    ...(kind ? [{ property: 'Kind', select: { equals: kind } }] : []),
    { or: [{ property: 'Status', select: { equals: 'Rejected' } }, { property: 'Status', select: { equals: 'Expired' } }] },
    { timestamp: 'created_time', created_time: { on_or_after: since } },
  ] };
}
// A draft the system check threw out (not Harsh) only blocks a new one for a day: its reason often stops being true
// (Polar x Valeri, Nov 12: a follow-up was auto-rejected because the cut was still "In Review"; the cut went to the brand
// and the 3-day cooldown then kept Ushni from being chased at all). Harsh's own rejections still hold for 3 days.
export const AUTO_REJECT_COOLDOWN_H = 24;
export const autoRejected = (page) => /^Auto-rejected by system check/i.test(plainText(page?.properties?.Error));
const plainText = (p) => (p?.rich_text || []).map((t) => t.plain_text).join('');
export async function recentlyDropped(opts) {
  if (!opts.dealId && !opts.leadId) return false;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 10, filter: cooldownFilter(opts) }).catch(() => ({ results: [] }));
  return droppedBlocks(r.results || [], opts);
}
// A dropped draft (rejected by Harsh or the system check, or expired) is not written again until a new email lands in
// the deal, either side's, within the cooldown. Before this an auto-rejected draft was rewritten after 24 hours with
// nothing changed, and thrown out again: the Manyfast × Chris invoice was drafted and rejected three nights running
// (Harsh, Nov 20: "drafting mails of no use"). Without the deal's email dates the old rule still applies.
export function droppedBlocks(rows, { lastEmail = [], now = Date.now() } = {}) {
  const newest = Math.max(0, ...[].concat(lastEmail).map((v) => Date.parse(v)).filter(Number.isFinite));
  return rows.some((p) => {
    if (newest) return newest <= Date.parse(p.last_edited_time || p.created_time);
    return !autoRejected(p) || now - Date.parse(p.created_time) < AUTO_REJECT_COOLDOWN_H * 36e5;
  });
}

const DOMAIN_PAIRS = String(CREATOR_DOMAINS).split(',').map((p) => p.split(':').map((x) => x.trim())).filter(([d]) => d);
const OUR_DOMAINS = DOMAIN_PAIRS.map(([d]) => d.toLowerCase());
// Whose team an address belongs to (collab@valchy.ai is Valeri's), else null
const creatorOfAddr = (a) => { const d = (String(a).toLowerCase().split('@')[1] || ''); const hit = DOMAIN_PAIRS.find(([x]) => d === x.toLowerCase() || d.endsWith('.' + x.toLowerCase())); return hit ? hit[1] : null; };
export const oursAddr = (a) => { const d = (String(a).toLowerCase().split('@')[1] || ''); return /^noocapcollab@/i.test(a) || OUR_DOMAINS.some((x) => d === x || d.endsWith('.' + x)); };
// Cc without the person in To, without our own sending inbox, without repeats, and never another creator's team
// (a Valeri deal must not copy Lindsay's inbox just because the same agency handles both)
// Our side's real inbox addresses. A brand mistyping one ("ollab@chriscordero.net" for collab@, HoneyBook x Chris,
// Nov 17) is put right, and a Message-ID that slipped into an address list ("CAEs…@mail.gmail.com") is dropped, so a
// reply never bounces on them.
export const OUR_INBOXES = ['collab@chriscordero.net', 'collab@buildroom.ai', 'partnerships@ninjaaitools.com', 'collab@automateaiconsulting.com', 'collab@valchy.ai'];
const editDistance = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
export function fixAddress(addr) {
  const a = String(addr || '').trim().toLowerCase();
  const [local, domain] = a.split('@');
  if (!local || !domain) return null;
  if (/^mail\.gmail\.com$/.test(domain) || (local.length > 25 && /[+=]/.test(local))) return null; // a Message-ID, not a person
  const ours = OUR_INBOXES.find((x) => x.endsWith('@' + domain));
  if (ours && ours !== a && editDistance(local, ours.split('@')[0]) <= 2) return ours;
  return addr.trim();
}
export function fixAddressList(list) {
  const seen = new Set();
  return (String(list || '').match(/[\w.+'=-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(fixAddress).filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase())).join(', ');
}
export function cleanCc(cc, to, sendFrom, creator) {
  cc = fixAddressList(cc);
  const toSet = new Set((String(to).match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map((a) => a.toLowerCase()));
  const own = /chris/i.test(sendFrom || '') ? /chriscordero\.net$/i : /lindsay/i.test(sendFrom || '') ? /^collab@automateaiconsulting\.com$/i : /^noocapcollab@/i;
  const seen = new Set();
  return (String(cc).match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).filter((a) => { const k = a.toLowerCase(); if (toSet.has(k) || own.test(k) || seen.has(k)) return false; const c = creatorOfAddr(k); if (c && creator && c.toLowerCase() !== String(creator).toLowerCase()) return false; seen.add(k); return true; }).join(', ');
}

// Which inbox answers this brand. A thread that only lives in a creator's own inbox (Lindsay's: the brand never copies
// noocapcollab, so the deal holds a Message-ID instead of a Gmail thread id) is answered from that inbox, so the email
// lands in the same conversation on both sides. Hyper3D × Lindsay went out from noocapcollab as a new thread (Nov 3).
export function pickSender(deal, hasBox = () => false) {
  const t = String(deal?.threadId || '').trim();
  const gmailThread = /^[0-9a-f]{10,}$/i.test(t);
  const creator = String(deal?.creator || '');
  if (/^lindsay$/i.test(creator) && !gmailThread && (t || deal?.messageRfc) && hasBox('Lindsay')) return 'Lindsay';
  return 'noocapcollab';
}

// "within 5 business days" counts as filler too: Readdy x Lindsay got a first-cut promise of 5 business days (Nov 12) on
// Nov 5 when the brief said first draft Nov 6 and live Nov 9, and nothing flagged it (system check, Nov 5).
// Last look at every email before it is saved, whatever wrote it. Found in the Nov 3 audit: "we'll send it shortly"
// promises, "<UNKNOWN>" left in a sent email, Lindsay's emails signed "Chris's Team".
const FILLER = /\b(shortly|promptly|without delay|right away|within the next (few )?(hours?|days?)|within (\d+|one|two|three|four|five|a few|a couple of) (business |working )?(hours?|days?|weeks?)|as soon as possible|we'?re on it|will confirm (the )?timing|get (it|them|those|that) (over )?to you (soon|today|shortly)|(as soon as|once|the moment|(right|immediately|straight|just) after) (it'?s|it is|it goes|it'?s been|it has been|the (video|reel|post|content) (is|goes|has been)) (live|up|published|posted))\b|\b(we'?ll|we will|i'?ll|i will) (get|send|share)\b[^.\n]{0,60}\b(soon|today|tomorrow|shortly|later)\b|\b(we'?ll|we will|i'?ll|i will|we'?re going to)\b[^.\n]{0,60}\b(immediately|straight away|asap|right now)\b|\b(we'?ll|we will|i'?ll|i will|we'?re going to)\s+(post|publish|upload|put|get|have|go)\b[^.\n]{0,40}\b(today|tonight|tomorrow|soon|later|shortly|this week)\b|\b(we'?ll|we will|i'?ll|i will|we'?re going to)\s+(get|send|share|pass|forward|provide)\b[^.\n?]{0,60}\b(once|as soon as|when)\s+(it|they|that|this|the [a-z ]{2,30}?)\s*('s|'re| is| are)\s+(ready|available|done|finali[sz]ed|generated)\b|\b(putting|put) the (final )?finishing touches\b|\b(we'?re|we are|i'?m|i am) (finali[sz]ing|wrapping up)\b|\b(we'?re|we are|i'?m|i am)\s+(posting|publishing|uploading|putting|getting|sending|sharing|filming|producing|delivering)\b[^.\n]{0,60}\b(today|tonight|tomorrow|soon|later|shortly|right now|this week|next week)\b|\b(we|i|brad|chris|lindsay|valeri|duncan|nicole|emtech)('ll|'d| will| would| can| could| should| shall|'re able to| are able to| should be able to| will be able to)\b[^.\n]{0,60}\b(within (this|the|next) week|this week|next week|by (the )?end of (the |this |next )?week|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eow))\b|\b(we|i|brad|chris|lindsay|valeri|duncan|nicole|emtech|the (video|reel|post|content|cut)|it)('ll|'d| will| would| can| could| should| shall| aim to| aims to| plan to| plans to| expect to| expects to| are planning to| are aiming to| is planning to| is aiming to| is (set|scheduled|planned) to| are (set|scheduled) to|'re able to| are able to| should be able to| will be able to)\b[^.\n]{0,80}\b(?:(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(?:on|by|for) the \d{1,2}(?:st|nd|rd|th))\b|\b(our )?(earliest|expected|estimated|planned|target) (timeline|date|delivery|posting date|go-?live)\b[^.\n]{0,20}\b(is|would be|will be|is around)\b[^.\n]{0,40}\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|this week|next week)\b|\b(will|'ll|can|could|should|expect(s|ed)?( to)?|aim(s|ing)? to|plan(s|ning)? to|able to|be ready)\b[^.\n?]{0,80}\b(within (this|the|next|the next) week|within the next (few |couple of |two |three |\d+ )?weeks?|within (a|one|two|three|\d+) weeks?|(early |later |end of )?(this|next) week|by (the )?end of (the |this |next )?week|(on|by) (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b(?![^.\n]*\?)|\b(we|i|brad|chris|lindsay|valeri|duncan|nicole|emtech|the (video|reel|post|content|cut)|it)('ll| will| shall|'re going to| are going to| is going to)\b[^.\n?]{0,60}\b(post|publish|upload|posted|published|uploaded|go live|goes live|live)\b[^.\n?]{0,40}\b(now|today|tonight|tomorrow)\b|\b(we|i|brad|chris|lindsay|valeri|duncan|nicole|emtech|the (video|reel|post|content|cut)|it)('re|'s| are| is|'m| am)\s+(?:\w+\s+){0,3}?(posting|publishing|uploading|going live|going out|getting it (posted|live|published|up))\b[^.\n?]{0,40}\b(now|today|tonight|tomorrow)\b|\b(we|i|brad|chris|lindsay|valeri|duncan|nicole|emtech|the (video|reel|post|content|cut)|it)('ll|'d|'re|'s|'m| will| would| shall| is| are| am|'re going to| are going to| is going to)\b[^.\n?]{0,60}\b(post|publish|upload|posting|publishing|uploading|posted|published|uploaded|go live|goes live|live|up)\b[^.\n?]{0,40}(\b(immediately|straight away|asap|as we speak|at the earliest|any minute|momentarily|first thing|very soon|soon)\b(?!\s+(after|once|upon|following|when|as))|\bin (a|the next) (few|couple of) (hours|minutes)\b|\bas soon as (he|she|they|we|i) (can|could)\b)|\b(can|could|will|'ll|would|should|able to|be ready|make sure)\b[^.\n?]{0,80}\b(within|in|meet|hit|make|inside)\s+(this|that|the|your)\s+(time ?frame|timeline|deadline|window|schedule)\b|\b(this|that|the|your)\s+(time ?frame|timeline|deadline|schedule|window)\s+(works|is fine|is doable|is possible|suits)\b/i;
// The last branch: a timeline in weeks or weekdays with any subject ("the video will be ready within the next week",
// "it can be produced within this week", "we expect it ready by the end of next week"). The subject list above missed
// these, so test bank capcut-brad-answer-newest-nov19 kept failing on Gemini's wording (night system check, Nov 20).
// "we will post it now", "Chris will post it today" and "we are going ahead and posting it now" are the same dateless
// posting promise: the we/we'll branches above missed "now" and the creator as subject (test bank
// Any tense of our own posting with "immediately", "ASAP", "as we speak", "very soon", "in a few hours" or "as soon as he can"
// is the same dateless promise (capcut-chris-publish-asap-nov19 failed again at 19:30 UTC on Nov 21; bug hunter).
// capcut-chris-publish-asap-nov19 still failed at 18:46 and 19:56 UTC on Nov 20; bug hunter).
// "promptly" and "without delay" are "shortly" in other words (test bank capcut-chris-cleared-to-post-nov16 failed at 20:16 UTC
// on Nov 19 with a draft that said 'promptly'; bug hunter).
// "we are posting it today", "getting it posted right now" and "we can produce it within this week" are the same dateless
// promise in other words (test bank capcut-chris-publish-asap-nov19 and capcut-brad-answer-newest-nov19 kept failing after
// c2332e8, Nov 19; a timeline is Harsh's to give, rule 6; bug hunter).
// "we will post it today", "finishing touches" and "we're finalizing" are dateless promises too (test bank
// capcut-chris-publish-asap-nov19, Nov 19: Mia chased a posting we had promised for today; the answer is a time from Harsh).
// "immediately", "straight away" and "ASAP" after our own "we'll" are the same promise as "right away": the test bank's
// CapCut x Chris case (Nov 17) kept writing "we will publish it immediately", which slipped past the line above.
// Any fill-in left in square brackets counts, not only the six names above: the writer left "[adcode is]" in the
// CapCut x Chris reply (test bank capcut-chris-cleared-to-post-nov16, Nov 18) and the old list let it through, so an
// automatic send would have mailed it. A markdown link "[text](url)" is not a placeholder.
const PLACEHOLDER = /<\s*UNKNOWN\s*>|&lt;UNKNOWN&gt;|\[(?:name|brand|creator|date|link|amount)\]|\[[A-Za-z][A-Za-z _/'-]{1,40}\](?!\()|\{\{(?!invoice_link\}\})[^}]*\}\}/i;
export const hasPlaceholder = (body) => PLACEHOLDER.test(String(body || ''));
// A UID, account ID or code we give a brand must come from somewhere: the brand's email, the deal or Harsh's answer.
// The writer made one up for Dreamina x Chris (Nov 13: "Our Dreamina UID is 829104", a number nobody gave it, along with
// "currently filming" and "Nov 15 works for us"). sources = the text the draft was written from; without it nothing is checked.
const CODE_CLAIM = /\b(?:UID|user\s*ID|account\s*(?:ID|number)|ID|promo\s*code|discount\s*code|coupon(?:\s*code)?|ad\s*code|spark\s*(?:ad\s*)?code|code)\b\s*(?:is|:|=|-|of)?\s*["“'`]?([A-Za-z0-9][A-Za-z0-9_-]{3,})/gi;
export function inventedCodes(body, sources) {
  if (sources == null) return [];
  const src = String(sources).toLowerCase();
  const out = [];
  for (const m of String(body || '').matchAll(CODE_CLAIM)) {
    const tok = m[1];
    if (!/\d/.test(tok)) continue; // "the code is ready" is not a code
    if (!src.includes(tok.toLowerCase()) && !out.includes(tok)) out.push(tok);
  }
  return out;
}
// Lesson "Don't send 'ignore this' emails unless the error is critical" (Draft rejected, Nov 19) had no code guard: a
// correction asking the brand to ignore or disregard our last email draws attention to a slip they likely missed, so
// one is Harsh's decision and never sends on its own (bug hunter, Nov 20).
const IGNORE_LAST = /\b(please |kindly )?(ignore|disregard)\b[^.\n]{0,30}\b(my|our|the|that|this)\b[^.\n]{0,20}\b(last|previous|earlier|prior|above|other)?\s*(e-?mail|message|note|reply)\b/i;
export function checkDraft({ body = '', creator = '', threadId = '', sources }) {
  let out = String(body || '');
  const issues = [];
  const made = inventedCodes(out, sources);
  if (made.length) issues.push(`it gives the brand ${made.join(', ')}, which is not in their email, the deal or your WhatsApp answer: it was made up. Reject it and send the real value from WhatsApp`);
  // A Message-ID (has "@") stored as the Gmail thread: the email would not land in the brand's thread
  if (/@/.test(String(threadId || ''))) issues.push('the deal has an email Message-ID where the Gmail thread id should be, so this may not land in the brand\'s thread');
  if (creator) out = out.replace(/(\n\s*(?:Best|Thanks|Cheers|Regards|Thank you),?\s*\n\s*)([A-Z][\w ]{1,30})'s Team(\s*)$/i, (m, pre, name, end) => (name.trim().toLowerCase() === String(creator).toLowerCase() ? m : `${pre}${creator}'s Team${end}`));
  if (PLACEHOLDER.test(out)) issues.push('it still has a placeholder in it');
  if (FILLER.test(out)) issues.push('it promises to send something later instead of giving it (ask on WhatsApp what to send, or reject)');
  if (IGNORE_LAST.test(out)) issues.push('it asks the brand to ignore or disregard an earlier email: that is only for a critical error, so it is your call');
  return { body: out, issues };
}

export function invoiceEmailFilter(stripeInvoice) {
  const id = (String(stripeInvoice || '').match(/in_[A-Za-z0-9]+/) || [''])[0];
  if (!id) return null;
  return { and: [{ property: 'Stripe Invoice', rich_text: { contains: id } }, { or: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Status', select: { equals: 'Sent' } }] }] };
}

export async function createDraft({ kind, deal, subject, body, to, cc, attach = 'None', video, why, notify = true, sendFrom, leadId, context, files, stripeInvoice, sendFile, sameAs }) {
  // Replies written from a brand email are checked against that email and the deal for made-up codes (Dreamina, Nov 13)
  const sources = kind === 'Reply' && context && !leadId ? [context, deal ? JSON.stringify(deal) : ''].join('\n') : undefined;
  { const c = checkDraft({ body, creator: deal?.creator, threadId: deal?.threadId, sources }); body = c.body;
    // A fixed reply from Reply Templates is Harsh's own wording, timing line included ("we'll get it posted as soon as
    // possible", billing_on_approval, Nov 18), so only a leftover placeholder or made-up code marks it Needs you. Before
    // this the filler check stamped "Needs you" here and autoHoldReason held it whatever cef6c2dd allowed (Emergent x
    // Chris and CapCut x Chris billing asks sat in Approvals, bug hunter Nov 18)
    // The loop-in reply is Harsh's fixed wording too (Nov 13, "we'll start on the script straight away"): since 7729f99
    // added "straight away" to the filler check it was held as Needs you (Fotor x Duncan, night check Nov 18)
    if (/\[template:[a-z_]+\]/.test(why || '') || /^Loop-in reply/.test(why || '')) c.issues = c.issues.filter((i) => !/promises to send/.test(i));
    if (c.issues.length && !/^Needs you/i.test(why || '')) why = `Needs you: ${c.issues.join('; ')} · ${why || ''}`;
    // A made-up code is said even on a draft that already needs Harsh, so he never approves it unseen
    else if (c.issues.some((i) => /made up/.test(i))) why = `Needs you: ⚠️ ${c.issues.find((i) => /made up/.test(i))} · ${String(why || '').replace(/^Needs you:\s*/i, '')}`; }
  body = noDashes(body);
  if (subject) subject = noDashes(subject);
  if (leadId) {
    // One live draft per lead: a newer situation replaces the older draft
    const old = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 10, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Lead', relation: { contains: leadId } }] } }).catch(() => ({ results: [] }));
    for (const o of old.results || []) await notion('PATCH', `/pages/${o.id}`, { properties: { Status: { select: { name: 'Rejected' } } } }).catch(() => {});
  } else if (deal?.id) {
    // One email per Stripe invoice: the heartbeat read the deal while Harsh's WhatsApp invoice draft was still a Stripe
    // draft, so a second invoice email for the same Stripe invoice landed in Approvals a minute after the first was sent
    // (ChatGPT x Duncan, in_1UYKs2…, Nov 5). Waiting or already sent, the same invoice is never drafted again.
    if (invoiceEmailFilter(stripeInvoice)) {
      const dup = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 1, filter: invoiceEmailFilter(stripeInvoice) }).catch(() => ({ results: [] }));
      if ((dup.results || []).length) return { skipped: true, reason: 'An email for this Stripe invoice is already waiting or sent', id: dup.results[0].id };
    }
    const existing = await pendingDraft(deal.id, kind);
    // One waiting draft per deal and kind, except: a Reply to a different email thread, or a cut email for a different
    // video (sameAs = text that marks the same item, e.g. its Frame.io link) is a separate email and is kept
    const exBody = existing ? (existing.properties?.Body?.rich_text || []).map((t) => t.plain_text).join('') : '';
    const exThread = existing ? (existing.properties?.['Gmail Thread ID']?.rich_text || []).map((t) => t.plain_text).join('') : '';
    // A file Harsh sent on WhatsApp is a new email of its own, even when another draft for the deal is waiting (system check, Nov 4)
    const other = existing && ((sendFile?.length > 0) || (kind === 'Reply' && deal.threadId && exThread && exThread !== deal.threadId) || (sameAs && !exBody.includes(sameAs)));
    if (existing && !other) return { skipped: true, reason: 'A draft of this kind is already waiting', id: existing.id };
  }
  // Replies stay in the brand's thread: Gmail needs the same subject for that
  const inThread = deal?.threadSubject && (deal?.threadId || deal?.messageRfc);
  // Never address a brand email to our own side (noocapcollab or a creator's own team): use the brand address
  // from the thread's Cc instead, and if there is none, leave To empty so it can't send until someone fills it in
  const addrs = (v) => String(v || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
  let toAddr = to || deal?.brandEmail || '';
  if (addrs(toAddr).length && addrs(toAddr).every(oursAddr)) {
    const brandCc = addrs(cc || deal?.threadCc || '').find((a) => !oursAddr(a));
    if (brandCc) { cc = [toAddr, cc || deal?.threadCc || ''].join(', '); toAddr = brandCc; }
    else { why = `⚠️ No brand address on this deal, add one in To before sending · ${why || ''}`; toAddr = ''; }
  }
  // Second reader on every brand email before it reaches Approvals: a problem it finds marks the draft "Needs you" so it
  // is never auto-sent and Harsh sees why (shadow mode only logs). Lead outreach skips it.
  // The loop-in reply is Harsh's own fixed wording with no facts in it (Nov 13): nothing for the second reader to check,
  // and its lessons about contracts flagged it by mistake, so it never sent (Vmake AI x Lindsay)
  // Fixed replies are Harsh's own wording too (Nov 17: the AI second reader called the timing he chose, "within 2 to 3
  // working days", a filler promise and held HoneyBook's script reply). They skip it, which also keeps them free of AI cost.
  if (deal?.id && !leadId && !/^Loop-in reply/.test(why || '') && !/\[template:[a-z_]+\]/.test(why || '')) {
    try {
      const V = await import('./verify.js');
      const mode = V.MODE();
      if (mode !== 'off') {
        const convo = await (await import('./memory.js')).readTranscript(deal.id, 10000).catch(() => '');
        // The email greets one brand person but is addressed to another (Manyfast x Chris, Nov 18: "Hi Seungjoo" to
        // jun@, the billing contact, while Seungjoo asked for all content mail): send it To the person it greets
        const greeted = greetedAddress(body, convo);
        if (greeted && !addrs(toAddr).includes(greeted)) { cc = [toAddr, cc || deal?.threadCc || ''].filter(Boolean).join(', '); toAddr = greeted; }
        // Rule 2 (Runway draft To SpeakOn's Cassie, Nov 3; lesson "Reply to the correct person in their own thread",
        // Nov 18): an address that never appears in this deal's conversation, contact or Cc holds the draft for Harsh,
        // whatever mode the second reader runs in
        const stranger = strangerRecipient(toAddr, deal, convo);
        if (stranger && !/^Needs you/i.test(why || '')) why = `Needs you: ${stranger} never wrote in this deal's thread, check the address before sending · ${why || ''}`;
        const v = await V.checkDraftWithReader({ kind, deal, to: toAddr, body, why, convo, attach: attachLabel({ attach, sendFile, files }) });
        // "Wrong person" when the email goes to someone at the brand who is already in this deal (the brand contact or
        // anyone from the brand who wrote in the thread) is not a problem: brands split content and payment between
        // people (Manyfast x Chris, Nov 18: the cut went to Seungjoo, the content contact, and was held because Jun had
        // written last about the invoice). A guess that ends in "but wait" is not a finding either.
        v.problems = dropKnownContactFlags(v.problems, toAddr, deal, convo, body);
        v.problems = dropAttachedFileFlags(v.problems, { attach, sendFile, files });
        v.ok = v.ok || !v.problems.length;
        if (!v.ok) {
          const { log } = await import('./briefs.js');
          await log({ event: `Second read flags a ${kind} draft${mode === 'shadow' ? ' (shadow)' : ''}: ${deal.brand} × ${deal.creator || '?'}`.slice(0, 118), outcome: 'Needs approval', email: { messageId: '' }, deal, details: v.problems.join('\n'), cost: v.cost, creator: deal.creator }).catch(() => {});
          if (secondReadHolds(mode) && !/^Needs you/i.test(why || '')) why = `Needs you: second check says ${v.problems.join('; ')} · ${why || ''}`;
        }
      }
    } catch (e) { console.error('draft second read', e.message); }
  }
  const finalSubject = inThread ? 'Re: ' + threadSubject(deal.threadSubject) : (subject || `${deal?.brand || ''} × ${deal?.creator || ''}`);
  const props = {
    Subject: { title: rt(finalSubject) },
    Status: { select: { name: 'Draft' } },
    Kind: { select: { name: kind } },
    To: { rich_text: rt(toAddr) },
    Cc: { rich_text: rt(cleanCc(cc || deal?.threadCc || '', toAddr, sendFrom, deal?.creator)) },
    Body: { rich_text: rtLong(body) },
    Attach: { select: { name: attach } },
    Why: { rich_text: rt(why || '') },
    'Reply To Message ID': { rich_text: rt(deal?.messageRfc || '') },
    'Gmail Thread ID': { rich_text: rt(deal?.threadId || '') },
  };
  if (deal?.id && !leadId) props.Deal = { relation: [{ id: deal.id }] };
  if (stripeInvoice) props['Stripe Invoice'] = { rich_text: rt(stripeInvoice) };
  if (sendFile?.length) props['Send File'] = { files: sendFile };
  if (leadId) props.Lead = { relation: [{ id: leadId }] };
  props['Send From'] = { select: { name: sendFrom || 'noocapcollab' } };
  if (deal?.creator) props.Creator = { select: { name: deal.creator } };
  if (video) props.Video = { url: video };
  if (!costColumn) { costColumn = true; await notion('PATCH', `/data_sources/${OUTBOX_DS}`, { properties: { 'Cost USD': { number: {} }, Context: { rich_text: {} }, 'Brand Files': { files: {} } } }).catch(() => {}); }
  if (context) props.Context = { rich_text: rtLong(String(context).slice(0, 4000)) };
  // Files the brand attached to the email this draft answers (a contract, a brief, an invoice): saved on the draft so
  // they can be downloaded from Approvals. Names without data still show, with a link to open the thread in Gmail.
  const brandFiles = await saveBrandFiles(files);
  if (brandFiles.uploaded.length) props['Brand Files'] = { files: brandFiles.uploaded };
  if (brandFiles.names.length) props.Context = { rich_text: rtLong((context ? String(context).slice(0, 3600) + '\n\n' : '') + 'Attached: ' + brandFiles.names.join(', ')) };
  if (lastWriteCost) { props['Cost USD'] = { number: Math.round(lastWriteCost * 10000) / 10000 }; lastWriteCost = 0; }
  const page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: OUTBOX_DS }, properties: props });
  if (notify) {
    const link = appUrl() ? `\n→ [Review in Approvals](${appUrl()}/#approvals)` : '';
    await discord(`📬 **${deal?.brand || '?'} × ${deal?.creator || '?'} · ${kind.toLowerCase()} email to approve**${why ? '\n• ' + String(why).slice(0, 160) : ''}${to || deal?.brandEmail ? '' : '\n• ⚠️ no brand email on the deal'}${link}`, 'pm');    // and on WhatsApp, with Send / Reject buttons
    try { const W = await import('./whatsapp.js'); await W.alertDraft(page.id); } catch (e) { console.error('WhatsApp draft alert failed', e.message); }
  }
  return { created: true, id: page.id };
}

// Inline images in signatures (logos, icons) are skipped; real documents and media are kept, up to 4 files of 20 MB
async function saveBrandFiles(files) {
  const out = { uploaded: [], names: [] };
  const real = (files || []).filter((a) => a && (a.filename || a.data) && !(/^image\//i.test(a.mimeType || '') && /^(image\d*|outlook|logo|icon|signature)/i.test(a.filename || '') && Number(a.size || 0) < 60000));
  for (const a of real.slice(0, 4)) {
    out.names.push(a.filename || 'file');
    if (!a.data || Buffer.byteLength(String(a.data), 'base64') > 20e6) continue;
    const id = await uploadToNotion(a);
    if (id) out.uploaded.push({ type: 'file_upload', file_upload: { id }, name: String(a.filename || 'file').slice(0, 100) });
  }
  return out;
}

// The video cards whose scripts go with a Script email: the Video card, plus any listed in Context as
// "Script cards: <url> <url>" when several cards of one deal reached Script Approval together (CapCut × Lindsay, Nov 16)
export function scriptCardUrls(d) {
  const extra = (String(d?.context || '').match(/Script cards:([^\n]*)/i)?.[1] || '').match(/https?:\/\/\S+/g) || [];
  const seen = new Set();
  return [d?.video, ...extra].filter(Boolean).filter((u) => { const id = pageIdFromUrl(u); if (!id || seen.has(id)) return false; seen.add(id); return true; });
}

async function scriptPdfs(d, brand, creator) {
  const urls = scriptCardUrls(d);
  if (!urls.length) throw new Error('No video page is linked to attach the script from.');
  const out = [];
  for (const u of urls) out.push(await buildScriptPdf({ pageId: pageIdFromUrl(u), brand, creator }));
  return out.length === 1 ? out[0] : out;
}

// A card that reached Script Approval while its deal's Script email was still waiting joins that email (one email,
// all the PDFs) instead of making a second one (Harsh, Nov 16)
export async function addScriptCards(draftId, urls, body, why) {
  const page = await notion('GET', `/pages/${draftId}`);
  const d = readDraft(page);
  const all = scriptCardUrls({ video: d.video, context: `Script cards: ${[...scriptCardUrls(d), ...urls].join(' ')}` });
  const ctx = String(d.context || '').replace(/Script cards:[^\n]*\n?/i, '').trim();
  const props = { Context: { rich_text: rtLong(`Script cards: ${all.join(' ')}${ctx ? '\n' + ctx : ''}`) } };
  if (body) props.Body = { rich_text: rtLong(noDashes(body)) };
  // keep the "Sends on its own…" note the waiting draft had, so Approvals still says it will go out by itself
  if (why) props.Why = { rich_text: rt(`${why}${(d.why.match(/ Sends on its own[^.]*\./) || [''])[0]}`) };
  await notion('PATCH', `/pages/${draftId}`, { properties: props });
  return all;
}

export async function readDraftById(id) { return readDraft(await notion('GET', `/pages/${id}`)); }

function readDraft(p) {
  const g = (n) => plain(p.properties?.[n]);
  const rel = p.properties?.Deal?.relation || [];
  return {
    id: p.id, url: p.url, subject: g('Subject') || '', status: g('Status'), kind: g('Kind'), to: g('To') || '', cc: g('Cc') || '',
    body: (p.properties?.Body?.rich_text || []).map((t) => t.plain_text).join(''), attach: g('Attach') || 'None', why: g('Why') || '',
    creator: g('Creator'), video: g('Video'), replyTo: g('Reply To Message ID') || '', threadId: g('Gmail Thread ID') || '',
    dealId: rel[0]?.id || null, created: p.created_time, error: g('Error') || '',
    leadId: (p.properties?.Lead?.relation || [])[0]?.id || null, sendFrom: g('Send From') || 'noocapcollab',
    context: (p.properties?.Context?.rich_text || []).map((t) => t.plain_text).join(''),
    stripeInvoice: g('Stripe Invoice') || '',
    // Notion hands out a fresh download link (valid for an hour) on every read
    files: (p.properties?.['Brand Files']?.files || []).map((f) => ({ name: f.name, url: f.file?.url || f.external?.url || '' })).filter((f) => f.url),
    gmail: gmailLink(g('Gmail Thread ID'), g('Send From')),
  };
}

// Opens the thread in the right Gmail account (the one the draft sends from)
function gmailLink(threadId, sendFrom) {
  if (!threadId) return '';
  // Creator inboxes outside Gmail (Lindsay's PrivateEmail) open in their own webmail; no deep link to the thread exists
  if (sendFrom && !/chris|noocap/i.test(sendFrom)) return process.env[`${String(sendFrom).toUpperCase()}_WEBMAIL`] || 'https://privateemail.com/appsuite/';
  const box = /chris/i.test(sendFrom || '') ? (process.env.CHRIS_INBOX || 'collab@chriscordero.net') : (process.env.NOOCAP_INBOX || 'noocapcollab@gmail.com');
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(box)}#all/${threadId}`;
}

// Keep the header (From/Date) and the newest message, drop the quoted history under it
function latestOnly(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l, i) => i > 3 && /^\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From:\s.+|>)/i.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim().slice(0, 3000);
}

export async function listDrafts() {
  const res = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, {
    page_size: 50,
    filter: { or: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Status', select: { equals: 'Failed' } }] },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });
  const drafts = (res.results || []).filter((p) => !p.in_trash).map(readDraft);
  // Brand names for display: each deal or lead page is read once, a few at a time, and the whole step gives up after
  // 20 seconds (a busy Notion must not stop Approvals from loading; the brand then comes from the email itself)
  const guess = (d) => (d.why.match(/^(?:Needs you: )?(.+?) asked:/) || [])[1] || (d.to.split('@')[1] || '').split('.')[0] || 'Brand';
  for (const d of drafts) d.brand = guess(d);
  const ids = [...new Set(drafts.map((d) => d.leadId || d.dealId).filter(Boolean))];
  const pages = new Map();
  const until = Date.now() + 20000;
  for (let i = 0; i < ids.length && Date.now() < until; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map((id) => Promise.race([notion('GET', `/pages/${id}`), new Promise((_, no) => setTimeout(() => no(new Error('slow')), Math.max(1000, until - Date.now())))]).then((p) => pages.set(id, p)).catch(() => {})));
  }
  for (const d of drafts) {
    const pg = pages.get(d.leadId || d.dealId);
    if (!pg) continue;
    if (d.leadId) {
      d.brand = plain(pg.properties?.Brand) || d.brand; d.dealUrl = pg.url;
      // The message this draft answers: the latest email in the thread (stored on the lead), else the lead's summary
      if (!d.context) {
        const thread = (pg.properties?.['Thread Text']?.rich_text || []).map((t) => t.plain_text).join('');
        d.context = thread ? latestOnly(thread) : plain(pg.properties?.Offer) ? 'Summary of the thread: ' + plain(pg.properties?.Offer) : '';
      }
    } else { d.brand = plain(pg.properties?.['Brand Name']) || d.brand; d.dealUrl = pg.url; }
  }
  for (const d of drafts) d.standard = isStandardQuote(d);
  return drafts;
}

export async function saveDraft(id, { subject, body, to, cc }) {
  const props = {};
  if (subject !== undefined) props.Subject = { title: rt(subject) };
  if (body !== undefined) props.Body = { rich_text: rtLong(body) };
  if (to !== undefined) props.To = { rich_text: rt(to) };
  if (cc !== undefined) props.Cc = { rich_text: rt(cc) };
  if (Object.keys(props).length) await notion('PATCH', `/pages/${id}`, { properties: props });
}

export async function rejectDraft(id) {
  await notion('PATCH', `/pages/${id}`, { properties: { Status: { select: { name: 'Rejected' } } } });
  // Rejecting a follow-up to a lead means "stop chasing this one": otherwise the next run would draft it again.
  // A reply from the brand still reopens the conversation as normal.
  try {
    const d = readDraft(await notion('GET', `/pages/${id}`));
    if (d.kind === 'Invoice' && d.stripeInvoice && d.dealId) {
      const { discardDraftInvoice } = await import('./invoicing.js');
      await discardDraftInvoice(d.dealId, d.stripeInvoice).catch(() => {});
    }
    if (d.kind === 'Lead follow-up' && d.leadId) {
      await notion('PATCH', `/pages/${d.leadId}`, { properties: { 'Follow-ups': { number: 3 }, 'Next Step': { rich_text: rt('Follow-ups stopped: Harsh rejected the follow-up') } } });
    }
  } catch { /* the draft is rejected either way */ }
}

// A file Harsh sent (WhatsApp) to go out with this email, saved on the draft's Send File column
async function sentFileAttachment(draftPage) {
  const f = (draftPage.properties?.['Send File']?.files || [])[0];
  if (!f) throw new Error('The file to send is missing from this email (Send File). Send it again.');
  const res = await fetch(f.file?.url || f.external?.url);
  if (!res.ok) throw new Error('Could not download the file from Notion.');
  return { filename: f.name || 'file.pdf', mimeType: res.headers.get('content-type') || 'application/pdf', data: Buffer.from(await res.arrayBuffer()).toString('base64') };
}

async function invoiceAttachment(dealPage) {
  const files = dealPage.properties?.['Invoice File']?.files || [];
  const f = files[0];
  if (!f) throw new Error('The deal has no Invoice File to attach.');
  const url = f.file?.url || f.external?.url;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the invoice file from Notion.');
  const buf = Buffer.from(await res.arrayBuffer());
  return { filename: f.name || 'Invoice.pdf', mimeType: res.headers.get('content-type') || 'application/pdf', data: buf.toString('base64') };
}

// Links clickable in already-escaped text. A full stop, comma or bracket right after a link ends the sentence, not the
// link (Nov 10: "https://f.io/bTfgtvKC." opened a broken Frame.io page for ElevenLabs)
export const linkify = (escaped) => String(escaped).replace(/https?:\/\/[^\s<>"]+/g, (u) => {
  const tail = (u.match(/[.,;:!?)\]'*]+$/) || [''])[0];
  const url = tail ? u.slice(0, -tail.length) : u;
  return `<a href="${url}">${url}</a>${tail}`;
});
const toHtml = (text) => linkify(String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).replace(/\n/g, '<br>');

// The lead's stored thread (latest email with the earlier ones quoted under it) as a reply quote block
function quoteThread(leadPage) {
  const t = (leadPage?.properties?.['Thread Text']?.rich_text || []).map((x) => x.plain_text || x.text?.content || '').join('');
  const m = t.match(/^From:\s*(.*)\nDate:\s*(.*)\n\n([\s\S]*)$/);
  if (!m || !m[3].trim()) return null;
  const [, from, date, body] = m;
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = `On ${date.trim() || 'an earlier date'}, ${from.trim() || 'the brand'} wrote:`;
  const quoted = body.trim().split('\n').map((l) => '> ' + l).join('\n');
  const linked = linkify(esc(body.trim())).replace(/\n/g, '<br>');
  return {
    text: `\n\n${head}\n${quoted}\n`,
    html: `<br><div class="gmail_quote"><div>${esc(head)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${linked}</blockquote></div>`,
  };
}

// The earlier emails quoted under our reply, newest first, the way a mail app does when you press Reply. Mail apps
// that don't group conversations (Lindsay's PrivateEmail) only show history that is quoted in the body itself
// (Harsh, Nov 10: the Readdy first-cut email looked like a new email there while Pippit's replies carried the thread).
// lines = the deal's 📨 transcript, oldest first. Up to 4 messages, each body cut at 1,500 characters.
export function quoteHistory(lines = [], { ours = 'Our team', max = 4 } = {}) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const msgs = [];
  for (let i = lines.length - 1; i >= 0 && msgs.length < max; i--) {
    const m = String(lines[i]).match(/^📨\s*(\S+)\s*·\s*(.*?)\s*·[^\n]*\n([\s\S]*)$/);
    if (!m || !m[3].trim()) continue;
    const who = /^us\b/i.test(m[2]) ? ours : m[2].replace(/^(brand|creator)\s*\((.*)\)$/i, '$2').replace(/"/g, '').trim();
    // Older records kept HTML line breaks as text (the Nov 9 tool-access emails): show them as real line breaks
    msgs.push({ date: m[1], who, body: m[3].replace(/<br\s*\/?>/gi, '\n').replace(/(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'])[.,;:!?)\]']+(?=\s|$)/g, '$1') /* quoted links too: no full stop stuck to them */.replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500) });
  }
  if (!msgs.length) return null;
  let text = '', html = '';
  for (const q of msgs) {
    const head = `On ${q.date}, ${q.who} wrote:`;
    text += `\n\n${head}\n${q.body.split('\n').map((l) => '> ' + l).join('\n')}`;
    html += `<div class="gmail_quote" style="margin-top:14px"><div>${esc(head)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${linkify(esc(q.body)).replace(/\n/g, '<br>')}</blockquote></div>`;
  }
  return { text: text + '\n', html: '<br><br>' + html };
}

// Approve = send through n8n, then update the deal
// The exact file that will go with this email (script PDF built from the video page now, or the invoice), for a preview
export async function previewAttachment(id) {
  const d = readDraft(await notion('GET', `/pages/${id}`));
  if (d.stripeInvoice) {
    const [, invId] = d.stripeInvoice.split('|');
    let creator = d.creator;
    let pd = '';
    if (d.dealId) { try { const dp = await notion('GET', `/pages/${d.dealId}`); creator = plain(dp.properties?.Creator) || creator; pd = plain(dp.properties?.['Payment Details']) || ''; } catch { /* use the draft's */ } }
    const I = await import('./invoicing.js');
    // A PDF, so WhatsApp can show it under the draft card (it can't open HTML)
    try { return await I.previewInvoicePdf(creator, invId, { creator, paymentDetails: pd }); } catch (e) { console.error('invoice pdf preview', e.message); }
    const html = await I.previewInvoiceHtml(creator, invId);
    return { filename: 'Invoice preview.html', mimeType: 'text/html; charset=utf-8', data: Buffer.from(html).toString('base64') };
  }
  if (d.attach === 'Script PDF') {
    let brand = d.brand, creator = d.creator;
    if (d.dealId) { try { const dp = await notion('GET', `/pages/${d.dealId}`); brand = plain(dp.properties?.['Brand Name']); creator = plain(dp.properties?.Creator) || creator; } catch { /* use the draft's */ } }
    const pdfs = await scriptPdfs(d, brand, creator);
    // the preview shows the first one; the email carries all of them
    return Array.isArray(pdfs) ? pdfs[0] : pdfs;
  }
  if (d.attach === 'Invoice') {
    if (!d.dealId) throw new Error('No deal linked to this email.');
    const a = await invoiceAttachment(await notion('GET', `/pages/${d.dealId}`));
    if (!a) throw new Error('No invoice file on the deal yet.');
    return a;
  }
  if (d.attach === 'File') return sentFileAttachment(await notion('GET', `/pages/${id}`));
  throw new Error('This email has no attachment.');
}

// The one gate for every email the PM sends ON ITS OWN (follow-ups, fixed replies, cut emails, contracts, link resends,
// lead chases). Harsh's Send button still uses approveAndSend directly. "No filler promises or placeholders" was a lesson
// seen 12 times: the writer was told, the last look flagged it as "Needs you", and auto-send paths still sent some of
// them (CapCut x Chris, Nov 16: "we will publish it right away"). Now a flagged or filler draft never leaves on its own:
// it stays in Approvals as Needs you and Harsh hears about it once.
// The brand address of the person an email greets ("Hi Seungjoo,"), from this deal's conversation: the sender whose
// display name has that name, else the one who signs their emails with it ("Seungjoo (Konan)" from konan@). null if
// none or more than one address fits.
// The first To address that has no link to this deal: not the deal's Brand Email or Thread CC and never seen in its
// conversation. Company domains count as a whole (anyone at the brand); free-mail addresses must match exactly.
// Returns null when the conversation could not be read (nothing to compare with) or every address is known. Pure.
const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|icloud|live|aol|proton|protonmail|me|gmx|zoho)\./i;
export function strangerRecipient(to = '', deal = {}, convo = '') {
  const known = [deal?.brandEmail, deal?.threadCc, convo].join(' ').toLowerCase();
  if (!String(convo || '').trim()) return null;
  const list = String(to || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
  for (const a of list.map((x) => x.toLowerCase())) {
    if (oursAddr(a)) continue;
    const dom = a.split('@')[1];
    const seen = FREE_MAIL.test(dom) ? known.includes(a) : known.includes('@' + dom) || known.includes('.' + dom);
    if (!seen) return a;
  }
  return null;
}

export function greetedAddress(body = '', convo = '') {
  const name = (String(body || '').replace(/<br\s*\/?>/gi, '\n').match(/^\s*(?:hi|hello|hey|dear)\s+([A-Za-z][A-Za-z'-]{1,30})\b/i) || [])[1];
  if (!name || /^(team|there|all|everyone)$/i.test(name)) return null;
  const re = new RegExp(`\\b${name}\\b`, 'i');
  const blocks = String(convo || '').split(/\n\n(?=📨 )/).map((b) => ({ head: b.split('\n')[0], text: b })).filter((b) => /· brand \(/.test(b.head));
  const addrOf = (h) => ((h.match(/<?([\w.+-]+@[\w.-]+\.\w+)>?\)/) || [])[1] || '').toLowerCase();
  const byName = new Set(blocks.filter((b) => re.test((b.head.match(/· brand \(([^<)]*)/) || [])[1] || '')).map((b) => addrOf(b.head)).filter(Boolean));
  if (byName.size === 1) return [...byName][0];
  if (byName.size > 1) return null;
  const bySig = new Set(blocks.filter((b) => re.test(b.text.split('\n').slice(-8).join('\n'))).map((b) => addrOf(b.head)).filter(Boolean));
  return bySig.size === 1 ? [...bySig][0] : null;
}
// Second-reader problems that aren't real: "wrong person" for a brand-side address already on this deal, and guesses the
// reader trailed off on ("but wait")
// The file goes on at send time (Script PDF from the card, Invoice from Stripe, File from Send File), so the draft the
// second reader sees has no attachment yet. It flagged every script email as "says attached but no file is attached"
// and held scripts that should go on their own (Runway AI x Chris and CapCut x Lindsay, Nov 19 21:55 and 22:55 UTC,
// bug hunter). When the email does carry a file, such a flag is dropped. Pure.
export function attachLabel({ attach = 'None', sendFile, files } = {}) {
  const has = (attach && attach !== 'None') || (Array.isArray(sendFile) && sendFile.length > 0);
  return has ? `${attach && attach !== 'None' ? attach : 'File'} (attached automatically when it sends)` : (Array.isArray(files) && files.length ? '' : 'none');
}
export function dropAttachedFileFlags(problems = [], { attach = 'None', sendFile } = {}) {
  const has = (attach && attach !== 'None') || (Array.isArray(sendFile) && sendFile.length > 0);
  if (!has) return problems || [];
  return (problems || []).filter((p) => !/\b(no|not|without|missing|isn'?t|is not|are not|aren'?t)\b[^.;]{0,60}\battach|\battach\w*\b[^.;]{0,60}\b(no|not|missing|without)\b[^.;]{0,30}\b(file|attachment|pdf|script|document)s?\b/i.test(String(p || '')));
}
export function dropKnownContactFlags(problems = [], to = '', deal = {}, convo = '', body = '') {
  const addrs = (String(to || '').toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/g) || []);
  const known = new Set([...(String(deal?.brandEmail || '').toLowerCase().match(/[\w.+-]+@[\w.-]+\.\w+/g) || []),
    ...[...String(convo || '').matchAll(/· brand \([^)]*?<?([\w.+-]+@[\w.-]+\.\w+)>?\)/gi)].map((m) => m[1].toLowerCase())]);
  const g = greetedAddress(body, convo);
  const toKnown = addrs.length > 0 && addrs.every((a) => known.has(a)) && (!g || addrs.includes(g));
  return (problems || []).filter((p) => {
    const t = String(p || '');
    if (/\bbut wait\b|\bactually,? (it|this) (may|might) be fine\b/i.test(t)) return false;
    if (toKnown && /wrong (person|recipient|contact)|addressed to\b[^.]*\bbut\b[^.]*\b(latest|last) (message|email)\b/i.test(t)) return false;
    return true;
  });
}
export function autoHoldReason(d) {
  if (/^Needs you/i.test(String(d?.why || ''))) return String(d.why).replace(/^Needs you:\s*/i, '').split(' · ')[0].slice(0, 200) || 'it was flagged for you';
  const c = checkDraft({ body: d?.body || '', creator: d?.creator });
  // A fixed reply from Reply Templates is Harsh's own wording: its timing line ("we'll post it as soon as possible",
  // Harsh, Nov 18) is meant, so only a leftover placeholder holds it
  const fixed = /\[template:|^Loop-in reply/.test(String(d?.why || ''));
  const bad = c.issues.filter((i) => (fixed ? /placeholder/ : /placeholder|promises to send|ignore or disregard/).test(i));
  return bad.length ? bad.join('; ') : null;
}
// A last check before sending refused the email ("Not sent: ..."), so nothing left. Pure: the reason, or null for any
// other error (a send that failed on the way out, or a draft rejected while the send was being prepared).
export function guardRefusal(e) {
  const m = String(e?.message || e || '');
  if (!/^Not sent:\s/.test(m) || /rejected while the send/i.test(m)) return null;
  return m.replace(/^Not sent:\s*/, '').slice(0, 300);
}
async function holdForHarsh(id, d, why) {
  await notion('PATCH', `/pages/${id}`, { properties: { Why: { rich_text: rtLong(`Needs you: held from sending on its own, ${why} · ${d.why}`.slice(0, 1900)) } } }).catch(() => {});
  try { const { discord, card } = await import('./briefs.js'); await discord(`✋ ` + card(`Held an email instead of sending it: ${String(d.subject || '').slice(0, 90)}`, [`Why: ${why}`, 'It is waiting in Approvals: fix it and send, or reject it'], d.url, 'Open the email'), 'pm'); } catch { /* the hold itself is what matters */ }
  return { held: true, why };
}
export async function autoSend(id) {
  const d = await readDraftById(id);
  const why = autoHoldReason(d);
  if (!why) {
    // Bug hunter Nov 23 (Dreamina x Chris, Runway AI x Chris): the send guard refused two script drafts ("these scripts
    // already went to the brand") on every heartbeat for hours, while Approvals still said "Sends on its own in 30 min"
    // and Harsh had been told the script was going. A refusal now holds the draft for Harsh once, like any other hold.
    try { return await approveAndSend(id); } catch (e) {
      const stop = guardRefusal(e);
      if (!stop) throw e;
      return holdForHarsh(id, d, stop);
    }
  }
  if (/^Needs you/i.test(d.why)) return { held: true, why }; // already waiting for Harsh, already told
  return holdForHarsh(id, d, why);
}

// One send per draft (Luma x Chris, Nov 19: Harsh tapped Send in Approvals while Claude called sendoutbox on the same
// draft, both passed the "is it still a Draft" check and the brand got the email twice). A send first writes its own
// claim into Error, waits a moment and reads it back: only the send whose claim is still there goes ahead, and any
// other send that starts while a fresh claim stands is refused.
const CLAIM_RE = /^Sending now · (\w+) · (\d+)/;
const CLAIM_TTL = 3 * 60 * 1000;
export function sendClaimState(error, token, now = Date.now()) {
  const m = CLAIM_RE.exec(String(error || ''));
  if (!m || now - Number(m[2]) >= CLAIM_TTL) return 'free';
  return token && m[1] === token ? 'mine' : 'taken';
}
export function claimText(token, now = Date.now()) { return `Sending now · ${token} · ${now}`; }
const ALREADY = 'This email is already being sent, so it was not sent a second time.';

export async function approveAndSend(id, edits = {}) {
  const first = readDraft(await notion('GET', `/pages/${id}`));
  if (first.status !== 'Draft' && first.status !== 'Failed') throw new Error(`This email is already ${first.status}.`);
  if (sendClaimState(first.error) === 'taken') throw new Error(ALREADY);
  const token = Math.random().toString(36).slice(2, 10);
  await notion('PATCH', `/pages/${id}`, { properties: { Error: { rich_text: rt(claimText(token)) } } });
  await new Promise((r) => setTimeout(r, 2000));
  const back = readDraft(await notion('GET', `/pages/${id}`));
  if (back.status === 'Sent' || sendClaimState(back.error, token) !== 'mine') throw new Error(ALREADY);
  try {
    return await sendClaimed(id, edits);
  } catch (e) {
    // a check stopped it before anything left: give the claim back so the next Send can go
    try { const now = readDraft(await notion('GET', `/pages/${id}`)); if (sendClaimState(now.error, token) === 'mine') await notion('PATCH', `/pages/${id}`, { properties: { Error: { rich_text: [] } } }); } catch { /* the claim runs out in 3 minutes anyway */ }
    throw e;
  }
}

async function sendClaimed(id, edits = {}) {
  await saveDraft(id, edits);
  const page = await notion('GET', `/pages/${id}`);
  const d = readDraft(page);
  if (d.status !== 'Draft' && d.status !== 'Failed') throw new Error(`This email is already ${d.status}.`);
  if (!/@/.test(d.to)) throw new Error('Add the brand\'s email address in To before sending.');
  if ((d.to.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).every(oursAddr)) throw new Error('To is our own team\'s address, not the brand. Put the brand\'s email in To before sending.');
  // Gmail rejects the whole email ("Bad request") if one address is broken, so name the bad one instead
  const bad = [['To', d.to], ['Cc', d.cc]].flatMap(([f, v]) => String(v || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)
    .filter((a) => !/^(?:[^<>@]*<)?[^<>@\s]+@[^<>@\s]+\.[a-z]{2,}>?$/i.test(a)).map((a) => `${f}: ${a}`));
  if (bad.length) throw new Error(`This address looks broken, fix it and send again (${bad.join(' · ')})`);
  // Last check before anything leaves: never send an email that is out of date or contradicts what we already told the brand
  // Money emails greet only someone who signed one of the brand's emails, else "Hi there," (Natalia was greeted as
  // "Pavinder", a name from old PM records, Nov 14)
  if (['Invoice', 'Payment chase', 'Billing details'].includes(d.kind) && d.dealId) {
    try {
      const { fixGreeting } = await import('./invoiceguard.js');
      const convo = await (await import('./memory.js')).readTranscript(d.dealId, 60000);
      const g = fixGreeting(d.body, convo, d.to);
      if (g.changed) { d.body = g.body; console.log('greeting fixed', id, g.was); await notion('PATCH', `/pages/${id}`, { properties: { Body: { rich_text: rtLong(d.body) } } }).catch(() => {}); }
    } catch (e) { console.error('greeting check', e.message); }
  }
  const stop = await sendGuard(d, page);
  if (stop) throw new Error(stop);
  const MB = await import('./mailbox.js');
  // A creator inbox the PM reaches over IMAP/SMTP itself (Lindsay's), else Gmail through n8n (Chris's, noocapcollab)
  const own = d.sendFrom && d.sendFrom !== 'noocapcollab' && d.sendFrom !== 'Chris' ? d.sendFrom : null;
  if (own && !MB.hasMailbox(own)) throw new Error(`${own.toUpperCase()}_EMAIL_USER and ${own.toUpperCase()}_EMAIL_PASS are not set in Vercel (${own}'s inbox).`);
  const chris = d.sendFrom === 'Chris' || !!own;
  const hook = own ? 'smtp' : d.sendFrom === 'Chris' ? process.env.N8N_SEND_WEBHOOK_CHRIS : process.env.N8N_SEND_WEBHOOK;
  if (!hook) throw new Error(d.sendFrom === 'Chris' ? 'N8N_SEND_WEBHOOK_CHRIS is not set in Vercel (the send workflow for Chris\'s inbox).' : 'N8N_SEND_WEBHOOK is not set in Vercel.');
  const dealPage = d.dealId ? await notion('GET', `/pages/${d.dealId}`) : null;
  const deal = dealPage ? { id: dealPage.id, brand: plain(dealPage.properties?.['Brand Name']), creator: plain(dealPage.properties?.Creator), stage: plain(dealPage.properties?.['Deal Stage']), followUps: Number(plain(dealPage.properties?.['Follow-ups Sent']) || 0), invoiceDue: plain(dealPage.properties?.['Invoice Due Date']), threadId: plain(dealPage.properties?.['Thread ID']), messageRfc: plain(dealPage.properties?.['Message ID']), threadCc: plain(dealPage.properties?.['Thread CC']), threadSubject: plain(dealPage.properties?.['Thread Subject']) } : null;

  let attachment = null;
  if (d.attach === 'Script PDF') {
    attachment = await scriptPdfs(d, deal?.brand, deal?.creator);
  } else if (d.attach === 'Invoice') {
    attachment = await invoiceAttachment(dealPage);
  } else if (d.attach === 'File') {
    attachment = await sentFileAttachment(page);
  }
  // An invoice the PM drafted in the creator's Stripe: finalize it now and put its pay link and PDF in the email
  let stripePart = null;
  if (d.stripeInvoice) {
    const [part, invId, payBy] = d.stripeInvoice.split('|');
    const I = await import('./invoicing.js');
    const fin = await I.finalizeForSend(deal?.creator || d.creator, invId);
    if (!fin.link) throw new Error('Stripe did not return a pay link for this invoice');
    // "bank": paid by transfer with the details written in the email, so no pay link goes in (Nov 16)
    if (payBy === 'bank') d.body = String(d.body).split('{{invoice_link}}').join('').replace(/\n*You can pay here:\s*$/i, '');
    else {
      d.body = String(d.body).split('{{invoice_link}}').join(fin.link);
      if (!d.body.includes(fin.link)) d.body += `\n\nYou can pay here: ${fin.link}`;
    }
    if (fin.pdf) attachment = fin.pdf;
    stripePart = { part, invId, amount: fin.amount };
  }

  // The last check every email passes (lib/preflight.js): thread, subject, CC and body put right, or the email waits
  {
    const { preflight } = await import('./preflight.js');
    const pf = preflight(d, deal, { cleanCc, ownAddress: own ? '' : 'noocapcollab@gmail.com' });
    if (pf.hold.length) throw new Error(`Not sent: ${pf.hold.join('; ')}.`);
    Object.assign(d, pf.draft);
    if (pf.fixed.length) { console.log('preflight', id, pf.fixed.join('; ')); try { await notion('PATCH', `/pages/${id}`, { properties: { Subject: { title: [{ type: 'text', text: { content: String(d.subject || '').slice(0, 1900) } }] }, Cc: { rich_text: [{ type: 'text', text: { content: String(d.cc || '').slice(0, 1900) } }] }, 'Reply To Message ID': { rich_text: [{ type: 'text', text: { content: String(d.replyTo || '').slice(0, 1900) } }] }, 'Gmail Thread ID': { rich_text: [{ type: 'text', text: { content: String(d.threadId || '').slice(0, 1900) } }] } } }); } catch { /* the send goes ahead with the fixes */ } }
  }
  // Old deals may hold a Message-ID in Thread ID; only a Gmail thread id (hex) can be passed as threadId
  const gmailThread = /^[0-9a-f]{10,}$/i.test(d.threadId) ? d.threadId : '';
  const inReplyTo = d.replyTo || (/@/.test(d.threadId) ? d.threadId : '');
  // A chaser never starts a new email thread: with no brand email to reply to it would land as a fresh email under a
  // made-up subject, away from the brand's own thread (Bluehost × Chris, Nov 2: "Bluehost × Chris - contract and brief")
  if (!inReplyTo && !d.threadId && ['Follow-up', 'Payment chase', 'Tool access'].includes(d.kind)) throw new Error(`Not sent: this ${d.kind} has no brand email thread to reply in. Set the deal's Message ID from the brand's email first.`);
  // Chris's replies carry the earlier thread underneath, like a normal Gmail reply, so anyone copied in
  // (noocapcollab) sees the brand's brief and links even when they were sent before we joined the thread
  // HTML line breaks typed into a body (the tool-access emails, Nov 9-10) went out as literal "<br />" text: make them real line breaks
  d.body = String(d.body || '').replace(/<br\s*\/?>/gi, '\n');
  d.body = noDashes(d.body);
  // An email from a creator's own inbox is always signed by that creator's team (a Lindsay email never says "Chris's Team")
  d.body = fixSignature(d.body, d.sendFrom);
  let text = d.body, html = toHtml(d.body);
  if (chris && d.leadId) {
    try {
      const q = quoteThread(await notion('GET', `/pages/${d.leadId}`));
      if (q) { text += q.text; html += q.html; }
    } catch { /* send without the quote rather than fail */ }
  }
  // Every reply carries the earlier conversation underneath, so it reads as one thread in every inbox
  else if (inReplyTo && d.dealId) {
    try {
      const { pageLines } = await import('./memory.js');
      const q = quoteHistory(await pageLines(d.dealId), { ours: `${deal?.creator || d.creator || 'Our'}'s Team`.replace(/^Our's/, 'Our') });
      if (q) { text += q.text; html += q.html; }
    } catch { /* send without the quote rather than fail */ }
  }
  const references = inReplyTo ? await threadReferences({ dealId: d.dealId, leadId: d.leadId, threadId: gmailThread }).catch(() => []) : [];
  const raw = buildMime({ to: d.to, cc: d.cc, subject: d.subject, text, html, inReplyTo, references, attachment, from: own ? MB.mailboxFrom(own) : undefined });
  // Last look before it leaves: a Reject tapped while this send was being prepared wins (Tripo x Lindsay, Nov 18: Send
  // and Reject tapped seconds apart, the Reject said "Nothing was sent" and the email went anyway)
  try { const now = readDraft(await notion('GET', `/pages/${id}`)); if (now.status === 'Rejected') throw new Error('REJECTED_DURING_SEND'); } catch (e) { if (e.message === 'REJECTED_DURING_SEND') throw new Error('Not sent: it was rejected while the send was being prepared.'); }
  const res = own ? await MB.sendFromMailbox(own, { raw, to: d.to, cc: d.cc }).then(() => ({ ok: true, status: 200, json: async () => ({ ok: true }) })).catch((e) => ({ ok: false, status: 500, json: async () => ({ ok: false, error: String(e.message || e).slice(0, 200) }) })) : await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hook-secret': process.env.PM_HOOK_SECRET || '' },
    // lookup = the brand message we reply to; n8n uses it to find the Gmail thread when we don't know the thread id yet
    body: JSON.stringify({ raw, ...(gmailThread ? { threadId: gmailThread } : {}), ...(inReplyTo ? { lookup: inReplyTo } : {}), subject: d.subject || '', to: d.to || '' }), // subject + to: n8n finds the thread by them when the brand's message isn't in this inbox
  });
  let result = {};
  try { result = await res.json(); } catch { /* n8n may return empty */ }
  if (!res.ok || result.ok === false) {
    const err = result.error || `n8n returned ${res.status}`;
    await notion('PATCH', `/pages/${id}`, { properties: { Status: { select: { name: 'Failed' } }, Error: { rich_text: rt(err) } } });
    throw new Error(err);
  }
  await notion('PATCH', `/pages/${id}`, { properties: { Status: { select: { name: 'Sent' } }, 'Sent At': { date: { start: new Date().toISOString() } }, Error: { rich_text: [] } } });
  // Which version of each script went: "fp <card>=<fingerprint>" lines on the row (see scriptFingerprint)
  if (d.kind === 'Script') {
    try {
      const { scriptFingerprint } = await import('./pdf.js');
      const marks = [];
      for (const u of [...new Set(scriptCardUrls(d).map(pageIdOf).filter(Boolean))].slice(0, 6)) { const f = await scriptFingerprint(u).catch(() => null); if (f) marks.push(`fp ${hexOf(u)}=${f}`); }
      if (marks.length) { const prev = (page.properties?.Context?.rich_text || []).map((t) => t.plain_text).join(''); await notion('PATCH', `/pages/${id}`, { properties: { Context: { rich_text: rtLong(`${prev}${prev ? '\n' : ''}${marks.join('\n')}`) } } }); }
    } catch (e) { console.error('script fingerprint', e.message); }
  }
  if (stripePart && d.dealId) { try { const I = await import('./invoicing.js'); await I.markPartSent(d.dealId, stripePart.invId); } catch (e) { console.error('stripe part mark failed', e.message); } }

  if (d.leadId) {
    try { const { afterLeadSend } = await import('./leads.js'); await afterLeadSend(d); } catch (e) { console.error('lead update after send failed', e.message); }
  }
  if (deal) {
    const schema = await schemaOf(DS.deals);
    const p = {};
    setIf(schema, p, 'Last Our Reply', istStamp());
    // Only a deal with no thread yet takes the sent email's thread: a send that landed in another thread must not
    // repoint the deal away from the brand's (Bluehost × Chris, Nov 2)
    if (result.threadId && !deal.threadId) setIf(schema, p, 'Thread ID', result.threadId);
    switch (d.kind) {
      case 'Script':
        if (stageBefore(deal.stage, 'Script Sent')) setIf(schema, p, 'Deal Stage', 'Script Sent');
        setIf(schema, p, 'Script Sent Date', todayIST());
        setIf(schema, p, 'Follow-ups Sent', 0);
        setIf(schema, p, 'Next Action', 'Waiting for the brand to approve the script');
        setIf(schema, p, 'Next Action Date', addDays(3));
        break;
      case 'Follow-up':
      case 'Payment chase':
        setIf(schema, p, 'Follow-ups Sent', deal.followUps + 1);
        setIf(schema, p, 'Next Action Date', addDays(d.kind === 'Payment chase' ? 7 : 3));
        break;
      case 'Draft video':
        // the EDIT TRACKER / Video Intake row whose link went out moves to With Brand, like a Send to Brand does
        try {
          const { findIntakeRows, moveCardToBrandApproval } = await import('./intake.js');
          const rows = await findIntakeRows(deal).catch(() => []);
          for (const r of rows) if (r.frame && String(d.body || '').includes(r.frame) && /in review|send to brand|with brand/i.test(r.status || '')) {
            if (!/with brand/i.test(r.status || '')) await notion('PATCH', `/pages/${r.id}`, { properties: { Status: { select: { name: 'With Brand' } }, 'Sent To Brand At': { date: { start: new Date().toISOString() } }, 'Brand Send Note': { rich_text: [{ type: 'text', text: { content: `Sent to ${d.to || 'the brand'} from Approvals.` } }] } } }).catch(() => {});
            // and the creator's board card goes to "9- Approval Brand/Creator"
            await moveCardToBrandApproval({ ...r, creator: r.creator || deal.creator });
          }
        } catch { /* the row can be moved by hand */ }
        if (stageBefore(deal.stage, 'Submitted')) setIf(schema, p, 'Deal Stage', 'Submitted');
        setIf(schema, p, 'Delivered Date', todayIST());
        setIf(schema, p, 'Follow-ups Sent', 0);
        setIf(schema, p, 'Next Action', 'Waiting for the brand to review the video');
        setIf(schema, p, 'Next Action Date', addDays(3));
        break;
      case 'Posted links':
        if (stageBefore(deal.stage, 'Posted')) setIf(schema, p, 'Deal Stage', 'Posted');
        setIf(schema, p, 'Links Sent Date', todayIST());
        setIf(schema, p, 'Next Action', 'Send the invoice');
        break;
      case 'Invoice':
        // The creator's bank or PayPal details sent after the invoice (the brand can't use the pay link): the invoice
        // dates stay as they were, so the payment chase keeps its timing
        if (!stripePart && /payment reference|(bank|paypal|payment) details for the invoice/i.test(d.body || '')) { setIf(schema, p, 'Next Action', 'Waiting for payment (bank/PayPal details sent)'); break; }
        // An upfront invoice goes out before the video is made: the deal keeps its stage
        if (stripePart?.part === 'upfront') { setIf(schema, p, 'Invoice Sent Date', todayIST()); setIf(schema, p, 'Next Action', `Waiting for the upfront payment ($${stripePart.amount})`); break; }
        if (stageBefore(deal.stage, 'Invoiced')) setIf(schema, p, 'Deal Stage', 'Invoiced');
        // The invoice email that also carries the live links counts as the links email, so no separate "Posted links"
        // email is drafted later (Readdy AI x Lindsay, Nov 17: links + invoice went together on Nov 15, Links Sent Date
        // stayed empty and a Posted links draft was written two days later; system check Nov 18)
        if (!plain(dealPage.properties?.['Links Sent Date']) && carriesPostedLinks(d.body, plain(dealPage.properties?.['Posted Links']))) setIf(schema, p, 'Links Sent Date', todayIST());
        if (stripePart) setIf(schema, p, 'Invoice Amount', stripePart.amount);
        setIf(schema, p, 'Invoice Sent Date', todayIST());
        if (!deal.invoiceDue) setIf(schema, p, 'Invoice Due Date', addDays(stripePart ? 3 : 14));
        setIf(schema, p, 'Follow-ups Sent', 0);
        setIf(schema, p, 'Next Action', 'Waiting for payment');
        setIf(schema, p, 'Next Action Date', addDays(7));
        try { const { markRevenueInvoiced } = await import('./inbox.js'); await markRevenueInvoiced(deal, { amount: stripePart?.amount || Number(plain(dealPage.properties?.['Invoice Amount'])) || Number(plain(dealPage.properties?.['Final Rate USD'])) || undefined }); } catch { /* revenue row can be ticked by hand */ }
        break;
      default:
        break;
    }
    await notion('PATCH', `/pages/${deal.id}`, { properties: p });
  }
  clearCache();
  return { sent: true, kind: d.kind, to: d.to, subject: d.subject, attachment: Array.isArray(attachment) ? attachment.map((a) => a.filename).join(', ') : attachment?.filename || null };
}

// Earlier Message-IDs of the same conversation, oldest first: the brand messages the PM logged in this Gmail thread,
// plus the creator-inbox lead the deal came from (Chris's own thread). Each inbox threads a reply by any ID it knows.
async function threadReferences({ dealId, leadId, threadId }) {
  const ids = [];
  const add = (v) => { for (const m of String(v || '').match(/<[^<>\s]+@[^<>\s]+>/g) || []) if (!ids.includes(m)) ids.push(m); };
  let leads = [];
  if (leadId) leads = [await notion('GET', `/pages/${leadId}`)];
  else if (dealId) {
    const r = await notion('POST', `/data_sources/a63d1576-b2b7-41c0-822e-57d54b224f6d/query`, { page_size: 3, filter: { property: 'Deal', relation: { contains: dealId } } }).catch(() => ({ results: [] }));
    leads = r.results || [];
  }
  for (const lp of leads) add(plain(lp.properties?.['Message ID']));
  if (threadId) {
    const r = await notion('POST', `/data_sources/4215bfda-0191-4e77-a40b-4c2d8b6e0d70/query`, {
      page_size: 15, filter: { property: 'Thread ID', rich_text: { equals: threadId } }, sorts: [{ property: 'Time', direction: 'ascending' }],
    }).catch(() => ({ results: [] }));
    for (const p of r.results || []) add(plain(p.properties?.['Message ID']));
  }
  return ids;
}

// ---------- drafts someone already answered by hand ----------
// When should a draft count as answered? When our side wrote in its Gmail thread after the brand message it answers.
// The brand message time comes from the "Date:" line of the draft's Context, else when the draft was made.
const draftSource = (d) => {
  const ctx = (d.properties?.Context?.rich_text || []).map((t) => t.plain_text).join('');
  const m = ctx.match(/^Date:\s*(.+)$/m);
  const t = m ? Date.parse(m[1].trim()) : NaN;
  return Number.isFinite(t) ? t : Date.parse(d.created_time);
};
const retire = (d) => notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } } } });

// Our reply went out at `at` (ISO) in this thread / on this lead: every waiting draft written for an older message is done
// A new cut supersedes the waiting reply to the brand's feedback ("we'll make that change"): the cut itself is the
// answer, so the older reply drafts on that thread are rejected and only the cut email is left to approve
export async function retireRepliesFor(threadId, keepId) {
  if (!threadId) return 0;
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 10, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { property: 'Kind', select: { equals: 'Reply' } }, { property: 'Gmail Thread ID', rich_text: { equals: threadId } }] } }).catch(() => ({ results: [] }));
  let n = 0;
  for (const d of r.results || []) if (d.id !== keepId) { await notion('PATCH', `/pages/${d.id}`, { properties: { Status: { select: { name: 'Rejected' } }, Error: { rich_text: rt('Replaced by the new cut email') } } }).catch(() => {}); n++; }
  return n;
}

export async function retireAnswered({ threadId, leadId, at }) {
  const when = Date.parse(at);
  if (!Number.isFinite(when) || (!threadId && !leadId)) return [];
  const or = [];
  if (threadId) or.push({ property: 'Gmail Thread ID', rich_text: { equals: threadId } });
  if (leadId) or.push({ property: 'Lead', relation: { contains: leadId } });
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 20, filter: { and: [{ property: 'Status', select: { equals: 'Draft' } }, { or }] } }).catch(() => ({ results: [] }));
  const done = [];
  for (const d of r.results || []) {
    if (draftSource(d) >= when) continue; // written for a brand message newer than our reply, still needed
    await retire(d).catch(() => {});
    done.push(plain(d.properties?.Subject) || 'draft');
  }
  if (done.length) clearCache();
  return done;
}

// Safety net on the heartbeat: any waiting draft whose thread has a later email from our side in the Agent Log
// (sent by hand from Gmail, from Chris's inbox, or by the creator's team) leaves Approvals
export async function sweepAnsweredDrafts() {
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { property: 'Status', select: { equals: 'Draft' } } }).catch(() => ({ results: [] }));
  const done = [];
  for (const d of r.results || []) {
    const th = plain(d.properties?.['Gmail Thread ID']);
    if (!th) continue;
    const after = new Date(draftSource(d) + 1000).toISOString();
    const ours = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [
      { property: 'Thread ID', rich_text: { equals: th } },
      { property: 'Email Date', date: { on_or_after: after } },
      { or: [
        { property: 'From Side', select: { equals: 'ours' } },
        { property: 'Event', title: { starts_with: 'Our ' } },
        { property: 'Event', title: { starts_with: 'Lead · we replied' } },
      ] },
    ] } }).then((q) => (q.results || []).length > 0).catch(() => false);
    if (!ours) continue;
    await retire(d).catch(() => {});
    done.push(plain(d.properties?.Subject) || 'draft');
  }
  if (done.length) clearCache();
  return done;
}


// ---------- the last check before sending ----------
// Returns a reason to stop, or null. Catches the mistakes a quick glance in Approvals misses:
// someone on our side already answered this thread, the lead is already agreed (a second closing email or a new price
// would confuse the brand), or the price in the email differs from the one already agreed.
const PRICE_KINDS = ['Quote', 'Counter', 'Close deal', 'Rate hold', 'Lead follow-up'];
// Cards whose scripts already went in a Script email of this deal (last 14 days)
export function scriptsAlreadySent(cardIds, sentRows) {
  const sent = new Map();
  for (const r of sentRows) for (const u of scriptCardUrls(r)) { const id = pageIdOf(u); if (id && !sent.has(id)) sent.set(id, r.sentAt); }
  const ids = cardIds.filter(Boolean);
  return ids.length && ids.every((id) => sent.has(id)) ? sent.get(ids[0]) || 'earlier' : null;
}

// System check Nov 17 night (CapCut BD-46): a reply drafted while the deal said Chris waited in Approvals, Harsh moved the
// deal to Brad, and the draft still signed "Chris's Team" (the same mix-up the brand complained about on Nov 5 and 16).
// The signature must name the deal's creator as it stands when the email leaves.
// Does an email body carry any of the deal's posted links? Pure.
export function carriesPostedLinks(body, postedLinks) {
  const norm = (u) => String(u || '').replace(/\\/g, '').replace(/[)\].,]+$/, '').replace(/\/+$/, '').toLowerCase();
  const text = String(body || '').replace(/\\/g, '').toLowerCase();
  return String(postedLinks || '').match(/https?:\/\/[^\s<>\]\)]+/g)?.some((u) => text.includes(norm(u))) || false;
}
export function signatureMismatch(body, dealCreator) {
  const who = String(dealCreator || '').trim();
  if (!who) return null;
  const text = String(body || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const m = [...text.matchAll(/\b([A-Z][\w.-]*(?:\s[A-Z][\w.-]*)?)['\u2019]s\s+Team\b/g)].pop();
  if (!m) return null;
  const signed = m[1].trim();
  const a = signed.toLowerCase().split(/\s+/)[0], b = who.toLowerCase().split(/\s+/)[0];
  // Spelling variants of one name (Valeri / Valerie) are the same creator
  return a.startsWith(b) || b.startsWith(a) ? null : signed;
}

async function sendGuard(d, page) {
  if (d.dealId) {
    const dealPage = await notion('GET', `/pages/${d.dealId}`).catch(() => null);
    const signed = dealPage ? signatureMismatch(d.body, plain(dealPage.properties?.Creator)) : null;
    if (signed) return `Not sent: signed "${signed}'s Team" but this deal is now ${plain(dealPage.properties?.Creator)}'s. Fix the signature (and the Creator) before sending.`;
  }
  // Invoice guard: amount, fee, billed-to company, platforms, posted links and payment details checked against what
  // the brand and creator wrote (Harsh, Nov 16). Anything that contradicts them stops the invoice.
  if (d.kind === 'Invoice' && d.dealId) {
    const { openDeals } = await import('./briefs.js');
    const deal = (await openDeals({ withClosed: true }).catch(() => [])).find((x) => x.id.replace(/-/g, '') === String(d.dealId).replace(/-/g, ''));
    if (deal) {
      const I = await import('./invoicing.js');
      const [part, invId] = String(d.stripeInvoice || '').split('|');
      const x = I.readInvoices(deal.stripeInvoices).find((i) => i.id === invId);
      const pct = I.invoiceParts(deal.paymentTerms).find((p) => p.part === part)?.pct || 100;
      const { checkInvoice, blocking } = await import('./invoiceguard.js');
      const stop = blocking((await checkInvoice(deal, { amount: x?.amount, pct: x ? pct : undefined, body: d.body })).problems);
      if (stop.length) return `Not sent: ${stop.map((c) => c.t).join(' · ')}`;
    }
  }
  // 0. The same scripts never go twice (CapCut × Lindsay, Nov 16: scripts 2 and 3 went at 2:44 and again at 3:24).
  //    A revised script is a new version and may go again.
  if (d.kind === 'Script' && d.attach === 'Script PDF' && d.dealId && !/revis|updated script|new version/i.test(`${d.why} ${d.body}`)) {
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { and: [{ property: 'Kind', select: { equals: 'Script' } }, { property: 'Status', select: { equals: 'Sent' } }, { property: 'Sent At', date: { on_or_after: since } }] } }).catch(() => ({ results: [] })); // any deal: the same card's script never goes to two brands either (CapCut × Chris, Nov 16)
    const rows = (r.results || []).filter((p) => p.id !== page.id).map((p) => ({ ...readDraft(p), sentAt: plain(p.properties?.['Sent At']) }));
    const when = scriptsAlreadySent(scriptCardUrls(d).map(pageIdOf), rows);
    if (when) return `Not sent: these scripts already went to the brand (${String(when).slice(0, 16).replace('T', ' ')} UTC). If this is a revised script, say so in Why; otherwise reject this draft.`;
  }
  const body = String(d.body || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const amounts = [...body.matchAll(/\$\s?(\d[\d,]*)(?:\.\d+)?\s?(k\b)?/gi)].map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)).filter((n) => n >= 100);
  const money = (n) => '$' + Number(n).toLocaleString('en-US');
  // 1. Already answered: our side wrote in this thread after the brand message this draft replies to
  const th = d.threadId || plain(page.properties?.['Gmail Thread ID']);
  if (th) {
    const after = new Date(draftSource(page) + 1000).toISOString();
    const ours = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 1, filter: { and: [
      { property: 'Thread ID', rich_text: { equals: th } },
      { property: 'Email Date', date: { on_or_after: after } },
      { or: [{ property: 'From Side', select: { equals: 'ours' } }, { property: 'Event', title: { starts_with: 'Our ' } }, { property: 'Event', title: { starts_with: 'Lead · we replied' } }] },
    ] } }).then((q) => (q.results || []).length > 0).catch(() => false);
    if (ours) return 'Not sent: someone on our side already replied in this thread after this draft was written. Open the thread in Gmail to check, then reject this draft.';
  }
  if (!d.leadId) return null;
  const lp = await notion('GET', `/pages/${d.leadId}`).catch(() => null);
  if (!lp) return null;
  const g = (n) => plain(lp.properties?.[n]);
  const agreed = Number(g('Agreed USD') || 0);
  // 2. Already agreed and handed over: no more price talk or closing emails on this lead
  // The brief chase after a handover asks only for the contract and brief, never a price: it is allowed (TapNow, Nov 12)
  const briefChase = d.kind === 'Lead follow-up' && /^Brief chase/i.test(d.why || '') && !amounts.length;
  if (g('Status') === 'Locked' && PRICE_KINDS.includes(d.kind) && !briefChase) return `Not sent: ${g('Brand') || 'this brand'} is already agreed${agreed ? ' at ' + money(agreed) : ''} and handed to noocapcollab, so a ${d.kind.toLowerCase()} email would reopen the price. Reject this draft.`;
  // 3. A price that contradicts the agreed one
  if (agreed && amounts.length && !amounts.includes(agreed)) return `Not sent: this email says ${money(amounts[0])} but the agreed price is ${money(agreed)}. Fix the amount or reject the draft.`;
  // 4. A closing email at a price we never quoted and the brand never offered
  if (d.kind === 'Close deal' && amounts.length) {
    const known = [g('Ask USD'), g('Budget USD'), g('Quoted USD')].map(Number).filter((n) => n > 0);
    if (known.length && !known.includes(amounts[0])) return `Not sent: this closing email says ${money(amounts[0])}, but our last price was ${money(Number(g('Ask USD')) || known[0])}. Check the thread and fix the amount.`;
  }
  return null;
}

// ---------- keeping Approvals short ----------
// First replies to brand pitches (quotes, rate holds, counters) go stale fast: a brand that pitched 5 days ago and
// heard nothing has moved on. Unsent ones older than this leave Approvals as "Expired" (still in Notion).
export const LEAD_EXPIRE_DAYS = 5;
const LEAD_DRAFT_KINDS = ['Quote', 'Rate hold', 'Counter', 'Reply', 'Lead follow-up'];
// Management answers new brands themselves (quotes, rates, counters, replies). On a lead the PM only drafts the
// follow-up nudges. LEADS_DRAFT_KINDS overrides, e.g. "Lead follow-up,Quote" to bring quotes back.
export const LEAD_KINDS_ALLOWED = String(process.env.LEADS_DRAFT_KINDS || 'Lead follow-up').split(',').map((k) => k.trim()).filter(Boolean);
export const leadKindAllowed = (kind) => LEAD_KINDS_ALLOWED.includes(kind);

export async function expireOldLeadDrafts() {
  const before = new Date(Date.now() - LEAD_EXPIRE_DAYS * 864e5).toISOString();
  const r = await notion('POST', `/data_sources/${OUTBOX_DS}/query`, { page_size: 100, filter: { and: [
    { property: 'Status', select: { equals: 'Draft' } },
    { property: 'Lead', relation: { is_not_empty: true } },
  ] } });
  const out = [];
  for (const p of r.results || []) {
    const d = readDraft(p);
    // Any lead reply other than a follow-up is management's to write: it leaves Approvals straight away
    if (d.status === 'Draft' && !leadKindAllowed(d.kind) && d.kind !== 'Draft video') {
      await notion('PATCH', `/pages/${p.id}`, { properties: { Status: { select: { name: 'Expired' } }, Why: { rich_text: rt(`Handled by management: the PM no longer sends quotes or replies to new brands · ${d.why}`.slice(0, 1900)) } } });
      out.push(d.subject.replace(/^(Re:\s*)+/i, '').slice(0, 60));
      continue;
    }
    if (Date.parse(d.created) >= Date.parse(before)) continue;
    if (!LEAD_DRAFT_KINDS.includes(d.kind)) continue;
    await notion('PATCH', `/pages/${p.id}`, { properties: { Status: { select: { name: 'Expired' } }, Why: { rich_text: rt(`Expired: not sent within ${LEAD_EXPIRE_DAYS} days · ${d.why}`.slice(0, 1900)) } } });
    if (d.leadId) await notion('PATCH', `/pages/${d.leadId}`, { properties: { 'Next Step': { rich_text: rt(`Our ${d.kind.toLowerCase()} expired unsent after ${LEAD_EXPIRE_DAYS} days`) } } }).catch(() => {});
    out.push(d.subject.replace(/^(Re:\s*)+/i, '').slice(0, 60));
  }
  return out;
}

// A "standard quote": our normal list price, and the brand asked nothing that needs a person
export function isStandardQuote(d) {
  if (d.kind !== 'Quote' || d.status !== 'Draft' || /^Needs you/i.test(d.why)) return false;
  const price = Number((d.why.match(/\[price:(\d+)\]/) || [])[1] || 0);
  const list = Number(((d.why.match(/list \$([\d,]+)/) || [])[1] || '0').replace(/,/g, ''));
  return price > 0 && price === list && Date.now() - Date.parse(d.created) < LEAD_EXPIRE_DAYS * 864e5;
}

// The one-click "Send all standard quotes": sends them one after another, inside the time Vercel allows
export async function sendStandardQuotes(ids, { budgetMs = 95000 } = {}) {
  const until = Date.now() + budgetMs;
  const sent = [], failed = [], left = [];
  for (const id of ids || []) {
    if (Date.now() > until) { left.push(id); continue; }
    try {
      const d = await readDraftById(id);
      if (!isStandardQuote(d)) { failed.push(`${d.subject}: no longer a standard quote`); continue; }
      await approveAndSend(id);
      sent.push(d.subject.replace(/^(Re:\s*)+/i, '').slice(0, 60));
    } catch (e) { failed.push(String(e.message || e).slice(0, 120)); }
  }
  return { sent, failed, left };
}
