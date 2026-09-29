Skip to content
noocapcollab-coder
noocap-pm
Repository navigation
Code
Issues
Pull requests
Actions
Projects
Wiki
Security and quality
Insights
Settings
noocap-pm/lib
/
leads.js
in
main

Edit

Preview
Indent mode

Spaces
Indent size

2
Line wrap mode

No wrap
Editing leads.js file contents
  1
  2
  3
  4
  5
  6
  7
  8
  9
 10
 11
 12
 13
 14
 15
 16
 17
 18
 19
 20
 21
 22
 23
 24
 25
 26
 27
 28
 29
 30
 31
 32
 33
 34
 35
 36
 37
 38
 39
 40
 41
 42
 43
 44
 45
 46
 47
 48
 49
 50
 51
 52
 53
 54
 55
 56
 57
 58
 59
 60
 61
 62
// Leads: brand offers that land in a creator's own collab inbox (e.g. Chris), before the deal is locked
// and noocapcollab is tagged. The PM sorts every email (brand deal / collaboration vs outreach and spam), records
// the leads, and negotiates by the Rate Card and the NOOCAP playbook (see RULES below). Once a price is agreed it asks
// for the brief and adds noocapcollab, and from there the noocapcollab automation takes over.
// The code decides every number; the AI only reads emails and writes the words.
import { notion, plain, clearCache } from './notion.js';
import { DS, todayIST } from './tools.js';
import { claude, HAIKU, costOf } from './claude.js';
import { openDeals, log, discord } from './briefs.js';
import { createDraft, writeEmail, OUTBOX_DS } from './outbox.js';
import { threadSubject } from './mime.js';

const rt = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 1900) } }];
const lc = (s) => String(s ?? '').toLowerCase();
const addrOf = (s) => (String(s || '').match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '';
const normBrand = (s) => lc(s).replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq)\b/g, '').replace(/[^a-z0-9]+/g, '');
const PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'YouTube Shorts', 'Facebook', 'Newsletter', 'X', 'LinkedIn'];
const RATE_DS = '511a4b57-a935-47a5-8e74-cf026ff57587';
const NOOCAP = 'noocapcollab@gmail.com';
const SIGN = () => (process.env.PM_SIGNATURE_CHRIS || 'Best,\nChris Cordero Team').replace(/\\n/g, '\n');
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const emailISO = (email) => { const t = Date.parse(email.date || ''); return new Date(Number.isFinite(t) ? t : Date.now()).toISOString(); };

// The latest message, without the quoted history under it
function latestText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From:\s.+|>)/i.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

// Free filter before any AI: system mail, receipts and newsletters that aren't part of a lead thread
function obviousNoise(email) {
  const from = lc(email.from);
  if (/mailer-daemon|postmaster|no-?reply@(?!.*(collab|partner|brand))|notifications?@|@(accounts\.google|google|youtube|github|notion|stripe|paypal|apple|amazon)\.com/.test(from)) return 'system email';
  const subj = `${email.subject || ''}`;
  if (/receipt|invoice #|your order|verify your|password|security alert|terms of service/i.test(subj)) return 'receipt or account email';
  if (/@(substack|beehiiv|mailchimp|mail\.beehiiv|convertkit|kit|mailerlite|sendgrid|linkedin|medium|producthunt|skool|circle)\./.test(from) || /newsletter|digest|weekly roundup|webinar/i.test(subj)) return 'newsletter';
  // Bulk mail (has an unsubscribe link) that never mentions a collaboration: skip without paying for AI
  const body = `${email.subject || ''} ${String(email.text || '').slice(0, 4000)}`;
  if (/unsubscribe/i.test(email.text || '') && !/collab|sponsor|partnership|partner|paid|promot|campaign|creator|influencer|ambassador|affiliate|rate|budget|feature|review|brief|deal/i.test(body)) return 'bulk mail';
  return null;
}

const LEAD_TOOL = {
  name: 'record_lead',
  description: 'Record what this email means for a creator\'s brand-deal pipeline.',
  input_schema: {
    type: 'object',
    properties: {
      is_lead: { type: 'boolean', description: 'True ONLY if a brand or its agency wants the creator to PROMOTE their product in content (paid, affiliate or gifted). False when someone wants to SELL something to the creator or work for them: job applications, freelancers (editors, designers, VAs, scriptwriters), agencies offering growth, editing, ads, SEO, app building or management services, sponsorship marketplaces, courses, tools pitched for the creator to use. Also false for newsletters, receipts and platform notices.' },
      not_lead_kind: { type: ['string', 'null'], enum: ['job_or_service_pitch', 'spam', 'newsletter_or_notice', 'other', null], description: 'When is_lead is false: job_or_service_pitch = outreach from someone applying for work or selling a service/tool to the creator; spam = scams, mass cold blasts, fake "collab" offers that ask the creator to pay, phishing; newsletter_or_notice = newsletters, receipts, platform emails; other = anything else.' },
      type: { type: 'string', enum: ['Paid offer', 'Affiliate', 'Gifted', 'Unclear'], description: 'Paid offer = a flat fee is offered or asked about. Affiliate = commission or revenue share only. Gifted = free product only.' },
      brand: { type: 'string', description: 'The product or company to be promoted, as the brand calls itself. Take it from the subject or signature, not from CC addresses.' },
      stage: { type: 'string', enum: ['new_offer', 'negotiating', 'will_get_back', 'agreed', 'declined', 'other'], description: 'Where the conversation stands after this latest message: new_offer = first outreach; negotiating = price, deliverables or terms being discussed; will_get_back = the brand says they will check internally / get back to us, with no new offer; agreed = both sides have agreed the deal (price and scope confirmed, or contract/brief being sent); declined = one side said no or went with someone else.' },
      offer: { type: 'string', description: 'One line: what the brand wants and what they offer.' },
      budget_usd: { type: ['number', 'null'], description: 'The latest fee on the table in USD (their offer or our counter, whichever is most recent), null if none.' },
      deliverables: { type: ['string', 'null'] },
      platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS } },
      next_step: { type: 'string', description: 'Short: what needs to happen next and by whom, e.g. "Reply with rate for 1 reel" or "Wait for brand to confirm budget".' },
      brand_asked_something: { type: 'boolean', description: 'True if the brand\'s latest message asks the creator side a question or for something.' },
    },
    required: ['is_lead', 'type', 'brand', 'stage', 'offer', 'next_step', 'brand_asked_something'],
Use Control + Shift + m to toggle the tab key moving focus. Alternatively, use esc then tab to move to the next interactive element on the page.
