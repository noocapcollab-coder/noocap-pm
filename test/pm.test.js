// Safety checks that run before every deploy (npm run vercel-build) and on every push (GitHub Actions).
// They use no network, Notion or email: each one replays a real situation we've hit and checks the PM still does
// the right thing. If any fails, Vercel stops the deploy and the live site stays on the last good version.
//
// Run locally: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

process.env.PAYMENT_KEYS_SECRET ||= 'test-secret-for-the-safety-checks-only-0123456789';

const { noDashes, isStandardQuote } = await import('../lib/outbox.js');
const { gate, latestText, contractIn } = await import('../lib/inbox.js');
const { cardToMove, INTAKE_DONE_STATUS } = await import('../lib/intake.js');
const { invoiceParts, readInvoices, encrypt, connectToken, readConnectToken } = await import('../lib/invoicing.js');
const { parseBounce, isBounce } = await import('../lib/watch.js');
const { stageOf } = await import('../lib/history.js');
const { PLACEHOLDER } = await import('../lib/hygiene.js');
const { threadSubject } = await import('../lib/mime.js');

// ---------- every endpoint loads ----------
test('every API file loads without errors', async () => {
  for (const f of readdirSync(new URL('../api/', import.meta.url))) if (f.endsWith('.js')) await import(`../api/${f}`);
});

// ---------- emails ----------
test('no em or en dashes ever leave in an email (Chris asked)', () => {
  assert.equal(noDashes('Hi Alyssa — thanks for this.'), 'Hi Alyssa, thanks for this.');
  assert.equal(noDashes('We can post Oct 10–12 — does that work?'), 'We can post Oct 10-12, does that work?');
  assert.equal(noDashes('Totally fine — we will send it.'), 'Totally fine, we will send it.');
  assert.ok(!/[—–]/.test(noDashes('a — b – c —')));
});

test('only the latest message is read, not the quoted thread under it', () => {
  const t = 'Thanks, approved!\n\nOn Mon, Oct 20, 2026 at 10:00 AM Lindsay <x@y.com> wrote:\n> Here is the script';
  assert.equal(latestText(t), 'Thanks, approved!');
});

test('replies keep the thread subject (Gmail threading)', () => {
  assert.equal(threadSubject('Re: Fwd: RE: Kylon Paid Collaboration'), 'Kylon Paid Collaboration');
});

test('our own emails and system emails are never treated as brand emails', () => {
  assert.equal(gate({ from: 'NOOCAP <noocapcollab@gmail.com>', subject: 'Re: collab' }, []).ok, false);
  assert.equal(gate({ from: 'no-reply@accounts.google.com', subject: 'Security alert' }, []).ok, false);
});

test('a brand we already have a deal with always gets through', () => {
  assert.equal(gate({ from: 'Alyssa <alyssa@withwidely.com>', subject: 'quick q', text: 'hey' }, [{ brandEmail: 'alyssa@withwidely.com' }]).ok, true);
});

test('a newsletter is filtered out for free, before any AI', () => {
  assert.equal(gate({ from: 'news@somebrand.com', subject: 'This week in AI', text: 'Click here. Unsubscribe' }, []).ok, false);
});

test('a contract in an email is spotted (it goes to WhatsApp, never signed by the PM)', () => {
  const c = contractIn({ text: 'Contract attached, please sign.', attachments: [{ filename: 'Agreement_Kylon.pdf', mimeType: 'application/pdf' }] });
  assert.ok(c && c.files.length === 1);
  assert.equal(contractIn({ text: 'Invoice attached', attachments: [{ filename: 'invoice_123.pdf', mimeType: 'application/pdf' }] }), null);
});

// ---------- board cards ----------
test("an editor finishing the CTAs only counts at Intake 'Posted', never 'To Post' (David's card)", () => {
  assert.equal(INTAKE_DONE_STATUS, 'Posted');
});

test('the intake sync only moves one clear match that is still in edit or review', () => {
  const boards = [{ creator: 'David Iya', ds: 'x' }];
  const videos = [{ creator: 'David Iya', title: 'Velanir x David', status: '7- In Edit', id: '1' }];
  assert.equal(cardToMove({ creator: 'David', title: 'Velanir' }, videos, boards)?.card.id, '1');
  // already at To Post: never touched
  assert.equal(cardToMove({ creator: 'David', title: 'Velanir' }, [{ ...videos[0], status: '10- To Post' }], boards), null);
  // two possible cards: left for a person
  assert.equal(cardToMove({ creator: 'David', title: 'Velanir' }, [...videos, { ...videos[0], id: '2' }], boards), null);
});

test('status history puts each status in the right stage', () => {
  assert.equal(stageOf('7- In Edit'), 'Editing');
  assert.equal(stageOf('8- Changes'), 'Review');
  assert.equal(stageOf('10- To Post'), 'Ready');
  assert.equal(stageOf('12- Posted'), 'Posted');
  assert.equal(stageOf('Archive'), 'Archived');
  assert.equal(stageOf('In Review'), 'Review');
});

test('placeholder card titles are caught by the morning data check', () => {
  for (const t of ['NA', 'N/A', 'REPOST', 'TBD', 'Untitled']) assert.ok(PLACEHOLDER.test(t), t);
  for (const t of ['CHINA KILLED BORING JOBS', 'Claude Motion']) assert.ok(!PLACEHOLDER.test(t), t);
});

// ---------- approvals ----------
test('only plain list-price quotes count as standard for the one-click send', () => {
  const now = new Date().toISOString();
  assert.equal(isStandardQuote({ kind: 'Quote', status: 'Draft', why: 'Kimi: quote at $1,500 (list $1,500, floor $1,200) [price:1500]', created: now }), true);
  assert.equal(isStandardQuote({ kind: 'Quote', status: 'Draft', why: 'Needs you: wants demographics · quote at $1,500 (list $1,500) [price:1500]', created: now }), false);
  assert.equal(isStandardQuote({ kind: 'Quote', status: 'Draft', why: 'X: quote at $1,300 (list $1,500) [price:1300]', created: now }), false);
  assert.equal(isStandardQuote({ kind: 'Reply', status: 'Draft', why: 'X: quote at $1,500 (list $1,500) [price:1500]', created: now }), false);
});

// ---------- invoices ----------
test('payment terms split the invoice the way the deal says', () => {
  assert.deepEqual(invoiceParts('50% upfront, 50% on publish'), [{ part: 'upfront', pct: 50 }, { part: 'final', pct: 50 }]);
  assert.deepEqual(invoiceParts('Net 30 after posting'), [{ part: 'final', pct: 100 }]);
  assert.deepEqual(invoiceParts(''), [{ part: 'final', pct: 100 }]);
});

test('the invoice record on a deal reads back correctly', () => {
  const list = readInvoices('upfront | in_123 | sent | 850\nfinal | in_456 | draft | 850');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'in_123');
  assert.equal(list[1].amount, 850);
});

test("creators' Stripe keys are stored encrypted, never as plain text", () => {
  const sealed = encrypt('rk_live_example');
  assert.ok(!sealed.includes('rk_live_example'));
});

test('a Stripe connect link is tied to one creator and cannot be forged', () => {
  const tok = connectToken('Valeri');
  assert.equal(readConnectToken(tok), 'Valeri');
  assert.equal(readConnectToken(tok.slice(0, -2) + 'xx'), null);
});

// ---------- watchdog ----------
test('a bounce names the address that failed, not the people on the original email (Kylon)', () => {
  const text = "** Address not found **\nYour message wasn't delivered to alyssa.salazar@videoplusinc.ai because the address couldn't be found.\n\n----- Original message -----\nFrom: Lindsay <x@automateai.com>\nTo: alyssa@withwidely.com\nSubject: Re: Kylon Paid Collaboration";
  const b = parseBounce(text);
  assert.deepEqual(b.addrs, ['alyssa.salazar@videoplusinc.ai']);
  assert.equal(b.orig, 'Re: Kylon Paid Collaboration');
  assert.equal(isBounce({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)' }), true);
  assert.equal(isBounce({ from: 'brand@x.com', subject: 'Delivery of the video' }), false);
});

// ---------- EDIT TRACKER + Video Intake ----------
test('a video row matches its creator in either database spelling', async () => {
  const { sameVideoCreator, trackerCreator, intakeCreator } = await import('../lib/intake.js');
  assert.equal(sameVideoCreator('NICOLE', 'Nicole McCain'), true);   // Video Intake
  assert.equal(sameVideoCreator('Nicole', 'Nicole McCain'), true);   // EDIT TRACKER
  assert.equal(sameVideoCreator('Valerie', 'Valeri'), true);
  assert.equal(sameVideoCreator('EmTech', 'Emtech'), true);
  assert.equal(sameVideoCreator('Brad', 'Chris'), false);
  assert.equal(sameVideoCreator('', 'Brad'), false);
  assert.equal(trackerCreator('nicole'), 'Nicole');
  assert.equal(intakeCreator('nicole'), 'NICOLE');
});

// ---------- Send to Brand (EDIT TRACKER) ----------
test('a "Send to Brand" row finds its own brand deal, never another creator\'s', async () => {
  const { pickDealForRow } = await import('../lib/brandsend.js');
  const deals = [
    { id: 'a', brand: 'ElevenLabs', creator: 'Lindsay', stage: 'In Production' },
    { id: 'b', brand: 'ElevenLabs', creator: 'Duncan', stage: 'In Production' },
    { id: 'c', brand: 'ElevenLabs', creator: 'Duncan', stage: 'Paid' },
    { id: 'd', brand: 'Zen', creator: 'Valeri', stage: 'Signed' },
    { id: 'e', brand: 'ZenBusiness', creator: 'Valeri', stage: 'Signed' },
  ];
  assert.equal(pickDealForRow({ title: 'ElevenLabs x Duncan UGC', creator: 'Duncan' }, deals).id, 'b');
  assert.equal(pickDealForRow({ title: 'ZenBusiness explainer', creator: 'Valerie' }, deals).id, 'e');
  assert.equal(pickDealForRow({ title: 'Morning routine', creator: 'Duncan' }, deals), null);
});

test('Send to Brand stops with a reason instead of emailing the wrong way', async () => {
  const { sendBlocker } = await import('../lib/brandsend.js');
  const row = { title: 'X', creator: 'Duncan', frame: 'https://f.io/abc' };
  assert.match(sendBlocker({ ...row, frame: null }, { brandEmail: 'a@b.com' }), /Frame\.io/);
  assert.match(sendBlocker(row, null), /No brand deal/);
  assert.match(sendBlocker(row, { brand: 'Kylon', channel: 'WhatsApp', brandEmail: 'a@b.com' }), /WhatsApp/);
  assert.match(sendBlocker(row, { brand: 'Kylon', channel: 'Email', brandEmail: '' }), /no brand email/);
  assert.equal(sendBlocker(row, { brand: 'Kylon', channel: 'Email', brandEmail: 'a@b.com' }), null);
});

test('Send to Brand and With Brand count as Review on the boards', () => {
  assert.equal(stageOf('Send to Brand'), 'Review');
  assert.equal(stageOf('With Brand'), 'Review');
});

test('on new brand leads the PM only drafts follow-ups; management sends quotes and replies', async () => {
  const { leadKindAllowed } = await import('../lib/outbox.js');
  assert.equal(leadKindAllowed('Lead follow-up'), true);
  for (const k of ['Quote', 'Rate hold', 'Counter', 'Close deal', 'Decline', 'Reply']) assert.equal(leadKindAllowed(k), false, k);
});

test('the cut email never claims a caption it does not carry (ElevenLabs, 26 Oct)', async () => {
  const { cutInstructions, cutBody } = await import('../lib/brandsend.js');
  assert.match(cutInstructions(''), /Do not say or suggest that a caption/);
  const sig = "\n\nBest,\nDuncan's Team";
  const withCap = cutBody('Hi Yulia,\n\nThe cut is ready: https://f.io/x' + sig, 'https://f.io/x', 'Try ElevenLabs today #ad');
  assert.ok(withCap.includes('Post caption:\nTry ElevenLabs today #ad'));
  assert.ok(withCap.indexOf('Post caption') < withCap.indexOf('Best,'));
  const noLink = cutBody('Hi Yulia,\n\nThe cut is ready.' + sig, 'https://f.io/x', '');
  assert.ok(noLink.includes('Review link: https://f.io/x') && noLink.endsWith("Duncan's Team"));
});

test("a follow-up from Lindsay's inbox is signed by Lindsay's team, not Chris's", async () => {
  const { readyNudge } = await import('../lib/leads.js');
  const body = readyNudge({ nudge: 2, brand: 'Prizmad', name: 'Slava', leadId: 'abc', creator: 'Lindsay' });
  assert.match(body, /Lindsay's Team/);
  assert.doesNotMatch(body, /Chris/);
});

test('the sign-off always matches the inbox the email goes out from', async () => {
  const { fixSignature } = await import('../lib/outbox.js');
  assert.equal(fixSignature("Hi,\n\nChecking in.\n\nBest,\nChris's Team", 'Lindsay'), "Hi,\n\nChecking in.\n\nBest,\nLindsay's Team");
  assert.equal(fixSignature("Hi,\n\nBest,\nChris's Team", 'Chris'), "Hi,\n\nBest,\nChris's Team");
  assert.equal(fixSignature("Hi,\n\nBest,\nDuncan's Team", 'noocapcollab'), "Hi,\n\nBest,\nDuncan's Team");
});

test('when the brand asks for the invoice it is raised right away, not after posting (Polar)', async () => {
  const { partDue } = await import('../lib/invoicing.js');
  assert.equal(partDue({ stage: 'Approved', invoiceRequested: true }, 'final', ''), true);
  assert.equal(partDue({ stage: 'Approved', invoiceRequested: false }, 'final', ''), false);
  assert.equal(partDue({ stage: 'Script Sent', invoiceRequested: true }, 'final', ''), false);
});

test('while the AI is paused, no AI call is made and emails are left for later', async () => {
  const prev = process.env.AI_PAUSED_UNTIL;
  process.env.AI_PAUSED_UNTIL = new Date(Date.now() + 864e5).toISOString();
  const { aiPaused } = await import('../lib/pause.js?t=1');
  assert.equal(aiPaused(), true);
  process.env.AI_PAUSED_UNTIL = prev;
});

test('billing details typed by hand in Notion are understood (Buzzy AI)', async () => {
  const { readBilling } = await import('../lib/invoicing.js');
  const b = readBilling('Company: VisionLeap HK Limited | Email: ellaz@zmo.ai | Address: Suite 603, 6/F, Laws Commercial Plaza, 788 Cheung Sha Wan Road, Kowloon, Hong Kong | Country: HK');
  assert.equal(b.company_name, 'VisionLeap HK Limited');
  assert.equal(b.email, 'ellaz@zmo.ai');
  assert.equal(b.country_code, 'HK');
  assert.equal(readBilling('{"company_name":"Brokegirls, Inc."}').company_name, 'Brokegirls, Inc.');
});

test('follow-ups never offer a call', async () => {
  const { readyNudge } = await import('../lib/leads.js');
  for (const n of [2, 3]) for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.doesNotMatch(readyNudge({ nudge: n, brand: 'Granola AI', leadId: id, creator: 'Chris' }), /\bcall\b/i);
});

test('tools spend: yearly spread over 12, INR converted, cancelled and one-off ignored', async () => {
  const { monthlyUSD, summarize } = await import('../lib/spend.js');
  assert.equal(monthlyUSD({ Cost: 120, Billing: 'Yearly', Currency: 'USD' }), 10);
  assert.equal(monthlyUSD({ Cost: 840, Billing: 'Monthly', Currency: 'INR' }, 84), 10);
  assert.equal(monthlyUSD({ Cost: 50, Billing: 'Monthly', Status: 'Cancelled' }), 0);
  assert.equal(monthlyUSD({ Cost: 50, Billing: 'One-off' }), 0);
  const s = summarize([
    { _id: 'a', Tool: 'Vercel', Cost: 20, Billing: 'Monthly', Category: 'Automation & hosting', Status: 'Active', 'Next Renewal': '2026-10-30' },
    { _id: 'b', Tool: 'HeyGen', Cost: 29, Billing: 'Monthly', Category: 'AI video', 'Paid For': 'Brad', Status: 'Active' },
    { _id: 'c', Tool: 'Notion', Billing: 'Monthly', Status: 'Active' },
  ], '2026-10-27', 84);
  assert.equal(s.monthly, 49); assert.equal(s.yearly, 588); assert.equal(s.active, 3); assert.equal(s.noCost, 1);
  assert.equal(s.tools[0].name, 'HeyGen'); assert.equal(s.renewing.length, 1);
  assert.deepEqual(s.byClient.map((x) => x.name), ['Brad', 'NOOCAP']);
});

test('sponsor cards: Type read from a select or a multi-select (Lindsay\'s board)', async () => {
  const { typeName } = await import('../lib/actions.js');
  assert.equal(typeName({ type: 'select', select: { name: 'SPONSOR' } }), 'SPONSOR');
  assert.equal(typeName({ type: 'multi_select', multi_select: [{ name: 'PERSONAL' }, { name: 'SPONSOR' }] }), 'SPONSOR');
  assert.equal(typeName({ type: 'multi_select', multi_select: [] }), '');
  assert.equal(typeName(undefined), '');
});

test('script writer is Rudraksh and the old writer is never tagged', async () => {
  const old = process.env.SHREYA_DISCORD_ID; process.env.SHREYA_DISCORD_ID = '111';
  delete process.env.SCRIPTWRITER_DISCORD_ID;
  const { tag } = await import('../lib/briefs.js');
  assert.equal(tag(), '@Rudraksh');
  process.env.SCRIPTWRITER_DISCORD_ID = '222'; assert.equal(tag(), '<@222>');
  delete process.env.SCRIPTWRITER_DISCORD_ID; if (old === undefined) delete process.env.SHREYA_DISCORD_ID; else process.env.SHREYA_DISCORD_ID = old;
});

test('invoice email while the AI is paused: plain text with the pay link and the creator team signature', async () => {
  const { plainInvoiceEmail } = await import('../lib/outbox.js');
  const m = plainInvoiceEmail({ brand: 'SpeakOn AI', creator: 'Chris', finalRate: 950 }, { amount: '$950', billed_to: 'NOTTA PTE. LTD.' });
  assert.match(m.body, /\$950/); assert.match(m.body, /\{\{invoice_link\}\}/); assert.match(m.body, /Chris's Team$/);
  assert.doesNotMatch(m.body, /[—–]/);
});

test('redraft cooldown: only rejected or expired drafts of the same deal and kind in the last 72 hours', async () => {
  const { cooldownFilter } = await import('../lib/outbox.js');
  const f = cooldownFilter({ dealId: 'd1', kind: 'Follow-up', now: Date.parse('2026-10-30T12:00:00Z') });
  const flat = JSON.stringify(f);
  assert.match(flat, /"Deal".*"d1"/); assert.match(flat, /"Follow-up"/); assert.match(flat, /Rejected/); assert.match(flat, /Expired/);
  assert.doesNotMatch(flat, /"Sent"/);
  assert.match(flat, /2026-10-27T12:00:00/);
  const l = JSON.stringify(cooldownFilter({ leadId: 'L1', now: 0 }));
  assert.match(l, /"Lead".*"L1"/);
});

test('AI spend: cost per call, alert thresholds once each, job breakdown round trip', async () => {
  const { callCost, crossed, readJobs, writeJobs } = await import('../lib/aispend.js');
  assert.equal(callCost('claude-haiku-4-5-20251001', { input_tokens: 1e6, output_tokens: 0 }), 1);
  assert.equal(callCost('claude-sonnet-5', { input_tokens: 0, output_tokens: 1e6 }), 15);
  assert.deepEqual(crossed(14, 15.5, 20), [75]);
  assert.deepEqual(crossed(14, 19.5, 20), [75, 95]);
  assert.deepEqual(crossed(14, 15.5, 20, '75%'), []);
  assert.deepEqual(crossed(1, 2, 20), []);
  const j = readJobs(writeJobs({ inbox: 0.4, drafts: 0.1 }));
  assert.equal(j.inbox, 0.4); assert.equal(j.drafts, 0.1);
});

test('PDF attachments go to the AI as text only', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create(); const page = doc.addPage(); const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Sponsorship agreement for Lindsay', { x: 50, y: 700, size: 14, font });
  const b64 = Buffer.from(await doc.save()).toString('base64');
  const { attachmentText } = await import('../lib/pdftext.js');
  const t = await attachmentText([{ filename: 'contract.pdf', mimeType: 'application/pdf', data: b64 }, { filename: 'logo.png', mimeType: 'image/png', data: 'xx' }]);
  assert.match(t, /contract\.pdf/); assert.match(t, /Sponsorship agreement for Lindsay/); assert.doesNotMatch(t, /logo/);
  assert.equal(await attachmentText([{ filename: 'bad.pdf', mimeType: 'application/pdf', data: 'bm90IGEgcGRm' }]), '');
});

test('an AI outage never counts as a failed try on an email', async () => {
  const { AI_DOWN } = await import('../api/leads.js');
  assert.ok(AI_DOWN.test('Claude 400: {"message":"You have reached your specified API usage limits. You will regain access on 2026-11-01"}'));
  assert.ok(AI_DOWN.test('Claude 400: Your credit balance is too low to access the Anthropic API'));
  assert.ok(AI_DOWN.test('AI paused until 2026-11-01T00:10:00Z (Anthropic spend limit)'));
  assert.ok(AI_DOWN.test('Claude 529: overloaded'));
  assert.ok(!AI_DOWN.test('Notion 400: validation_error on property Brand'));
});

test('paid deals only ask to collect a cut when the creator has one', async () => {
  const { paidNextAction } = await import('../lib/invoicing.js');
  assert.equal(paidNextAction(20), 'Collect NOOCAP cut');
  assert.match(paidNextAction(0), /no NOOCAP cut/);
});

test('invoice numbers run per creator as INV-001, INV-002', async () => {
  const { formatInvoiceNumber, highestInvoiceNumber } = await import('../lib/invoicing.js');
  assert.equal(formatInvoiceNumber(1), 'INV-001');
  assert.equal(formatInvoiceNumber(12), 'INV-012');
  assert.equal(highestInvoiceNumber(['INV-001', 'INV-002, INV-004', null, '']), 4);
  assert.equal(highestInvoiceNumber([]), 0);
  assert.equal(formatInvoiceNumber(highestInvoiceNumber(['INV 002']) + 1), 'INV-003');
});
