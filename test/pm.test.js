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
test('a cut sent to the brand moves the board card forward to approval, never backwards (CapCut x ChatGPT, Chris)', () => {
  const boards = [{ creator: 'Chris', ds: 'x' }];
  const card = { creator: 'Chris', title: 'CapCut x ChatGPT', status: '7- In Edit', id: 'c1' };
  assert.equal(cardToMove({ creator: 'Chris', title: 'CapCut x ChatGPT' }, [card], boards, [6, 7, 8])?.card.id, 'c1');
  assert.equal(cardToMove({ creator: 'Chris', title: 'CapCut x ChatGPT' }, [{ ...card, status: '8- Changes' }], boards, [6, 7, 8])?.card.id, 'c1');
  // already at approval or past it: left alone
  assert.equal(cardToMove({ creator: 'Chris', title: 'CapCut x ChatGPT' }, [{ ...card, status: '9- Approval Brand/Creator' }], boards, [6, 7, 8]), null);
  assert.equal(cardToMove({ creator: 'Chris', title: 'CapCut x ChatGPT' }, [{ ...card, status: '11- Ready' }], boards, [6, 7, 8]), null);
});

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

test('split terms: the final share waits for the video to be live, even after the upfront invoice (Manyfast, Nov 18)', async () => {
  const { partDue } = await import('../lib/invoicing.js');
  const terms = '50% upon script approval, 50% after publication';
  const base = { stage: 'Invoiced', invoiceRequested: true, stripeInvoices: 'upfront | in_1 | sent | 750\nfinal | in_2 | draft | 750' };
  assert.equal(partDue(base, 'final', terms), false);
  assert.equal(partDue({ ...base, linksSent: '2026-11-28' }, 'final', terms), true);
  assert.equal(partDue({ ...base, postedLinks: 'https://www.instagram.com/reel/x/' }, 'final', terms), true);
  assert.equal(partDue({ ...base, stage: 'Posted' }, 'final', terms), true);
  assert.equal(partDue({ ...base, stage: 'Script Approved' }, 'upfront', terms), true);
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

test('brand pool: one row per domain, agencies, free mail and our own side', async () => {
  const { buildPool, poolKey, poolProps, poolSig, creatorName } = await import('../lib/brandpool.js');
  assert.equal(poolKey('Jane <jane@acme.com>'), 'acme.com');
  assert.equal(poolKey('bob@gmail.com'), 'bob@gmail.com');
  assert.equal(poolKey('noocapcollab@gmail.com'), null);
  assert.equal(poolKey('collab@valchy.ai'), null);
  assert.equal(creatorName('Nicole McCain'), 'Nicole');
  assert.equal(creatorName('Dymtro'), 'Dmytro');
  const pool = buildPool([
    { email: 'a@acme.com', brand: 'Acme', creator: 'Lindsay', offerType: 'Gifted', budget: 0, date: '2026-09-01' },
    { email: 'b@acme.com', brand: 'Acme AI', creator: 'Duncan', offerType: 'Paid offer', budget: 1500, date: '2026-10-05', booked: true },
    { email: 'x@agency.io', brand: 'Zeely', creator: 'Duncan', date: '2026-10-01' },
    { email: 'y@agency.io', brand: 'Runway', creator: 'Chris', date: '2026-10-02' },
    { email: 'c@acme.com', brand: 'Acme', creators: ['Valeri'], count: false },
    { email: 'noocapcollab@gmail.com', brand: 'Ours', creator: 'Chris' },
  ]);
  assert.equal(pool.size, 2);
  const acme = pool.get('acme.com');
  assert.equal(acme.title, 'Acme AI');
  assert.equal(acme.agency, false);
  assert.deepEqual([...acme.approached].sort(), ['Duncan', 'Lindsay', 'Valeri']);
  assert.deepEqual([...acme.worked], ['Duncan']);
  assert.equal(acme.offerType, 'Paid offer');
  assert.equal(acme.budget, 1500);
  assert.equal(acme.seen, 2);
  assert.equal(acme.first, '2026-09-01');
  assert.equal(acme.last, '2026-10-05');
  const ag = pool.get('agency.io');
  assert.equal(ag.agency, true);
  assert.equal(ag.title, 'agency.io (agency)');
  assert.match(ag.handled, /Zeely/);
  // the sync never writes the team's own columns
  const props = poolProps(acme);
  for (const k of ['Do Not Contact', 'Pitched For', 'Last Pitched', 'Notes']) assert.equal(k in props, false);
  assert.equal(poolSig(props), poolSig(poolProps(acme)));
});

test('brand pool: subdomains fold into the company, junk names and spelling variants are ignored', async () => {
  const { buildPool, poolKey, baseDomain } = await import('../lib/brandpool.js');
  assert.equal(baseDomain('mcn.noxinfluencer.com'), 'noxinfluencer.com');
  assert.equal(baseDomain('mail.brand.com.cn'), 'brand.com.cn');
  assert.equal(poolKey('a@newsletter.crm.brandnetworkinghub.com'), 'brandnetworkinghub.com');
  const pool = buildPool([
    { email: 'a@sparkols.com', brand: 'Sparkols', creator: 'Chris' },
    { email: 'b@sparkols.com', brand: 'Sparkols Agency', creator: 'Lindsay' },
    { email: 'c@sparkols.com', brand: '<UNKNOWN>', creator: 'Lindsay' },
  ]);
  const row = pool.get('sparkols.com');
  assert.equal(row.agency, false);
  assert.equal(row.brands.size, 1);
  assert.notEqual(row.title, '<UNKNOWN>');
});

test('brand pool: reach-out history, newest first, with date and creator', async () => {
  const { buildPool, poolProps } = await import('../lib/brandpool.js');
  const row = buildPool([
    { email: 'a@acme.com', brand: 'Acme', creator: 'Lindsay', offerType: 'Paid offer', budget: 1200, date: '2026-09-03', kind: 'lead, lost' },
    { email: 'b@acme.com', brand: 'Acme', creator: 'Duncan', budget: 1500, date: '2026-10-05T10:00:00Z', kind: 'deal, paid' },
  ]).get('acme.com');
  const lines = row.reachOuts.split('\n');
  assert.equal(lines[0], '5 Oct 2026 · Duncan · Acme · $1,500 · deal, paid');
  assert.equal(lines[1], '3 Sep 2026 · Lindsay · Acme · Paid offer · $1,200 · lead, lost');
  assert.ok(poolProps(row)['Reach-outs']);
});

test('lead catch-up does not spend AI when only follow-ups may be drafted', async () => {
  const { catchUpWanted, catchUpUnanswered } = await import('../lib/leads.js');
  const { LEAD_KINDS_ALLOWED } = await import('../lib/outbox.js');
  if (!process.env.LEADS_DRAFT_KINDS) {
    assert.deepEqual(LEAD_KINDS_ALLOWED, ['Lead follow-up']);
    assert.equal(catchUpWanted(), false);
    assert.deepEqual(await catchUpUnanswered(), []);
  }
});

test('handover: creator team adding noocapcollab opens the deal', async () => {
  const { isHandover } = await import('../lib/inbox.js');
  const email = { to: 'Faved <creators@faved.com>', cc: 'noocapcollab <noocapcollab@gmail.com>', text: 'Hi,\r\n\r\nPlease add noocapcollab@gmail.com to this thread so they can take over the\r\ncollaboration moving forward.\r\n\r\nThanks\r\n\r\nOn Sat, Oct 31 wrote:\n> old' };
  assert.equal(isHandover(email, { from_role: 'creator', brand: 'Luma AI' }), true);
  assert.equal(isHandover(email, { from_role: 'brand', brand: 'Luma AI' }), false);
  assert.equal(isHandover({ ...email, cc: '' }, { from_role: 'creator', brand: 'Luma AI' }), false);
  assert.equal(isHandover({ ...email, text: 'Our rate is $1,500 for one reel.' }, { from_role: 'creator', brand: 'Luma AI' }), false);
});

test('a hand-sent pay-link invoice covering the full fee stops a second invoice', async () => {
  const { coveredByExtra, readInvoices } = await import('../lib/invoicing.js');
  assert.equal(coveredByExtra(readInvoices('extra | in_1 | sent | 3600'), 3600), true);
  assert.equal(coveredByExtra(readInvoices('extra | in_1 | sent | 1000'), 2000), false);
  assert.equal(coveredByExtra(readInvoices('final | in_1 | sent | 3600'), 3600), false);
  assert.equal(coveredByExtra([], 3600), false);
});

test('follow-ups tracker: replies, wins, which nudge worked, who is chased now', async () => {
  const { buildFollowups, briefLine } = await import('../lib/followups.js');
  const now = Date.parse('2026-11-01T06:00:00Z');
  const leads = [
    { id: 'L1', brand: 'Acme', creator: 'Lindsay', status: 'Locked', followUps: 2, lastOur: '2026-10-20T10:00:00Z', lastBrand: '2026-10-22T10:00:00Z', quoted: 1500, agreed: 1500 },
    { id: 'L2', brand: 'Beta', creator: 'Chris', status: 'Waiting on brand', followUps: 1, lastOur: '2026-10-29T10:00:00Z', lastBrand: '2026-10-20T10:00:00Z', ask: 1200 },
    { id: 'L3', brand: 'Gamma', creator: 'Chris', status: 'Waiting on brand', followUps: 3, lastOur: '2026-10-10T10:00:00Z', lastBrand: '2026-09-28T10:00:00Z', ask: 1000 },
  ];
  const deals = [{ id: 'D1', brand: 'Delta', creator: 'Duncan', stage: 'Paid', followUps: 1, invoiceAmount: 1700, paidDate: '2026-10-25', lastOur: '2026-10-21T10:00:00Z' }];
  const drafts = [
    { kind: 'Lead follow-up', status: 'Sent', sentAt: '2026-10-15T10:00:00Z', leadId: 'L1' },
    { kind: 'Lead follow-up', status: 'Sent', sentAt: '2026-10-20T10:00:00Z', leadId: 'L1' },
    { kind: 'Lead follow-up', status: 'Sent', sentAt: '2026-10-29T10:00:00Z', leadId: 'L2' },
    { kind: 'Lead follow-up', status: 'Sent', sentAt: '2026-10-01T10:00:00Z', leadId: 'L3' },
    { kind: 'Lead follow-up', status: 'Sent', sentAt: '2026-10-06T10:00:00Z', leadId: 'L3' },
    { kind: 'Lead follow-up', status: 'Sent', sentAt: '2026-10-10T10:00:00Z', leadId: 'L3' },
    { kind: 'Payment chase', status: 'Sent', sentAt: '2026-10-21T10:00:00Z', dealId: 'D1' },
    { kind: 'Reply', status: 'Sent', sentAt: '2026-10-21T10:00:00Z', leadId: 'L2' },
  ];
  const f = buildFollowups({ drafts, leads, deals, now });
  const acme = f.history.find((r) => r.brand === 'Acme');
  assert.equal(acme.outcome, 'won');
  assert.equal(acme.repliedTo, 2);
  assert.equal(f.history.find((r) => r.brand === 'Gamma').outcome, 'quiet');
  assert.equal(f.history.find((r) => r.brand === 'Delta').outcome, 'paid');
  assert.equal(f.totals.chased, 4);
  assert.equal(f.totals.won, 2);
  assert.equal(f.totals.wonValue, 3200);
  assert.equal(f.byNudge[1].replied, 1); // Acme answered the 2nd follow-up
  const beta = f.active.find((a) => a.brand === 'Beta');
  assert.equal(beta.nudges, 1);
  assert.equal(beta.next, '2026-11-03'); // 5 days after the 1st follow-up
  assert.equal(f.active.find((a) => a.brand === 'Gamma').state, 'gone quiet');
  assert.match(briefLine(f), /Follow-ups: chasing 1 quoted brand and 0 deals/);
});

test('deal check-ins: the brand is not chased while the next move is ours', async () => {
  const { ourMoveText } = await import('../lib/heartbeat.js');
  assert.equal(ourMoveText('Chris to opt in on Creator.co so Bluehost can approve him', 'Chris'), true);
  assert.equal(ourMoveText('Management: review and sign the contract', 'Lindsay'), true);
  assert.equal(ourMoveText('Management to sign the contract', 'Lindsay'), true);
  assert.equal(ourMoveText('Rudraksh writing the script', 'Lindsay'), true);
  assert.equal(ourMoveText('Waiting for Bluehost to share the contract and brand brief', 'Chris'), false);
  assert.equal(ourMoveText('Waiting for the brand to approve the script', 'Chris'), false);
});

test('a posted sponsor video with no brand deal is not an invoice to raise (Whacka × Brad)', async () => {
  const { invoicePlan } = await import('../lib/hq.js');
  const chase = { needs_invoice: [{ brand: 'Whacka', creator: 'Brad', days: 5 }, { brand: 'Runway', creator: 'Chris', days: 3 }], awaiting_payment: [] };
  const deals = [{ brand: 'Runway', creator: 'Chris', stage: 'Posted' }];
  const out = invoicePlan(chase, [], deals, '2026-11-02');
  assert.deepEqual(out.needs_invoice.map((x) => x.brand), ['Runway']);
  assert.deepEqual(out.no_deal.map((x) => x.brand), ['Whacka']);
});

test('invoice rows: creator name is not repeated, numbered videos stay apart, $1 placeholders are not fees', async () => {
  const { cleanBrand, brandFromTitle, videoLabel, realAmount } = await import('../lib/money.js');
  assert.equal(cleanBrand('Luma AI × Brad', 'Brad'), 'Luma AI');
  assert.equal(cleanBrand(brandFromTitle('Polar × Valeri'), 'Valeri'), 'Polar');
  assert.equal(cleanBrand('Rocket x', 'Brad'), 'Rocket x');
  assert.equal(videoLabel('REPLO', 'REPLO - 2'), 'REPLO 2');
  assert.equal(videoLabel('UTOPAI', 'UTOPAI (SENT THE UPDATED VIDEO ON 23rd)'), 'UTOPAI');
  assert.equal(realAmount(1), null);
  assert.equal(realAmount(1500), 1500);
});

test('Hide on the Invoices page sets Skip Invoicing, and those rows are never chased', async () => {
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/revenue.js', import.meta.url), 'utf8'), /'skip' in b\) p\['Skip Invoicing'\]/);
  assert.match(fs.readFileSync(new URL('../lib/money.js', import.meta.url), 'utf8'), /if \(r\['Skip Invoicing'\] === true\) continue;/);
});

test('the sponsor money step runs on every heartbeat (no minute gate that the :04/:14 schedule never hits)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  const at = src.indexOf('report.money = await syncMoney()');
  assert.ok(at > 0);
  assert.doesNotMatch(src.slice(at - 400, at), /getUTCMinutes\(\) % 10/);
});

test('a posted sponsor video whose deal is already invoiced is logged as invoiced and does not ask for an invoice again', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/money.js', import.meta.url), 'utf8');
  assert.match(src, /const billed = billedDeal\(v\);/);
  assert.match(src, /if \(!billed && daysSince\(posted, today\) <= 2/);
});

test('Stripe invoices paid by bank transfer can be marked Paid; "DREAMINA 2" is not labelled "DREAMINA 2 2"', async () => {
  const { videoLabel } = await import('../lib/money.js');
  assert.equal(videoLabel('DREAMINA 2', 'DREAMINA 2'), 'DREAMINA 2');
  const inv = await import('../lib/invoicing.js');
  assert.equal(typeof inv.markPaidByHand, 'function');
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../api/revenue.js', import.meta.url), 'utf8'), /b\.action === 'dealPaid'/);
});

test('a deal email with no brand thread never sends itself (Weglot script went out as a new email)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(src, /const noThread = !deal\.threadId \|\| !deal\.messageRfc;/);
  assert.match(src, /const auto = !noThread &&/);
  assert.match(src, /\(no email thread to reply in\)/);
});

test('a deal whose video card is Posted moves to Posted (that is what starts the invoice)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(src, /video\.num === 12 && deal\.stage && deal\.stage !== 'Lost' && postedRecently && stageBefore\(deal\.stage, 'Posted'\)/);
  const { stageBefore } = await import('../lib/outbox.js');
  assert.equal(stageBefore('Script Approved', 'Posted'), true);
  assert.equal(stageBefore('Invoiced', 'Posted'), false);
});

test('second look keeps real paid offers the AI skipped, and still drops pitches and spam', async () => {
  const { maybeRealDeal, fillTextFromHtml } = await import('../lib/leads.js');
  const e = (subject, text = '') => ({ subject, text });
  // Missed in Nov
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'USD 5250 for 3 long-form YouTube integrations plus 25% affiliate commission on sales' }, e('Re: Paid collab offer with Arcads')));
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'job_or_service_pitch', offer: 'Sponsorship platform facilitating deals', brand: 'Weglot' }, e('Weglot Paid Sponsorship x Automate AI Consulting - deal-ceqxmo'), true));
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'other', offer: 'Unable to determine - email content requires HTML rendering' }, e('Collaboration Opportunity with Sparkols | Domo AI Project')));
  assert.ok(maybeRealDeal({ is_lead: false, not_lead_kind: 'spam', offer: 'Paid Instagram collaboration with Dreamina', brand: 'Dreamina' }, e('{达人名字} x Paid Instagram Collaboration with Dreamina'), true));
  // Still dropped
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'job_or_service_pitch', offer: 'Video editing services (unsolicited sample offered)' }, e('Video editing collaboration')), null);
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'job_or_service_pitch', offer: 'HostEdge offers 20% affiliate commission on all referrals' }, e('A HostEdge partnership: 20% for 12 months')), null);
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'spam', offer: '$49 lifetime vault access with 100+ workflows' }, e('Automate, last look at this')), null);
  assert.equal(maybeRealDeal({ is_lead: false, not_lead_kind: 'spam', offer: 'Contest entry: post one Reel for a chance to win $2,000' }, e('#PredisReelRush is live: $2,000 for one Reel')), null);
  // HTML-only email gets readable text
  assert.match(fillTextFromHtml({ text: '', html: '<p>Hi Lindsay,</p><p>We would love a <b>paid</b> reel for Domo AI, budget $800.</p>' }).text, /paid reel for Domo AI, budget \$800/);
});


test('cuts waiting In Review: a missed go-live is late, today/tomorrow is soon', async () => {
  const { reviewUrgency } = await import('../lib/reviewwait.js');
  assert.equal(reviewUrgency('2026-10-31', '2026-11-02'), 'late');
  assert.equal(reviewUrgency('2026-11-03', '2026-11-02'), 'soon');
  assert.equal(reviewUrgency('2026-11-09', '2026-11-02'), 'later');
  assert.equal(reviewUrgency(null, '2026-11-02'), 'none');
});

test('"Fetch from inbox" requests are read from the Agent Log title', async () => {
  const { parseFetch } = await import('../lib/inboxfetch.js');
  assert.deepEqual(parseFetch('Fetch from inbox: Lindsay | Atoms'), { creator: 'Lindsay', text: 'Atoms' });
  assert.equal(parseFetch('Inbox error: x'), null);
});

test('a file sent on WhatsApp can go out with a brand email (Send File on the draft)', async () => {
  const fs = await import('node:fs');
  const wa = fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8');
  assert.match(wa, /m\.type === 'document' \|\| m\.type === 'image'/);
  assert.match(wa, /file: sentFile/);
  const ob = fs.readFileSync(new URL('../lib/outbox.js', import.meta.url), 'utf8');
  assert.match(ob, /d\.attach === 'File'\) \{\n\s+attachment = await sentFileAttachment\(page\)/);
  const askSrc = fs.readFileSync(new URL('../lib/ask.js', import.meta.url), 'utf8');
  assert.match(askSrc, /'Sent file'/);
  const W = await import('../lib/whatsapp.js');
  assert.equal(typeof W.downloadMedia, 'function');
});

test('a waiting draft is shown (and gets the sent file) instead of the AI writing the same email again', async () => {
  const fs = await import('node:fs');
  const wa = fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8');
  assert.match(wa, /instead of paying the AI to write the same email again/);
  assert.match(wa, /async function attachFileToDraft/);
  const askSrc = fs.readFileSync(new URL('../lib/ask.js', import.meta.url), 'utf8');
  assert.match(askSrc, /The email already written stays as it is/);
  assert.match(askSrc, /do NOT write a new one/);
});

test('a draft card on WhatsApp is followed by the file the email will carry', async () => {
  const W = await import('../lib/whatsapp.js');
  assert.equal(typeof W.sendDraftAttachment, 'function');
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/whatsapp.js', import.meta.url), 'utf8'), /await sendDraftAttachment\(st\.person\.number, d\.id\)/);
  assert.match(fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8'), /W\.sendDraftAttachment\(st\.person\.number, d\.id\)/);
});

test('a brand asking for something only we have (ad codes) gets a WhatsApp question, not a drafted email', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(ib, /needs_our_info: \{ type: 'boolean'/);
  assert.match(ib, /\(x\.needs_our_info \|\| x\.we_owe\)[\s\S]{0,1500}W\.askForInfo\(ask\)/);
  const ob = fs.readFileSync(new URL('../lib/outbox.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ob, /say we will send it over/);
  const wa = fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8');
  assert.match(wa, /answerInfoAsk\(st, infoAskFor\(st, replyTo, text\), text, file\)/);
  const W = await import('../lib/whatsapp.js');
  assert.equal(typeof W.askForInfo, 'function');
});

test('WhatsApp: one short catch-up with buttons instead of a pile, and the reopen template is created if missing', async () => {
  const W = await import('../lib/whatsapp.js');
  assert.equal(typeof W.ensureTemplate, 'function');
  assert.equal(typeof W.catchUpList, 'function');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/whatsapp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function catchUp('), src.indexOf('export async function catchUpList('));
  assert.doesNotMatch(fn, /sendDigest/);
});

test('the video (Raw Footage) Drive folder is shared with anyone with the link, not left private', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/drive.js', import.meta.url), 'utf8');
  assert.match(src, /shareAnyone\(videoF\.id, 'reader'\)/);
  assert.match(src, /export async function openRawFolders/);
});

test('brand change notes go to the editor (not a drafted reply), and the revised cut is drafted once the editor is done', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  const pre = ib.slice(0, ib.indexOf('switch (x.event) {'));
  assert.match(pre, /x\.event === 'brand_reply' && String\(x\.feedback[\s\S]{0,400}x\.event = 'video_feedback'/);
  assert.match(pre, /x\.event = 'script_changes'/);
  const hb = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  // revised cuts now go out through Send to Brand per video (brandRoundsToSend), with no approval (Harsh, Nov 5)
  assert.match(hb, /row\.source !== 'tracker' && round === 1 && row\.status === 'In Review'/);
  assert.match(hb, /brandRoundsToSend\(/);
  const ob = fs.readFileSync(new URL('../lib/outbox.js', import.meta.url), 'utf8');
  assert.match(ob, /case 'Draft video':[\s\S]{0,700}'With Brand'/);
});

test('"UGC 1 / UGC 2 / UGC 3" notes split onto ZEN UGC 1/2/3, and change notes get no "we are on it" reply', async () => {
  const I = await import('../lib/inbox.js');
  const rows = [{ title: 'ZEN UGC 1' }, { title: 'ZEN UGC 2' }, { title: 'ZEN UGC 3' }, { title: 'ZEN UGC 11' }];
  const text = 'Hi there,\nPlease see the below feedback.\nUGC 1\n * 0:13s - Missing the registered trademark after Velo.\n\nUGC 2\n\n * 0:01s - Missing the registered trademark after Velo.\n\nUGC 3\n\n * 0:04s - Make sure Velo is spelled correctly\n * 0:21s - Lowercase the e in email.\n\nBest always,\nNatalie';
  const parts = I.notesPerVideo(text, rows);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.row.title), ['ZEN UGC 1', 'ZEN UGC 2', 'ZEN UGC 3']);
  assert.equal(parts[2].lines.length, 2);
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8'), /x\.needs_reply && !onlyNotes/);
});

test('a hand-added deal with no brand contact gets it from its lead (Hyper3D script could not be emailed)', async () => {
  const H = await import('../lib/heartbeat.js');
  const f = H.leadContactFill({ creator: 'Lindsay' }, { email: 'cherish@mcn.noxinfluencer.com', messageId: '<6096@localhost>', threadId: '<879a@noxinfluencer.com>', subject: 'Paid Collaboration Invitation', creator: 'Lindsay' });
  assert.equal(f.props['Brand Email'], 'cherish@mcn.noxinfluencer.com');
  assert.equal(f.props['Message ID'], '<6096@localhost>');
  assert.equal(f.props['Thread ID'], '<6096@localhost>');
  assert.equal(f.props['Thread CC'], 'collab@automateaiconsulting.com');
  const kept = H.leadContactFill({ brandEmail: 'a@b.co', threadId: 'abc123def456', messageRfc: '<x@y>', threadSubject: 's', threadCc: 'c@d.co' }, { email: 'z@z.co', messageId: '<q@q>' });
  assert.equal(Object.keys(kept.props).length, 0);
});

test('a reply-to Message-ID saved without <> still goes out as a proper In-Reply-To', async () => {
  const { buildMime } = await import('../lib/mime.js');
  const raw = buildMime({ to: 'a@b.co', subject: 'Re: x', text: 'hi', inReplyTo: '6096.1@localhost' });
  const txt = Buffer.from(String(raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const all = String(raw) + txt;
  assert.match(all, /In-Reply-To: <6096\.1@localhost>/);
});

test('the send step passes subject and recipient so n8n can find the brand thread by subject', async () => {
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/outbox.js', import.meta.url), 'utf8'), /lookup: inReplyTo \} : \{\}\), subject: d\.subject \|\| '', to: d\.to \|\| ''/);
});

test('a brand request (ad code) survives the chat save, and a message naming the brand answers it', async () => {
  const fs = await import('node:fs');
  const ch = fs.readFileSync(new URL('../lib/chats.js', import.meta.url), 'utf8');
  assert.match(ch, /if \(m\.infoAsk\) o\.infoAsk = keepAsk\(m\.infoAsk\)/);
  const wa = fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8');
  assert.ok(wa.indexOf('infoAskFor(st, replyTo, text) && (text || file)') < wa.indexOf('await maybeNewDeal(st, text, forwarded)'));
  assert.match(fs.readFileSync(new URL('../lib/ask.js', import.meta.url), 'utf8'), /Never save it as a note or propose a Notion change instead/);
});

test('the deal follows the brand person who wrote last (Emergent: Kritika -> Gautam)', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(ib, /own && sender\.toLowerCase\(\) !== String\(deal\.brandEmail\)\.toLowerCase\(\)\)\)\) set\('Brand Email', sender\)/);
});

test('Nov 3 audit: drafts are checked for filler, placeholders and the wrong creator signature', async () => {
  const O = await import('../lib/outbox.js');
  const a = O.checkDraft({ body: "Hi,\n\nWe'll get the ad codes over to you today.\n\nBest,\nChris's Team", creator: 'Lindsay' });
  assert.match(a.body, /Lindsay's Team\s*$/);
  assert.ok(a.issues.some((i) => /promises/.test(i)));
  const b = O.checkDraft({ body: 'Whenever <UNKNOWN> is ready, reply here.\n\nBest,\nLindsay\'s Team', creator: 'Lindsay' });
  assert.ok(b.issues.some((i) => /placeholder/.test(i)));
  const c = O.checkDraft({ body: 'Here is the ad code: abc. You can pay here: {{invoice_link}}\n\nBest,\nChris\'s Team', creator: 'Chris' });
  assert.equal(c.issues.length, 0);
});

test('Nov 3 audit: chat messages keep every field across a save (forwarded deals, script notes, files)', async () => {
  const C = await import('../lib/chats.js');
  const m = C.keepMessage({ role: 'assistant', content: 'x', meta: 'deal-confirm', dealText: 'brief', creator: 'Brad', brand: 'Luma', file: { mediaId: '1', filename: 'a.pdf' }, notes: 'n' });
  assert.equal(m.creator, 'Brad'); assert.equal(m.dealText, 'brief'); assert.equal(m.file.mediaId, '1'); assert.equal(m.notes, 'n');
});

test('Nov 3 audit: hand-sent scripts are recorded, brand matching is exact, upfront money never closes an unposted deal', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  const hr = ib.slice(ib.indexOf('async function handleOurReply'), ib.indexOf('async function handleOurReply') + 400);
  assert.match(hr, /const atDay = /);
  assert.match(ib, /deal = fit\.length === 1 \? fit\[0\] : null/);
  assert.match(ib, /if \(!Number\.isFinite\(st\) && deal\.stage && stageBefore\(deal\.stage, 'Posted'\)\) upfront = true/);
  const intake = fs.readFileSync(new URL('../lib/intake.js', import.meta.url), 'utf8');
  assert.match(intake, /feedback\.filter\(Boolean\)\.join\('\\n'\)/);
});

test('an invoice request is caught and answered by the invoice, stale drafts are retired when the brand writes again', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(ib, /x\.asks_for_invoice = true;/);
  assert.match(ib, /if \(fromBrand && ageH0\(email\) <= 36\) \{\s*await replaceOlderReplies/);
  assert.match(ib, /x\.event === 'payment_confirmed' && proofFilesOf\(email\)\.length\) for \(const k of/);
  const re = /\b(send|share|provide|issue|need|forward|resend|raise)\b[^.?\n]{0,60}\binvoice\b/i;
  assert.ok(re.test('Could you please provide the invoice for the remaining payment?'));
  assert.ok(!re.test('Thanks, the invoice was paid yesterday.'));
  const inv = fs.readFileSync(new URL('../lib/invoicing.js', import.meta.url), 'utf8');
  assert.match(inv, /asked for the invoice\*\*, but I can't raise it yet/);
});

test('an agency thread with two brands: the email lands on the deal of the brand it is about (Zeely vs CapCut)', async () => {
  const I = await import('../lib/inbox.js');
  const deals = [{ brand: 'Zeely AI', creator: 'Duncan', stage: 'Posted', threadId: 't1' }, { brand: 'CapCut', creator: 'Duncan', stage: 'Negotiating', threadId: 't1' }];
  assert.equal(I.matchDealIndex(deals, { threadId: 't1' }, { brand: 'CapCut' }), 1);
  assert.equal(I.matchDealIndex(deals, { threadId: 't1' }, { brand: 'Zeely' }), 0);
  assert.equal(I.matchDealIndex(deals, { threadId: 't1' }, { brand: '' }), 0);
});

test('a brand saying it paid without any proof is not marked paid; the PM asks for the confirmation', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  const c = ib.slice(ib.indexOf("case 'payment_confirmed'"), ib.indexOf("case 'payment_confirmed'") + 5200);
  assert.match(c, /if \(fromBrand && !hasProof\)/);
  assert.match(c, /ask them to share the payment confirmation/);
});

test('"we paid" in an old deal thread is checked against the brand\'s other deals in Stripe and thanked there (ElevenLabs x Duncan, Nov 19)', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  const c = ib.slice(ib.indexOf("case 'payment_confirmed'"), ib.indexOf("case 'payment_confirmed'") + 9000);
  assert.match(c, /paidSiblingDeal\(deal\)/);
  assert.match(c, /paymentThanks\(\{ \.\.\.deal, threadId: email\.threadId/);
  assert.ok(c.indexOf('paidSiblingDeal') < c.indexOf("set('Deal Stage', 'Paid')"));
});

test('a hand-filed deal with no email thread is treated as a WhatsApp deal (Buzzy × Brad got an email-style invoice ping)', async () => {
  const fs = await import('node:fs');
  const b = fs.readFileSync(new URL('../lib/briefs.js', import.meta.url), 'utf8');
  assert.match(b, /channel: get\('Channel'\) \|\| \(!get\('Thread ID'\) && !get\('Message ID'\) && get\('Deal Source'\) === 'Manually added' \? 'WhatsApp' : 'Email'\)/);
  const h = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(h, /waOnce\('Script ready'/);
  assert.match(h, /waOnce\('Posted'/);
});

test('payment details are printed only from verified Creator Payment Details rows, never from the deal or Vercel (INV-001, Nov 16)', async () => {
  const G = await import('../lib/invoiceguard.js');
  assert.equal(G.paymentText({ 'Bank Name': 'X', 'Account Number / IBAN': 'Y' }), 'Bank: X\nAccount number / IBAN: Y');
  const src = (await import('node:fs')).readFileSync(new URL('../lib/invoicing.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export async function paymentDetails'), src.indexOf('export async function paymentDetails') + 400), /PAYMENT_DETAILS_|deal\?\.paymentDetails/);
});

test('a duplicate inbox delivery held by another run is not logged as a failure', async () => {
  const { emailSummary } = await import('../lib/runs.js');
  const s = emailSummary([{ subject: 'Re: Dreamina', action: 'error', busy: true, why: 'busy' }, { subject: 'Re: X', action: 'error', why: 'boom' }]);
  assert.equal(s.errors.length, 1);
  assert.match(s.did[0], /left to the run already handling it/);
});

test('a WhatsApp message naming another brand never edits the draft on screen', async () => {
  const { namesOtherBrand } = await import('../api/whatsapp.js');
  const deals = [{ brand: 'Runway' }, { brand: 'Tripo' }];
  const drafts = [{ id: 'd1', brand: 'Tripo' }, { id: 'd2', brand: 'Runway' }];
  const msg = 'Runway x Chris\n\nLink and discount code add in Bio\n\nInstagram adcode-xyz';
  assert.equal(await namesOtherBrand(msg, 'd1', { deals, drafts }), true);
  assert.equal(await namesOtherBrand(msg, 'd2', { deals, drafts }), false);
  assert.equal(await namesOtherBrand('add a line about the bio link', 'd1', { deals, drafts }), false);
});

test('a brand ask nobody answered is found from the deal memory', async () => {
  const { owedItem } = await import('../lib/owed.js');
  const deal = { stage: 'Invoiced', channel: 'Email', lastBrand: '2026-11-02T13:01', lastOur: '2026-10-28T14:39', memory: 'AGREED: x<br /><br />OPEN NOW: Two items pending. We owe: the ad codes for TikTok and Instagram for video 2.' };
  assert.match(owedItem(deal, '2026-11-03').need, /ad codes/);
  assert.equal(owedItem({ ...deal, lastOur: '2026-11-03T08:00' }, '2026-11-03'), null);
  assert.equal(owedItem({ ...deal, memory: 'OPEN NOW: We owe: nothing.' }, '2026-11-03'), null);
  assert.equal(owedItem({ ...deal, channel: 'WhatsApp' }, '2026-11-03'), null);
});

test('owed sweep asks only for things a person hands over, never team work', async () => {
  const { owedItem } = await import('../lib/owed.js');
  const base = { stage: 'Script Sent', channel: 'Email', lastBrand: '2026-11-02T13:01', lastOur: '2026-10-28T14:39' };
  const m = (w) => ({ ...base, memory: `OPEN NOW: We owe: ${w}.` });
  assert.equal(owedItem(m('revised videos with all requested changes applied'), '2026-11-03'), null);
  assert.equal(owedItem(m('delivery of the filmed and edited video by end of day'), '2026-11-03'), null);
  assert.equal(owedItem(m('upload the script to the campaign link on Faved'), '2026-11-03'), null);
  assert.ok(owedItem(m("Duncan's Luma account email and a signed contract"), '2026-11-03'));
});

test('a brief for the next reel gets its own card, an update stays on the current one', async () => {
  const { isNextVideo } = await import('../lib/briefs.js');
  assert.equal(isNextVideo({ new_video: true }, 12), true);   // SpeakOn reel 2 while reel 1 is posted
  assert.equal(isNextVideo({ is_update: false }, 12), true);  // card already posted
  assert.equal(isNextVideo({ is_update: true }, 4), false);   // revised brief for the script in progress
  assert.equal(isNextVideo({}, 0), false);                    // no linked card
});

test('a deal for several reels is counted from the AI or the deliverables', async () => {
  const { videoCount } = await import('../lib/briefs.js');
  assert.equal(videoCount({ video_count: 2 }), 2);
  assert.equal(videoCount({ deliverables: '2 Instagram reels cross-posted to TikTok' }), 2);
  assert.equal(videoCount({ deliverables: 'Two sponsored videos' }), 2);
  assert.equal(videoCount({}, { deliverables: '3 UGC videos' }), 3);
  assert.equal(videoCount({ deliverables: 'One reel on IG, TikTok, YouTube Shorts' }), 1);
  assert.equal(videoCount({ deliverables: 'Dedicated reel' }), 1);
});

test('"in our payment queue, due to be paid 13/11" is not a payment', async () => {
  const { isPaymentScheduled } = await import('../lib/inbox.js');
  assert.equal(isPaymentScheduled('Thank you for sharing the invoice. I can confirm receipt and also that this invoice is now in our payment queue, due to be paid 13/11/26'), true);
  assert.equal(isPaymentScheduled('The payment has been sent today, please check your account'), false);
  assert.equal(isPaymentScheduled('Payment is done on our end'), false);
});

test('a brand approval with their validated script is approval, not changes for the writer', async () => {
  const { isApprovedWithEdits } = await import('../lib/inbox.js');
  assert.equal(isApprovedWithEdits('Update\nWeglot - Approved Idea, Script & Live Date With Feedback:\nHere is the validated version with few updates :)\n(0:00) If you build...\nNext Step\nDraft video - waiting on creator submission'), true);
  assert.equal(isApprovedWithEdits('Thanks for the script. Please revise the hook and send us a revised script.'), false);
});

test('the deal conversation is kept word for word, one entry per email', async () => {
  const { transcriptLine } = await import('../lib/memory.js');
  const l = transcriptLine({ who: 'brand (Ushni)', date: '2026-10-30T02:07:00Z', subject: 'Re: Polar', text: 'Second video by Thursday.\n\n\n\nThanks' });
  assert.match(l, /^📨 2026-10-30 · brand \(Ushni\) · Re: Polar\nSecond video by Thursday\.\n\nThanks$/);
});

test('second reader: which decisions get checked, and what it is shown', async () => {
  const V = await import('../lib/verify.js');
  assert.equal(V.needsSecondRead({ event: 'not_relevant' }), false);
  assert.equal(V.needsSecondRead({ event: 'brand_reply', needs_reply: false }), false);
  assert.equal(V.needsSecondRead({ event: 'payment_confirmed' }), true);
  assert.equal(V.needsSecondRead({ event: 'brand_reply', asks_for_invoice: true }), true);
  const t = V.decisionText({ event: 'payment_confirmed', deal_stage: 'Paid', summary: ['in our payment queue'] }, { brand: 'Runway AI', creator: 'Chris', stage: 'Invoiced', finalRate: 3600 });
  assert.match(t, /Runway AI x Chris \(stage Invoiced, rate 3600\)/);
  assert.match(t, /event: payment_confirmed/);
  assert.match(V.RULES, /payment queue/);
  assert.equal(V.DEFAULT_MODE, 'team');
  // team mode checks only what would reach Rudraksh or an editor
  assert.equal(V.pingsTeam({ event: 'brief' }), true);
  assert.equal(V.pingsTeam({ event: 'script_changes' }), true);
  assert.equal(V.pingsTeam({ event: 'video_feedback' }), true);
  assert.equal(V.pingsTeam({ event: 'brand_reply', on_hold: true }), true);
  assert.equal(V.pingsTeam({ event: 'payment_confirmed' }), false);
  assert.equal(V.pingsTeam({ event: 'brand_reply', needs_reply: true }), false);
});

test('lessons: the ones that fit the situation come first, and real edits count as corrections', async () => {
  const L = await import('../lib/lessons.js');
  const lessons = [
    { lesson: 'Scheduled is not paid', when: 'A brand writes about paying', do: 'Only Stripe or a receipt counts as paid.', never: 'Mark Paid from a promise', area: 'Payments', seen: 1 },
    { lesson: 'One video card per reel', when: 'A deal covers 2+ reels', do: 'Make a card per reel.', never: '', area: 'Briefs & scripts', seen: 1 },
  ];
  const top = L.relevant(lessons, 'Thank you for the invoice, it is in our payment queue, due to be paid 13/11', { max: 1 });
  assert.equal(top[0].lesson, 'Scheduled is not paid');
  assert.match(L.lessonsText(top), /never repeat it/);
  assert.equal(L.changedEnough('Hi there, thanks', 'Hi there, thanks'), false);
  assert.equal(L.changedEnough('Hi Natalie, we will send the codes shortly. Best', 'Hi Natalie, here are the ad codes: IG abc, TikTok xyz. Best'), true);
});

test('test bank: judging the reader against the right answer', async () => {
  const { judge } = await import('../lib/evals.js');
  const { CASES } = await import('../lib/evalcases.js');
  const runway = CASES.find((c) => c.id === 'runway-payment-queue');
  assert.deepEqual(judge(runway, { event: 'brand_reply' }), []);
  assert.equal(judge(runway, { event: 'payment_confirmed', deal_stage: 'Paid' }).length, 2);
  const weglot = CASES.find((c) => c.id === 'weglot-faved-approval');
  assert.equal(judge(weglot, { event: 'script_changes' }).length, 1);
  const inv = CASES.find((c) => c.id === 'invoice-request');
  assert.deepEqual(judge(inv, { event: 'brand_reply' }), []); // the invoice-request rule catches it even if the AI misses the flag
  assert.ok(CASES.length >= 10 && CASES.every((c) => c.id && c.email?.text && c.expect));
});

test('test bank: the fixed guards turn the known mistakes around', async () => {
  const { applyTextGuards } = await import('../lib/inbox.js');
  const { CASES } = await import('../lib/evalcases.js');
  const weglot = CASES.find((c) => c.id === 'weglot-faved-approval');
  assert.equal(applyTextGuards({ event: 'brief' }, weglot.email).event, 'script_approved');
  const runway = CASES.find((c) => c.id === 'runway-payment-queue');
  const x = applyTextGuards({ event: 'payment_confirmed', deal_stage: 'Paid' }, runway.email);
  assert.equal(x.event, 'brand_reply'); assert.equal(x.deal_stage, null);
});

test('scorecard: accuracy, per-kind record and earned autopilot', async () => {
  const S = await import('../lib/scorecard.js');
  const rows = [...Array(9)].map(() => ({ kind: 'Draft video', status: 'Sent', error: '' })).concat([
    { kind: 'Reply', status: 'Sent', error: '' }, { kind: 'Reply', status: 'Rejected', error: '' },
    { kind: 'Posted links', status: 'Sent', error: '' }, { kind: 'Follow-up', status: 'Rejected', error: 'Auto-rejected by system check: filler' },
  ]);
  const rec = S.kindRecord(rows, ['Polar Reply']);
  assert.equal(rec['Draft video'].sent, 9); assert.equal(rec.Reply.rejected, 1); assert.equal(rec.Reply.edited, 1); assert.equal(rec['Follow-up'].autoRejected, 1);
  assert.deepEqual(S.earnedKinds(rec, ['Follow-up']).map((e) => e.kind), ['Draft video']); // Reply never, Posted links too few
  assert.equal(S.accuracy({ decisions: 50, corrections: 5 }), 90);
  const txt = S.scorecardText({ days: 7, decisions: 50, corrections: 5, accuracy: 90, totals: { sent: 40, rejected: 2, autoRejected: 1, edited: 2 }, sr: { agree: 30, disagree: 2, flags: 1 }, test: 'Test bank 2026-11-09: 10/10 right', newLessons: ['A'], repeated: [], spend: { usd: 12.5, budget: 20 }, earned: [{ kind: 'Draft video', sent: 9 }] });
  assert.match(txt, /90% right/); assert.match(txt, /autopilot Draft video on/);
});

test('a brand hold only pings the script writer when a brief/card exists (Emergent, Nov 4)', async () => {
  const { holdPingsWriter } = await import('../lib/inbox.js');
  assert.equal(holdPingsWriter({ brand: 'Emergent' }), false);
  assert.equal(holdPingsWriter({ brand: 'Emergent', linkedVideo: '' }), false);
  assert.equal(holdPingsWriter({ brand: 'Weglot', linkedVideo: 'https://app.notion.com/p/abc' }), true);
});

test('an email can never move a deal to Invoiced or Paid on its own (Topview × Chris, Nov 4)', async () => {
  const { aiStage, MONEY_STAGES } = await import('../lib/inbox.js');
  assert.deepEqual(MONEY_STAGES, ['Invoiced', 'Paid']);
  assert.equal(aiStage('Invoiced'), null);
  assert.equal(aiStage('Paid'), null);
  assert.equal(aiStage('Posted'), 'Posted');
  assert.equal(aiStage('Script Approved'), 'Script Approved');
});

test('invoice due days come from the contract terms (Topview: 14 days, not Stripe default 3)', async () => {
  const { termsDueDays } = await import('../lib/invoicing.js');
  assert.equal(termsDueDays('100% within 14 days after the video is live and a valid invoice is received'), 14);
  assert.equal(termsDueDays('payable within fourteen (14) days'), 14);
  assert.equal(termsDueDays('Net 30'), 30);
  assert.equal(termsDueDays('net-45 days from the date the invoice is submitted'), 45);
  assert.equal(termsDueDays('50% upfront, 50% on publish'), null);
});

test('a late invoice keeps the short due date (Topview posted Sep 18, invoiced Nov 4: 3 days)', async () => {
  const { dueDaysFor, DUE_DAYS } = await import('../lib/invoicing.js');
  assert.equal(dueDaysFor({ paymentTerms: 'payable within fourteen (14) days', delivered: '2026-09-18' }, '2026-11-04'), DUE_DAYS);
  assert.equal(dueDaysFor({ paymentTerms: 'Net 30', delivered: '2026-11-01' }, '2026-11-04'), 30);
  assert.equal(dueDaysFor({ paymentTerms: '' }, '2026-11-04'), DUE_DAYS);
});

test('the address a brand gives for invoices is kept and used for chases (GetRamped finance, Nov 4)', async () => {
  const { billingEmailIn, withBillingEmail, billingEmailOf } = await import('../lib/invoicing.js');
  assert.equal(billingEmailIn('Hi! Invoices are paid 30 days after they are sent to finance@getramped.com'), 'finance@getramped.com');
  assert.equal(billingEmailIn('Please send the invoice to ap@brand.io, thanks'), 'ap@brand.io');
  assert.equal(billingEmailIn('Thanks for the video, looks great'), null);
  assert.equal(billingEmailOf(withBillingEmail('', 'finance@getramped.com')), 'finance@getramped.com');
  assert.equal(billingEmailOf(withBillingEmail('{"company_name":"Ramped LLC","email":"celina@getramped.com"}', 'finance@getramped.com')), 'finance@getramped.com');
  assert.equal(billingEmailOf(withBillingEmail('Company: X | Email: a@b.com', 'finance@getramped.com')), 'finance@getramped.com');
});

test('brand changes send the board card back to 8- Changes only from edit/approval stages (CapCut, Nov 4)', async () => {
  const { cardToMove, CHANGES_NUMBER } = await import('../lib/intake.js');
  assert.equal(CHANGES_NUMBER, 8);
  const boards = [{ creator: 'Chris', ds: 'x' }];
  const card = { creator: 'Chris', title: 'CapCut x ChatGPT', status: '9- Approval Brand/Creator', id: 'c1' };
  assert.equal(cardToMove({ creator: 'Chris', title: 'CapCut x ChatGPT' }, [card], boards, [7, 9, 10, 11])?.card.id, 'c1');
  assert.equal(cardToMove({ creator: 'Chris', title: 'CapCut x ChatGPT' }, [{ ...card, status: '12- Posted' }], boards, [7, 9, 10, 11]), null);
});

test('a brand still waiting for something we sent always needs a reply (Hyper3D, Nov 3)', async () => {
  const { stillWaitingFor, applyTextGuards } = await import('../lib/inbox.js');
  assert.equal(stillWaitingFor('Okay, got it. Hope to receive the script soon.'), 'script');
  assert.equal(stillWaitingFor("Hi, we haven't received the invoice yet"), 'invoice');
  assert.equal(stillWaitingFor('Thanks, the video looks great'), null);
  const x = { event: 'brand_reply', needs_reply: false };
  applyTextGuards(x, { text: 'Okay, got it. Hope to receive the script soon.' });
  assert.equal(x.needs_reply, true);
  assert.match(x.we_owe, /script again/);
});

test('two deals on one thread: money goes to the invoiced one, a new brief to the working one', async () => {
  const { threadDeal } = await import('../lib/inbox.js');
  const deals = [
    { id: 'oct', brand: 'ElevenLabs', stage: 'Invoiced', threadId: 't1', created: '2026-10-23T00:00:00Z' },
    { id: 'nov', brand: 'ElevenLabs', stage: 'Brief Received', threadId: 't1', created: '2026-11-04T00:00:00Z' },
  ];
  assert.equal(threadDeal(deals, { threadId: 't1', text: 'Our finance team has processed the payment for your invoice.' }).id, 'oct');
  assert.equal(threadDeal(deals, { threadId: 't1', text: 'Thanks for the script, the ElevenLabs team approved it!' }).id, 'nov');
  assert.equal(threadDeal([deals[0]], { threadId: 't1', text: 'script approved' }).id, 'oct');
});

test('a deal already asked on WhatsApp in the last day is not asked again', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../lib/whatsapp.js', import.meta.url), 'utf8');
  assert.match(src, /m\.infoAsk\?\.dealId === ask\.dealId && !m\.resolved/);
  assert.match(src, /they need something from us/);
});

// System check, Nov 5: the test bank case zeely-claimed-paid ("we have already paid the 50% advance") came back as a
// plain brand_reply, so the payment claim was never checked against Stripe or proof
test('"we have already paid the advance" is a payment claim; scheduled payments and invoice talk are not', async () => {
  const { isPaymentClaimed } = await import('../lib/inbox.js');
  assert.equal(isPaymentClaimed('Hi team,\n\nWe have already paid the 50% advance for this collaboration. Please let us know if you need anything else.'), true);
  assert.equal(isPaymentClaimed('The payment for the invoice was sent today by bank transfer'), true);
  assert.equal(isPaymentClaimed("We've paid the invoice, please confirm"), true);
  assert.equal(isPaymentClaimed('This invoice is now in our payment queue, due to be paid 13/11/26'), false);
  assert.equal(isPaymentClaimed('The payment is scheduled for processing this week'), false);
  assert.equal(isPaymentClaimed('Could you please provide the invoice for the remaining payment?'), false);
  assert.equal(isPaymentClaimed('We will pay once the video is live'), false);
});

// System check, Nov 5: the 03:35 IST digest listed "Waiting for PromoCut to approve", "Waiting for payment" and team
// work ("Editor making the brand's changes", "Send Luma AI the draft script") as things Harsh had to decide
test('digest asks only about deals that need Harsh, not brand waits or team work', async () => {
  const { notHarshsCall } = await import('../lib/whatsapp.js');
  for (const t of ['Waiting for PromoCut to approve or provide feedback on the script', 'Waiting for payment', "Editor making the brand's changes", 'Send Luma AI the draft script (promised 2026-11-02)', 'Lindsay filming the approved script, then submit the draft video on Faved', 'Shreya revising the script', 'Paid, nothing left to do (no NOOCAP cut)'])
    assert.equal(notHarshsCall(t), true, t);
  for (const t of ['Waiting on us: Register noocaptools@gmail.com with Atoms tool, then confirm to brand', 'Brand asked for the media kit before going ahead', 'Decide whether to accept the $1,200 counter', ''])
    assert.equal(notHarshsCall(t), false, t);
});

test('WhatsApp invoice commands: "invoice" opens the flow, "uploaded Semrush" marks it sent', async () => {
  const W = await import('../lib/wainvoice.js');
  for (const t of ['invoice', 'Invoices', 'raise invoice', 'raise an invoice?']) assert.equal(W.isInvoiceCommand(t), true, t);
  for (const t of ['raise the semrush invoice for Lindsay', 'what about the invoice for Topview']) assert.equal(W.isInvoiceCommand(t), false, t);
  assert.equal(W.uploadedCommand('uploaded Semrush'), 'Semrush');
  assert.equal(W.uploadedCommand('Uploaded the semrush invoice'), 'semrush');
  assert.equal(W.uploadedCommand('I uploaded it'), null);
});

test('"invoice semrush 1500" goes straight to that deal with the amount', async () => {
  const W = await import('../lib/wainvoice.js');
  assert.deepEqual(W.quickInvoice('invoice semrush 1500'), { brand: 'semrush', amount: 1500 });
  assert.deepEqual(W.quickInvoice('Invoice Polar'), { brand: 'Polar', amount: null });
  assert.deepEqual(W.quickInvoice('invoice chatgpt $1,800'), { brand: 'chatgpt', amount: 1800 });
  assert.equal(W.quickInvoice('invoice'), null);
  assert.equal(W.quickInvoice('invoice for semrush was paid?'), null);
});

test('a Paid deal whose brand wrote again after the payment still gets its open ask raised', async () => {
  const { owedItem } = await import('../lib/owed.js');
  const base = { stage: 'Paid', paidDate: '2026-11-01', lastOur: '2026-10-28T07:12:00Z', memory: 'OPEN NOW: We owe: estimated timeline and confirmation of the brief details.' };
  assert.ok(owedItem({ ...base, lastBrand: '2026-11-05T09:11:00Z' }, '2026-11-05'));
  assert.equal(owedItem({ ...base, lastBrand: '2026-10-30T09:11:00Z' }, '2026-11-05'), null);
});

test('a brand asking when the draft comes is put to Harsh; plain team work is not', async () => {
  const { owedItem } = await import('../lib/owed.js');
  const d = { stage: 'Brief Received', lastOur: '2026-10-28', lastBrand: '2026-11-05' };
  assert.ok(owedItem({ ...d, memory: 'OPEN NOW: We owe: estimated delivery timeline for first draft.' }, '2026-11-05'));
  assert.equal(owedItem({ ...d, memory: 'OPEN NOW: We owe: the revised cut.' }, '2026-11-05'), null);
});

test('"date speakon 12 nov" sets a post date; no guessing from loose text', async () => {
  const { parseDateCommand } = await import('../lib/postdates.js');
  const now = new Date('2026-11-05T09:00:00Z');
  assert.deepEqual(parseDateCommand('date speakon 12 nov', now), { brand: 'speakon', day: '2026-11-12' });
  assert.deepEqual(parseDateCommand('post date Semrush Nov 20', now), { brand: 'Semrush', day: '2026-11-20' });
  assert.deepEqual(parseDateCommand('date polar 2026-11-18', now), { brand: 'polar', day: '2026-11-18' });
  assert.deepEqual(parseDateCommand('date speakon 3 jan', now), { brand: 'speakon', day: '2027-01-03' });
  assert.equal(parseDateCommand('what date is speakon going live?', now), null);
});

test('the deal briefing finds the deal a message names, and the creator narrows it', async () => {
  const { namedDeals } = await import('../lib/briefing.js');
  const deals = [
    { brand: 'SpeakOn AI', creator: 'Chris', stage: 'Brief Received', lastBrand: '2026-11-05' },
    { brand: 'ElevenLabs', creator: 'Duncan', stage: 'Script Sent', lastBrand: '2026-11-04' },
    { brand: 'ElevenLabs', creator: 'Valeri', stage: 'Paid', lastBrand: '2026-10-20' },
  ];
  assert.deepEqual(namedDeals('send the script to speakon', deals).map((d) => d.creator), ['Chris']);
  assert.deepEqual(namedDeals('tell elevenlabs duncan is filming tomorrow', deals).map((d) => d.creator), ['Duncan']);
  assert.equal(namedDeals('elevenlabs status?', deals)[0].creator, 'Duncan');
  assert.equal(namedDeals('hi', deals).length, 0);
});

test('an agency pitching another brand in a deal thread, or asking our rate, is an inquiry, not a brief', async () => {
  const { briefIsInquiry } = await import('../lib/inbox.js');
  const deals = [{ brand: 'Kylon', creator: 'Lindsay', threadId: 't1' }];
  const teamily = { threadId: 't1', text: "Yes, thank you! Alyssa will follow up regarding the Kylon payment.\\nI also wanted to introduce another project: Teamily. Could you please share your current rate for a video integration?" };
  assert.ok(briefIsInquiry(teamily, { brand: 'Teamily' }, deals));
  assert.ok(briefIsInquiry({ threadId: 't9', text: 'Love your content, what would you charge for one reel?' }, { brand: 'Foo' }, deals));
  assert.equal(briefIsInquiry({ threadId: 't1', text: 'Here is the brief for the Kylon video, please send the script by Friday.' }, { brand: 'Kylon' }, deals), null);
});

test('one email per Stripe invoice: a waiting or sent invoice email blocks a second one (ChatGPT x Duncan, Nov 5)', async () => {
  const { invoiceEmailFilter } = await import('../lib/outbox.js');
  const f = invoiceEmailFilter('extra|in_1UYKs2P2gZWUBjRtue9Kd0kC');
  assert.deepEqual(f.and[0], { property: 'Stripe Invoice', rich_text: { contains: 'in_1UYKs2P2gZWUBjRtue9Kd0kC' } });
  assert.deepEqual(f.and[1].or.map((x) => x.select.equals).sort(), ['Draft', 'Sent']);
  assert.equal(invoiceEmailFilter(''), null);
  assert.equal(invoiceEmailFilter(undefined), null);
});

test('a delivery promise like "within 5 business days" is flagged as filler (Readdy x Lindsay, Nov 5)', async () => {
  const { checkDraft } = await import('../lib/outbox.js');
  const readdy = 'Hi Harper,\n\nThanks so much for the approval. Filming is in progress now and we expect to have the first cut ready for you within 5 business days.\n\nBest,\nLindsay\'s Team';
  assert.ok(checkDraft({ body: readdy, creator: 'Lindsay' }).issues.some((i) => /promises/.test(i)));
  assert.ok(checkDraft({ body: 'We will have it within two weeks.', creator: 'Lindsay' }).issues.length);
  assert.equal(checkDraft({ body: 'The video goes live on November 9.\n\nBest,\nLindsay\'s Team', creator: 'Lindsay' }).issues.length, 0);
});

test('undated sponsor cards go to Harsh in one message, the rest counted (post-date ask split in 3, Nov 5)', async () => {
  const { postDateAskText } = await import('../lib/postdates.js');
  const cards = Array.from({ length: 17 }, (_, i) => ({ title: `Card ${i + 1}`, creator: 'Chris', status: '11- Ready' }));
  const t = postDateAskText(cards);
  assert.match(t, /^🙋 \*17 sponsor cards have no post date\*/);
  assert.equal((t.match(/^• \*Card/gm) || []).length, 8);
  assert.match(t, /…and 9 more/);
  assert.doesNotMatch(postDateAskText(cards.slice(0, 1)), /more/);
});

// Harsh, Nov 5: a revised cut after the brand's changes goes straight back to the brand (ZEN UGC 3 sat at In Review)
test('isBrandRound: only brand-change rounds finished after the cutoff', async () => {
  const { isBrandRound } = await import('../lib/brandsend.js');
  const row = (o = {}) => ({ last_edited_time: o.edited || '2026-11-06T10:00:00Z', properties: {
    Status: { type: 'select', select: { name: o.status || 'In Review' } },
    'Frame.io Link': { type: 'url', url: o.frame === undefined ? 'https://f.io/x' : o.frame },
    Revisions: { type: 'number', number: o.rev ?? 1 },
    'Sent To Brand At': { type: 'date', date: o.sent ? { start: o.sent } : null },
    'Changes Requested At': { type: 'date', date: o.asked === null ? null : { start: o.asked || '2026-11-06T08:00:00Z' } },
  } });
  assert.equal(isBrandRound(row()), true);
  assert.equal(isBrandRound(row({ rev: 0 })), false, 'internal changes stay with Harsh');
  assert.equal(isBrandRound(row({ rev: 0, sent: '2026-11-05T13:00:00Z' })), true, 'already with the brand');
  assert.equal(isBrandRound(row({ status: 'Changes' })), false);
  assert.equal(isBrandRound(row({ frame: null })), false);
  assert.equal(isBrandRound(row({ asked: null })), false);
  assert.equal(isBrandRound(row({ edited: '2026-11-04T10:00:00Z', asked: '2026-11-03T10:00:00Z' })), false, 'old rows never emailed out of the blue');
});

// Nov 5: GrowMaxValue's new CapCut brief for Chris was filed onto another agency's CapCut x ChatGPT deal
test('sameDealParty: same brand from another company on another thread is a new deal', async () => {
  const { sameDealParty } = await import('../lib/briefs.js');
  const deal = { brand: 'CapCut', creator: 'Chris', threadId: 'aaa111', brandEmail: 'alisa@capcut-agency.com', threadCc: 'ops@capcut-agency.com' };
  assert.equal(sameDealParty(deal, { threadId: 'bbb222', from: 'Mia Brown <mia.brown@growmaxvalue.com>' }), false);
  assert.equal(sameDealParty(deal, { threadId: 'aaa111', from: 'Mia Brown <mia.brown@growmaxvalue.com>' }), true, 'same thread always');
  assert.equal(sameDealParty(deal, { threadId: 'ccc333', from: 'Alisa <alisa@capcut-agency.com>' }), true, 'same company, new thread');
  assert.equal(sameDealParty(deal, { threadId: 'ccc333', from: 'ops <ops@mail.capcut-agency.com>' }), true, 'subdomain of a CC');
  assert.equal(sameDealParty({ ...deal, threadId: '' }, { threadId: 'x', from: 'a@b.com' }), true, 'WhatsApp / hand-added deal');
  assert.equal(sameDealParty({ ...deal, brandEmail: 'jo@gmail.com', threadCc: '' }, { threadId: 'z', from: 'sam@gmail.com' }), false, 'free mail compares the address');
});

test('inbox: the creator on the email confirms the creator, not the deal', async () => {
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(ib, /!sameThread && x\.from_role === 'brand' && !sameDealParty\(d, email\)/);
  const br = fs.readFileSync(new URL('../lib/briefs.js', import.meta.url), 'utf8');
  assert.match(br, /!givenDeal && deal && !sameDealParty\(deal, email\)/);
});

// Nov 5: deals opened from a creator's handover email had no Brand Email (Valchy AI x Valeri, Panda Security x Chris)
test('handoverBrandEmail: the brand is who our handover email was written to', async () => {
  const { handoverBrandEmail } = await import('../lib/inbox.js');
  assert.equal(handoverBrandEmail({ to: 'Kico <kico@partnerly.us>', cc: 'noocapcollab@gmail.com' }), 'kico@partnerly.us');
  assert.equal(handoverBrandEmail({ to: 'no-reply@luagroup.com', cc: 'business@luagroup.com, noocapcollab@gmail.com' }), 'business@luagroup.com');
  assert.equal(handoverBrandEmail({ to: 'noocapcollab@gmail.com', cc: 'lindsay@automateaiconsulting.com' }), null);
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8'), /else if \(isHandover\(email, x\)\) setIf\(schema, props, 'Brand Email', handoverBrandEmail\(email\)\)/);
});

test('no before-due payment check-in once the brand answered the invoice (Runway "scheduled 13/11", Dreamina "submitted", Nov 6)', async () => {
  const { brandAnsweredInvoice } = await import('../lib/heartbeat.js');
  // Runway: invoice Oct 29, brand confirmed it is scheduled on Nov 3 after our last email
  assert.equal(brandAnsweredInvoice({ invoiceSent: '2026-10-29', lastOur: '2026-11-03T10:43:00.000Z', lastBrand: '2026-11-03T12:08:00.000Z' }, true), true);
  // Dreamina: brand said payment submitted after our last email
  assert.equal(brandAnsweredInvoice({ invoiceSent: '2026-11-01', lastOur: '2026-11-02T07:12:00.000Z', lastBrand: '2026-11-03T04:30:00.000Z' }, true), true);
  // Zeely: our invoice email is the last word, so a gentle check-in is fine
  assert.equal(brandAnsweredInvoice({ invoiceSent: '2026-11-03', lastOur: '2026-11-03T08:17:00.000Z', lastBrand: '2026-11-03T07:56:00.000Z' }, true), false);
  // past the due date the real chase always goes ahead
  assert.equal(brandAnsweredInvoice({ invoiceSent: '2026-10-29', lastOur: '2026-11-03T10:43:00.000Z', lastBrand: '2026-11-03T12:08:00.000Z' }, false), false);
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(src, /!brandAnsweredInvoice\(deal, !!beforeDue\)/);
});

test('a failed WhatsApp template nudge reports what Meta says about the template (Pratham 132001, Nov 6)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/whatsapp.js', import.meta.url), 'utf8');
  assert.match(src, /const t = await ensureTemplate\(\)/);
  assert.match(src, /last\.message = `\$\{last\.message\} \| template/);
});

// Nov 6: SpeakOn x Chris reel 2 sat at 5- Script Approval because reel 1's Script Sent Date (Oct 14) was on the deal
test('scriptSentFor: an earlier reel\'s Script Sent Date does not block the next reel\'s script', async () => {
  const { scriptSentFor } = await import('../lib/heartbeat.js');
  assert.equal(scriptSentFor({ scriptSent: '2026-10-14' }, { created: '2026-11-03T09:40:00Z' }), false);
  assert.equal(scriptSentFor({ scriptSent: '2026-11-05' }, { created: '2026-11-03T09:40:00Z' }), true);
  assert.equal(scriptSentFor({ scriptSent: null }, { created: '2026-11-03T09:40:00Z' }), false);
  assert.equal(scriptSentFor({ scriptSent: '2026-10-14' }, {}), true, 'no card date: keep the old guard');
});

// Nov 6 afternoon: debug_token gave no WABA, so ensureTemplate could never see or create pm_needs_you (132001 all day)
test('findWabas: falls back to the businesses the token belongs to when debug_token has no WhatsApp scopes', async () => {
  const W = await import('../lib/whatsapp.js');
  const replies = {
    debug_token: { data: { granular_scopes: [{ scope: 'business_management', target_ids: ['9'] }] } },
    'me/businesses': { data: [{ id: 'B1' }] },
    'B1/owned_whatsapp_business_accounts': { data: [{ id: 'W1' }] },
    'B1/client_whatsapp_business_accounts': { data: [{ id: 'W2' }, { id: 'W1' }] },
  };
  const fake = async (url) => { const path = url.split('/v23.0/')[1].split('?')[0]; return { json: async () => replies[path] || {} }; };
  assert.deepEqual(await W.findWabas(fake, 'v23.0', 't'), ['W1', 'W2']);
  const direct = async (url) => ({ json: async () => (url.includes('debug_token') ? { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['W7'] }] } } : {}) });
  assert.deepEqual(await W.findWabas(direct, 'v23.0', 't'), ['W7']);
});

// Nov 6 afternoon: Zeely's chase quoted our own Stripe default due date ("on track for payment by November 6th")
test('dueDateForBrand: a due date reaches a brand email only when the deal terms name one', async () => {
  const { dueDateForBrand } = await import('../lib/heartbeat.js');
  assert.equal(dueDateForBrand({ invoiceDue: '2026-11-06', paymentTerms: '' }), null);
  assert.equal(dueDateForBrand({ invoiceDue: '2026-11-06', paymentTerms: '50% remaining balance due upon confirmation' }), null);
  assert.equal(dueDateForBrand({ invoiceDue: '2026-12-03', paymentTerms: 'Net 30' }), '2026-12-03');
  assert.equal(dueDateForBrand({ invoiceDue: null, paymentTerms: 'Net 30' }), null);
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8'), /Never name a due date or a payment date/);
});

test('a rate ask on a finished deal opens its own inquiry, whatever the event (Migoo x Brad, Nov 6)', async () => {
  const { finishedDealInquiry } = await import('../lib/inbox.js');
  const deals = [{ brand: 'Migoo', creator: 'Brad', threadId: 'm1', stage: 'Paid' }, { brand: 'Kylon', creator: 'Lindsay', threadId: 'k1', stage: 'Script Sent' }];
  const migoo = { threadId: 'm1', text: 'The Migoo team will be hosting an offline event from December 7 to 12. Would you be interested in participating? If so, could you please let me know your rate for this session?' };
  assert.ok(finishedDealInquiry(migoo, { event: 'brand_reply', from_role: 'brand' }, deals));
  assert.equal(finishedDealInquiry(migoo, { event: 'brand_reply', from_role: 'noocap' }, deals), null);
  assert.equal(finishedDealInquiry({ threadId: 'm1', text: 'Thanks, payment went through.' }, { event: 'brand_reply', from_role: 'brand' }, deals), null);
  assert.equal(finishedDealInquiry({ threadId: 'k1', text: 'What is your rate for a second reel?' }, { event: 'brand_reply', from_role: 'brand' }, deals), null);
});

// Nov 8: an invite to the next campaign in a finished deal's thread opens its own deal (Dreamina x Chris)
test('inbox: a new-campaign invite on an invoiced deal is a new inquiry, payment news is not', async () => {
  const { finishedDealInquiry } = await import('../lib/inbox.js');
  const deals = [{ brand: 'Dreamina', creator: 'Chris', threadId: 'd1', stage: 'Invoiced' }, { brand: 'Kylon', creator: 'Lindsay', threadId: 'k1', stage: 'Script Sent' }];
  const dreamina = { threadId: 'd1', text: "Hi,\n\nThanks for confirming that the required hashtags have been added!\n\nWe expect to complete your payment in around 3-5 days.\n\nWe'd also love to invite you to our latest Dreamina campaign at the same rate as our previous collaboration.\n\nCreative Brief: https://example.com/brief" };
  const r = finishedDealInquiry(dreamina, { event: 'brand_reply', from_role: 'brand' }, deals);
  assert.ok(r && r.invite && r.onThread.brand === 'Dreamina');
  assert.ok(finishedDealInquiry(dreamina, { event: 'brief', from_role: 'brand' }, deals)?.invite, 'an invite read as a brief is still a new deal');
  assert.equal(finishedDealInquiry({ threadId: 'd1', text: 'We expect to complete your payment in around 3-5 days.' }, { event: 'brand_reply', from_role: 'brand' }, deals), null);
  assert.equal(finishedDealInquiry({ threadId: 'k1', text: "We'd love to invite you to our latest campaign." }, { event: 'brand_reply', from_role: 'brand' }, deals), null, 'live deal: not a new inquiry');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(src, /finishedDealInquiry\(email, x, everything\)/, 'Paid deals must be searched too');
});

// Nov 7: a brand that said "sending the script to the client" gets nudged after 3 days, not 7
test('heartbeat: script/video approval waits use the 3-day gap even after a brand holding reply', async () => {
  const fs = await import('node:fs');
  const hb = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(hb, /const holdDays = cardWaits \|\| waitStage === 'Script Sent' \|\| waitStage === 'Submitted' \? 3 : 7;/);
  assert.match(hb, /const SCRIPT_FOLLOW_GAP = 3;/);
  // Nov 17: once agreed, a script, brief or contract the brand owes us is chased until they answer
  assert.match(hb, /const maxChase = cutWait \|\| scriptWait \? Infinity : MAX_FOLLOW_UPS;/);
  assert.match(hb, /const gapNow = cutWait \|\| scriptWait \? SCRIPT_FOLLOW_GAP : followGap/);
  assert.match(hb, /daysSince\(lastMail\.at\) >= holdDays/);
});

// Nov 7: follow-ups wait for Harsh's approval, and the weekend is US time
test('follow-ups and payment chases send themselves; weekend is New York time', async () => {
  const hb = await import('../lib/heartbeat.js');
  for (const k of ['Follow-up', 'Payment chase']) assert.ok(hb.AUTO_KINDS.includes(k), k);
  const { isWeekend } = await import('../lib/tools.js');
  assert.equal(isWeekend(new Date('2026-11-06T20:30:00Z')), false, 'Sat 2 AM IST is Fri 3:30 PM in New York');
  assert.equal(isWeekend(new Date('2026-11-07T15:00:00Z')), true, 'Saturday in New York');
  assert.equal(isWeekend(new Date('2026-11-09T03:00:00Z')), true, 'Mon 8:30 AM IST is still Sunday night in New York');
});

// Nov 7: a before-due chase retired at the due date must be replaced, not blocked by the 3-day pause
test('heartbeat: past-due replacement chase skips the recently-dropped pause', async () => {
  const fs = await import('node:fs');
  const hb = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(hb, /if \(!args\.replaces\) \{ const \{ recentlyDropped \}/);
  assert.match(hb, /sameAs: 'past-due', replaces: true/);
});

// Nov 7: script approved -> ask the brand for tool access on noocaptools@gmail.com, sent automatically
test('tool-access email after script approval', async () => {
  const ib = await import('../lib/inbox.js');
  const body = ib.toolAccessBody({ firstName: 'Yulia', brand: 'ElevenLabs', creator: 'Duncan' });
  assert.match(body, /^Hi Yulia,/);
  assert.match(body, /access to ElevenLabs on noocaptools@gmail\.com/);
  assert.match(body, /let us know once the access has been given/);
  assert.match(body, /Duncan's Team$/);
  assert.doesNotMatch(body, /<br/i, 'real line breaks, never HTML tags as text (Nov 9 ElevenLabs email)');
  assert.match(body, /^Hi Yulia,\n\n/);
  const hb = await import('../lib/heartbeat.js');
  assert.ok(hb.AUTO_KINDS.includes('Tool access'));
  assert.equal(await ib.askToolAccess({ id: 'x', threadId: '', brand: 'A' }, {}), null, 'no thread, no email');
});

// Nov 7: "Total fee: USD $1,300 ..." reached Rudraksh's channel
test('script writer channel drops fee / total / package amounts but keeps product prices', async () => {
  const { forScriptWriter } = await import('../lib/briefs.js');
  const out = forScriptWriter('✏️ Brief updated: Luma AI × Chris\n• Total fee: USD $1,300 for Instagram Reel and Story package\n• Deliverables confirmed: Reel, Story, Comment-to-DM automation\n• Plans start from $25 a month');
  assert.doesNotMatch(out, /1,300/);
  assert.match(out, /Deliverables confirmed/);
  assert.doesNotMatch(out, /\$25/, 'no amount of any kind reaches the script writer channel');
});

test('script writer channel: no amount or money word in any phrasing', async () => {
  const { forScriptWriter } = await import('../lib/briefs.js');
  const lines = ['• Budget is 2k USD', '• They will pay USD 900', '• Deal worth €1.200', '• Fee locked in', '• Invoice after posting', '• 50% upfront', '• Rate: 1,300 dollars', '• Brand wants a demo of the Notes feature'];
  const out = forScriptWriter('✏️ Brief updated: X × Chris ($1,300)\n' + lines.join('\n'));
  assert.equal(out, '✏️ Brief updated: X × Chris ()\n• Brand wants a demo of the Notes feature');
});

test('cards never get contract or invoice files', async () => {
  const { cardFiles } = await import('../lib/briefs.js');
  const out = cardFiles([{ filename: 'NJ_Agency_x_Chris_Cordero_Luma_Partnership_Agreement.pdf' }, { filename: 'Luma_Brief.pdf' }, { filename: 'INV-003.pdf' }]);
  assert.deepEqual(out.map((a) => a.filename), ['Luma_Brief.pdf']);
});

test('ElevenLabs: "move forward with the video draft, don\'t publish yet" is script approved plus a posting hold, never script changes or a work hold', async () => {
  const { applyTextGuards, goAheadToVideo, postingOnlyHold } = await import('../lib/inbox.js');
  const mail = `Hi Duncan and team,\n\nThank you so much for following up!\n\nDuncan's script has been reviewed. I converted it into a Google Doc so the ElevenLabs team could leave their feedback directly in the document. There is one small note there that I'd like you to keep in mind when creating the video draft:\n\nhttps://docs.google.com/document/d/abc/edit\n\nYou can now move forward with the video draft. However, I wanted to let you know that Huedini hasn't officially launched yet, and it looks like the launch may be slightly delayed. This could also affect the November 13 posting date you mentioned, so please don't publish the video without checking with me first.\n\nThe ElevenLabs team is expected to provide early access to creators working on the Huedini brief. I'd recommend not rushing the video production.\n\nThat said, it's completely up to you. If you'd prefer to start working on the video now, you're welcome to do so.`;
  assert.equal(goAheadToVideo(mail), true);
  assert.equal(postingOnlyHold(mail), true);
  const x = applyTextGuards({ event: 'script_changes', from_role: 'brand', feedback: 'One small note in the linked Google Doc at https://docs.google.com/document/d/abc/edit', on_hold: true, hold_reason: 'Huedini launch delayed' }, { text: mail });
  assert.equal(x.event, 'script_approved');
  assert.equal(x.on_hold, false);
  assert.match(x.posting_hold, /Huedini/);
  assert.match(x.filming_notes, /docs\.google/);
  // A real work pause stays a hold, and comments to apply before filming stay script changes
  assert.equal(postingOnlyHold('Please pause the scripting for now, we are waiting for legal.'), false);
  assert.equal(goAheadToVideo('Please start filming once you have applied the comments in the doc.'), false);
});

test('Joylo x Chris: follow-ups recorded in the deal memory count toward the limit (counter said 3, history had 8)', async () => {
  const { memoryFollowUps } = await import('../lib/briefs.js');
  const mem = 'AGREED: 1400 rate.<br /><br />HISTORY: 2026-09-30 us / brief filed and deal created. 2026-10-01 us / script sent. 2026-10-03 us / follow-up. 2026-10-05 us / follow-up. 2026-10-07 us / follow-up. 2026-10-12 us / follow-up. 2026-10-20 us / follow-up. 2026-10-22 us / follow-up. 2026-10-29 us / follow-up requesting urgent approval. 2026-11-02 us / follow-up demanding response.<br /><br />BILLING: not yet<br /><br />OPEN NOW: no follow-up from brand.';
  assert.equal(memoryFollowUps(mem, '2026-09-29T20:53:00.000Z'), 8);
  // Only those after the brand's last reply count
  assert.equal(memoryFollowUps(mem, '2026-10-21T00:00:00.000Z'), 3);
  // "2026-11-07 us followed up on script review status" style also counts; brand lines never do
  assert.equal(memoryFollowUps('HISTORY:\n2026-11-03 us sent script PDF.\n2026-11-07 us followed up on script review status.\n2026-11-08 brand followed up.', '2026-11-03T01:12:00Z'), 1);
  assert.equal(memoryFollowUps('', null), 0);
});

// System check Nov 8 night: Chris's team pasted the CapCut script into Mia's thread ("Here's the script draft: ...").
// The reader filed it as a promise to send the script, so the deal kept "Send CapCut the script" with no Script Sent Date.
test('a script our side pastes into the thread is the script delivered, not a promise', async () => {
  const { scriptPromiseKept, handsOverScript } = await import('../lib/inbox.js');
  const pasted = "Hey,\n\nHere's the script draft:\n\n*Hook:*\n\n*This dog has never worn this bandana...*";
  const r = scriptPromiseKept(['script'], 'creator', pasted);
  assert.equal(r.handed, true);
  assert.deepEqual(r.promised, []);
  // Talking about the script is still a promise
  const later = scriptPromiseKept(['script'], 'creator', "We're working on the script and will share it soon.");
  assert.equal(later.handed, false);
  assert.deepEqual(later.promised, ['script']);
  // The brand writing "here's the script" is never our delivery
  assert.equal(scriptPromiseKept(['script'], 'brand', pasted).handed, false);
  assert.equal(handsOverScript('Script attached for your review.'), true);
  assert.equal(handsOverScript('When can you expect the script?'), false);
});

// System check Nov 9 morning: Cherish (NoxInfluencer) wrote three times in Lindsay's inbox that she had not seen the
// Hyper3D script and wants it sent to the client. Another Gmail thread id than the deal's, and the lead was linked to
// Lindsay's other Tripo deal by name, so the Hyper3D deal kept "waiting for the brand" and nobody answered.
test('a brand email in the creator inbox finds its deal by the brand contact, not by name', async () => {
  const { dealByContact } = await import('../lib/leads.js');
  const deals = [
    { id: 'tripo', brand: 'Tripo 3D', creator: 'Lindsay', stage: 'Script Sent', brandEmail: 'rajeshwari@jeevmedia.net', threadId: '1a0c' },
    { id: 'hyper', brand: 'Hyper3D', creator: 'Lindsay', stage: 'Script Sent', brandEmail: 'cherish@mcn.noxinfluencer.com', threadId: '1a16' },
    { id: 'old', brand: 'Hyper3D', creator: 'Valeri', stage: 'Script Sent', brandEmail: 'cherish@mcn.noxinfluencer.com' },
  ];
  assert.equal(dealByContact(deals, 'NoxInfluencer <Cherish@mcn.noxinfluencer.com>', 'Lindsay')?.id, 'hyper');
  assert.equal(dealByContact(deals, 'someone@else.com', 'Lindsay'), null);
  assert.equal(dealByContact(deals, 'cherish@mcn.noxinfluencer.com', 'Valeri')?.id, 'old');
  // Paid or Lost deals are not reopened this way
  assert.equal(dealByContact([{ ...deals[1], stage: 'Paid' }], 'cherish@mcn.noxinfluencer.com', 'Lindsay'), null);
});

test('an agency contact pitching another product on a new thread is not a reply on the old deal (OiiOii / Framia Pro x Chris, Nov 15)', async () => {
  const { dealByContact } = await import('../lib/leads.js');
  const deals = [{ id: 'oiioii', brand: 'OiiOii', creator: 'Chris', stage: 'Price Agreed', brandEmail: 'vera@luminarysm.com', threadSubject: 'Exploring a Potential Collaboration with OiiOii' }];
  assert.equal(dealByContact(deals, '"Vera Vera" <vera@luminarysm.com>', 'Chris', 'Re: Instagram Partnership Opportunity – Framia Pro'), null);
  assert.equal(dealByContact(deals, 'vera@luminarysm.com', 'Chris', 'Re: Exploring a Potential Collaboration with OiiOii')?.id, 'oiioii');
  assert.equal(dealByContact(deals, 'vera@luminarysm.com', 'Chris', 'OiiOii contract and brief')?.id, 'oiioii');
  assert.equal(dealByContact(deals, 'vera@luminarysm.com', 'Chris', 'Quick question')?.id, 'oiioii');
  assert.equal(dealByContact(deals, 'vera@luminarysm.com', 'Chris')?.id, 'oiioii');
});

test('a WhatsApp message naming another creator is not the answer to this creator\'s brand question (ElevenLabs x Duncan, Nov 9)', async () => {
  const { infoAskFor, namesOtherCreator } = await import('../api/whatsapp.js');
  const at = new Date().toISOString();
  const ask = { role: 'assistant', meta: 'info-ask', at, content: '🙋 ElevenLabs × Duncan is asking for: post status', infoAsk: { brand: 'ElevenLabs', creator: 'Duncan', dealId: 'd1', need: 'post status' } };
  const st = { messages: [ask] };
  assert.equal(namesOtherCreator('Chris X Elevenlabs brand deal', 'Duncan'), true);
  assert.equal(namesOtherCreator('elevenlabs duncan post is live', 'Duncan'), false);
  assert.equal(namesOtherCreator('elevenlabs post is live', 'Duncan'), false);
  assert.equal(namesOtherCreator('valerie polar link', 'Valeri'), false);
  assert.equal(infoAskFor(st, null, "Chris X Elevenlabs brand deal it's a UGC deal no rate just add a new card in the dashboard"), null);
  assert.equal(infoAskFor(st, null, 'Elevenlabs: the reel is live, here are the insights'), ask);
  // A swipe-reply straight onto the question still answers it
  assert.equal(infoAskFor(st, ask, 'Chris checked it, it is live'), ask);
});

test('a WhatsApp "Lindsay X Higgsfield" note is not the answer to the Tripo 3D × Lindsay ask (system check, Nov 18)', async () => {
  const { infoAskFor, labelNamesOtherBrand: namesOtherBrand } = await import('../api/whatsapp.js');
  const at = new Date(Date.now() - 96 * 60e3).toISOString();
  const ask = { role: 'assistant', meta: 'info-ask', at, content: "🙋 Tripo 3D × Lindsay is asking for: Lindsay's registered Tripo account email ID", infoAsk: { brand: 'Tripo 3D', creator: 'Lindsay', dealId: 't1', need: 'account email' } };
  const st = { messages: [ask] };
  const text = 'https://higgsfield-ai.notion.site/astra-6-2-x-higgsfield-game-vi\nLindsay X Higgsfield';
  assert.equal(namesOtherBrand(text, 'Tripo 3D'), true);
  assert.equal(infoAskFor(st, null, text), null);
  assert.equal(namesOtherBrand('Lindsay x Tripo 3D: lindsay@example.com', 'Tripo 3D'), false);
  assert.equal(namesOtherBrand('lindsay@example.com', 'Tripo 3D'), false);
  assert.equal(infoAskFor(st, null, 'lindsay@example.com'), ask);
  // A swipe-reply straight onto the question still answers it
  assert.equal(infoAskFor(st, ask, text), ask);
});

test('no follow-up to the brand while we owe the revised cut (CapCut x Chris, Nov 9)', async () => {
  const fs = await import('node:fs');
  const { ourMoveText } = await import('../lib/heartbeat.js');
  assert.equal(ourMoveText("Editor making the brand's changes", 'Chris'), true);
  assert.equal(ourMoveText('Brad reshooting the video with original footage', 'Chris'), true);
  assert.equal(ourMoveText('Waiting for the brand to review the revised cut', 'Chris'), false);
  const hb = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(hb, /changesAfterCut\(await findIntakeRows\(deal\)[^\n]*\n\s*const ourMove = changesOpen \|\|/);
  const { changesAfterCut } = await import('../lib/heartbeat.js');
  assert.equal(changesAfterCut([{ status: 'Changes', changesAt: '2026-11-09T10:00:00Z' }], '2026-11-08T10:00:00Z'), true);
});

test('posting hold: the brand clearing it, and the once-only markers', async () => {
  const { postingCleared } = await import('../lib/inbox.js');
  const { holdMarkers } = await import('../lib/heartbeat.js');
  assert.equal(postingCleared('Huedini has officially launched, so you can go ahead and publish the video.'), true);
  assert.equal(postingCleared('Feel free to post it on the 13th.'), true);
  assert.equal(postingCleared('We are good to go live tomorrow.'), true);
  assert.equal(postingCleared("Please don't publish the video without checking with me first."), false);
  assert.equal(postingCleared('Thanks, we will review the cut and get back to you.'), false);
  assert.deepEqual(holdMarkers('Huedini launch [warned 10] [checked in]'), { warned: [10], checkedIn: true });
  assert.deepEqual(holdMarkers('Huedini launch'), { warned: [], checkedIn: false });
});

test('loose ends: cards without deals, deals without cards, missing dates, amount mismatches', async () => {
  const { findLooseEnds, looseEndsText } = await import('../lib/looseends.js');
  const id = (n) => `${'a'.repeat(31)}${n}`;
  const videos = [
    { id: id(1), creator: 'Chris', title: 'TRIPO', status: '4- Script Draft', sponsor: true, post_date: null },
    { id: id(2), creator: 'Duncan', title: 'ElevenLabs', status: '6- To Film', sponsor: true, post_date: '2026-11-19' },
    { id: id(3), creator: 'Lindsay', title: 'Personal', status: '6- To Film', sponsor: false, post_date: null },
    { id: id(4), creator: 'Chris', title: 'Old', status: '12- Posted', sponsor: true, post_date: null },
  ];
  const deals = [
    { brand: 'ElevenLabs', creator: 'Duncan', stage: 'Script Approved', linkedVideo: `https://app.notion.com/p/x-${id(2)}`, finalRate: 1000, deliverables: '1 short video' },
    { brand: 'Luma', creator: 'Chris', stage: 'Brief Received', linkedVideo: '' },
    { brand: 'Softr', creator: 'Lindsay', stage: 'Invoiced', invoiceDue: null },
  ];
  const revenue = [{ 'Video Link': `https://app.notion.com/p/${id(2)}`, 'Amount USD': 2000 }];
  const l = findLooseEnds({ videos, deals, revenue });
  assert.deepEqual(l.cardsNoDeal.map((v) => v.title), ['TRIPO']);
  assert.deepEqual(l.cardsNoDate.map((v) => v.title), ['TRIPO']);
  assert.deepEqual(l.dealsNoCard.map((d) => d.brand), ['Luma']);
  assert.deepEqual(l.invoicedNoDue.map((d) => d.brand), ['Softr']);
  assert.equal(l.mismatch.length, 1);
  assert.ok(looseEndsText(l).join('\n').includes('deal $1000, revenue row $2000'));
});

test('#pm-alerts: updates that need nothing are batched, needs-you alerts post at once', async () => {
  const { isFyi, headlineOf } = await import('../lib/briefs.js');
  assert.equal(isFyi('🎉 **Zeely × Duncan · video approved**\n• Video Intake set to To Post'), true);
  assert.equal(isFyi('✅ **ElevenLabs × Duncan · brand cleared the video for posting**'), true);
  assert.equal(isFyi('📅 **ElevenLabs × Duncan · posting waits for the brand**'), true);
  assert.equal(isFyi('🙋 **Over to you: Kylon × Lindsay**\nNo reply after 3 follow-ups'), false);
  assert.equal(isFyi('⛔ **Don\'t post yet: ElevenLabs × Duncan**'), false);
  assert.equal(isFyi('📝 **Script ready: Teamily × Lindsay**\n• Send it to the brand from the email thread'), false);
  assert.equal(isFyi('📎 **Atoms × Lindsay · still to send**'), false);
  assert.equal(isFyi('🧾 **Luma × Brad · sponsor video posted**\n• Ask Brad to send their invoice'), false);
  assert.equal(isFyi('🟡 **Loose ends today (4)**'), false);
  assert.equal(headlineOf('🎉 **Zeely × Duncan · video approved**\n• x'), '🎉 Zeely × Duncan · video approved');
});

test('brand pool: a campaign record per deal we ran with the brand', async () => {
  const { campaignLine, buildPool, poolProps } = await import('../lib/brandpool.js');
  const line = campaignLine({ brand: 'Softr', creator: 'Lindsay', stage: 'Paid', rate: 1500, deliverables: '1 YouTube video', postedLinks: 'https://youtu.be/abc', paidDate: '2026-11-30', invoiceDue: '2026-11-27', threadId: '1a0917c035225859', started: '2026-09-11' });
  assert.equal(line, 'Sep 2026 · Lindsay · Softr · $1,500 · 1 YouTube video · posted https://youtu.be/abc · paid 3 days late · thread https://mail.google.com/mail/u/?authuser=noocapcollab@gmail.com#all/1a0917c035225859');
  assert.match(campaignLine({ brand: 'ElevenLabs', creator: 'Duncan', stage: 'Script Approved', started: '2026-10-30' }), /Oct 2026 · Duncan · ElevenLabs · in progress \(script approved\)/);
  const pool = buildPool([{ email: 'kat@softr.io', brand: 'Softr', creator: 'Lindsay', budget: 1500, date: '2026-11-06', booked: true, campaign: { brand: 'Softr', creator: 'Lindsay', stage: 'Invoiced', rate: 1500, invoiceDue: '2026-11-27', started: '2026-09-11' } }]);
  const props = poolProps(pool.get('softr.io'));
  assert.match(props.Campaigns.rich_text[0].text.content, /Sep 2026 · Lindsay · Softr · \$1,500 · invoiced, not paid yet \(due 27 Nov 2026\)/);
});

test('WhatsApp: an ask for more videos is not script feedback (Higgsfield × Lindsay, Nov 9)', async () => {
  const { moreVideosAsk } = await import('../api/whatsapp.js');
  assert.equal(moreVideosAsk("I am telling you to add 4 more video of Higgsfield\n1. Today's Video (November 9) – Fable 5.2 x Higgsfield: Free Unlimited V1 Announcement\nBrief: https://higgsfield-ai.notion.site/x\nhere's breif for two"), true);
  assert.equal(moreVideosAsk("Here's the brief for two https://higgsfield-ai.notion.site/y"), true);
  assert.equal(moreVideosAsk('add two new cards for Chris'), true);
  assert.equal(moreVideosAsk('Brand feedback on the script: add a line about the free trial, everything else is good'), false);
  assert.equal(moreVideosAsk('instead of saying fast, say instant'), false);
});

test('WhatsApp: a dated list of brand videos counts as more videos (Lindsay × Higgsfield, Nov 9)', async () => {
  const { moreVideosAsk } = await import('../api/whatsapp.js');
  const msg = "The brand requires three videos on the following dates:\n\n1.⁠ ⁠Today's Video (November 9) – Fable 5.2 x Higgsfield: Free Unlimited V1 Announcement\n\nBrief: https://higgsfield-ai.notion.site/a\n\n2.⁠ ⁠Tomorrow's Video (November 10) – Fable 5.2 x Higgsfield: Free Unlimited V2 Racing Game\n\nBrief: https://higgsfield-ai.notion.site/b\n\n3.⁠ ⁠November 11 Video\nThe brand will share this brief later.";
  assert.equal(moreVideosAsk(msg), true);
  assert.equal(moreVideosAsk('This Lindsay x Higgfield we have total 4 video deals'), true);
});

test('Valeri invoices: own numbering from 10000000016 and her VAT number (Nov 9)', async () => {
  const { nextNumberFor, sellerVat } = await import('../lib/invoicing.js');
  assert.equal(nextNumberFor('Valeri', []), '10000000016');
  assert.equal(nextNumberFor('Valeri', ['INV-003', '10000000016']), '10000000017');
  assert.equal(nextNumberFor('Valeri', ['10000000016, 10000000018']), '10000000019');
  assert.equal(nextNumberFor('Duncan', ['INV-004']), 'INV-005');
  assert.equal(sellerVat('VAT number: BG208339346'), 'BG208339346');
  assert.equal(sellerVat('VAT ID: none (US company)'), '');
});

test('Brand Email on cards: brand contacts only, no creator team or NOOCAP (Nov 9)', async () => {
  const { brandContacts } = await import('../lib/brandemails.js');
  assert.equal(brandContacts({ brandEmail: 'higgsfield.ai@jeevmedia.net', threadCc: 'collab@automateaiconsulting.com, ops@jeevmedia.net, noocapcollab@gmail.com' }), 'higgsfield.ai@jeevmedia.net, ops@jeevmedia.net');
  assert.equal(brandContacts({ brandEmail: 'mia@gmail.com', threadCc: 'tom@gmail.com' }), 'mia@gmail.com');
  assert.equal(brandContacts({ channel: 'WhatsApp' }), 'Brand handled on WhatsApp (no email)');
  assert.equal(brandContacts({}), '');
});

test('a follow-up waits from the cut we just sent, not an older Last Our Reply (Readdy x Lindsay, Nov 9)', async () => {
  const { latestOurEmail } = await import('../lib/heartbeat.js');
  const deal = { lastOur: '2026-11-05T09:00:00.000Z', lastBrand: '2026-11-05T08:57:00.000Z' };
  assert.equal(latestOurEmail(deal, '2026-11-09T17:44:00.000Z'), '2026-11-09T17:44:00.000Z');
  assert.equal(latestOurEmail(deal, null), '2026-11-05T09:00:00.000Z');
  assert.equal(latestOurEmail({ lastOur: '2026-11-10T10:00:00.000Z' }, '2026-11-09T17:44:00.000Z'), '2026-11-10T10:00:00.000Z');
});

test('a WhatsApp answer that can only promise the thing later writes no draft (CapCut x Chris, Nov 9)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function answerInfoAsk'), src.indexOf('async function showDrafts'));
  assert.ok(fn.indexOf('promises to send something later') > -1 && fn.indexOf('promises to send something later') < fn.indexOf('createDraft({'));
  const { checkDraft } = await import('../lib/outbox.js');
  const { issues } = checkDraft({ body: "We're setting up the Dreamina account now and will send over both UIDs right away so we can get filming started." });
  assert.ok(issues.some((i) => /promises to send something later/.test(i)));
});

test('Loose ends: two tracker rows for one video are caught, the real one kept (FLOVA, Nov 7)', async () => {
  const { duplicateTrackerRows } = await import('../lib/looseends.js');
  const d = duplicateTrackerRows([
    { title: 'FLOVA', videoId: '400508e99dda8087b03bc9928f372949', frame: 'https://f.io/L5D4BsWC', created: '2026-10-28' },
    { title: 'FLOVA × Duncan', videoId: '400508e9-9dda-8087-b03b-c9928f372949', frame: '', created: '2026-11-07' },
    { title: 'Other', videoId: 'abc', frame: '', created: '2026-11-01' },
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].extra.title, 'FLOVA × Duncan');
  assert.equal(d[0].keep.title, 'FLOVA');
});

// ---------- system check, Nov 10 ----------
test("Brad's own inbox (ninjaaitools.com) is our side, never the brand's address (PromoCut, Teamily AI, Nov 10)", async () => {
  const { oursAddr } = await import('../lib/outbox.js');
  const { ourSide } = await import('../lib/contacts.js');
  assert.equal(oursAddr('partnerships@ninjaaitools.com'), true);
  assert.equal(ourSide('partnerships@ninjaaitools.com'), true);
  assert.equal(oursAddr('alyssa@withwidely.com'), false);
});

test('an outside company the reader calls "noocap" is the brand side (Nicole at Quil Media, PromoCut, Nov 10)', async () => {
  const { sideOf } = await import('../lib/inbox.js');
  assert.equal(sideOf('Nicole <nicole@quilmedia.com>', 'noocap'), 'brand');
  assert.equal(sideOf('noocap collab <noocapcollab@gmail.com>', 'noocap'), 'noocap');
  assert.equal(sideOf('Brad <partnerships@ninjaaitools.com>', 'noocap'), 'noocap');
  assert.equal(sideOf('someone@gmail.com', 'noocap'), 'noocap');
  assert.equal(sideOf('Nicole <nicole@quilmedia.com>', 'brand'), 'brand');
});

test("the PM's own auto-sent email only retires waiting drafts of its kind (Gamut tool access vs Iddo's date question, Nov 10)", async () => {
  const { retiredByOurEmail } = await import('../lib/inbox.js');
  assert.equal(retiredByOurEmail('Reply', 'Tool access'), false);
  assert.equal(retiredByOurEmail('Tool access', 'Tool access'), true);
  assert.equal(retiredByOurEmail('Reply', null), true); // a hand-written email answers whatever was waiting
});

test('Replies quote the earlier emails underneath (Readdy in PrivateEmail, Nov 10)', async () => {
  const { quoteHistory } = await import('../lib/outbox.js');
  const q = quoteHistory(['📨 2026-11-03 · us (NOOCAP) · Re: x\nThe script PDF is attached.', '📨 2026-11-05 · brand (Harper Collins <harper@readdy.ai>) · Re: x\nThanks for the update!'], { ours: "Lindsay's Team" });
  assert.match(q.text, /On 2026-11-05, Harper Collins <harper@readdy.ai> wrote:\n> Thanks for the update!/);
  assert.match(q.text, /On 2026-11-03, Lindsay's Team wrote:/);
  assert.ok(q.text.indexOf('2026-11-05') < q.text.indexOf('2026-11-03'));
  assert.equal(quoteHistory([]), null);
});

test('a revised cut email is the revised cut, never a promise of one or a billing ask (Polar x Valeri, Nov 10)', async () => {
  const { cutBodyProblems, plainCutBody, cutInstructions } = await import('../lib/brandsend.js');
  const sent = "Hi Ushni,<br /><br />Thanks so much! We can absolutely swap the music to something more casual or pull it out entirely, and we'll get you the revised cut for a final check before we post. <br /><br />To close out invoicing on both videos, we'll need your company name, billing address, and billing email.<br /><br />Best,<br />Valeri's Team";
  assert.equal(cutBodyProblems(sent, true).length, 2);
  assert.deepEqual(cutBodyProblems("Hi Ushni,\n\nHere is the revised cut with more casual music: https://f.io/x\n\nBest,\nValeri's Team", true), []);
  const plainBody = plainCutBody(sent, 'https://f.io/6CLu_W2h', 'Valeri', true);
  assert.equal(plainBody, "Hi Ushni,\n\nHere is the revised cut with the changes you asked for: https://f.io/6CLu_W2h\n\nBest,\nValeri's Team");
  assert.deepEqual(cutBodyProblems(plainBody, true), []);
  assert.match(cutInstructions('', true), /revised cut that already makes the changes/);
  assert.match(cutInstructions('', false), /repeat that answer in one short sentence/);
});

test('a WhatsApp push failure is logged at most once per 6 hours per person, across cold starts (Nov 10)', async () => {
  const { recentFailFilter } = await import('../lib/whatsapp.js');
  const now = Date.parse('2026-11-10T06:06:00Z');
  const f = recentFailFilter('Pratham', now);
  assert.equal(f.and[0].title.equals, 'WhatsApp alert to Pratham failed');
  assert.equal(f.and[1].created_time.after, '2026-11-10T00:06:00.000Z');
});

// Nov 10: the full stop after a Frame.io link became part of the link, and old <br /> text showed in the quote
test('links stop before sentence punctuation; quoted history has real line breaks', async () => {
  const o = await import('../lib/outbox.js');
  assert.equal(o.linkify('cut: https://f.io/bTfgtvKC. Thanks'), 'cut: <a href="https://f.io/bTfgtvKC">https://f.io/bTfgtvKC</a>. Thanks');
  assert.equal(o.linkify('(https://a.com/x?y=1)'), '(<a href="https://a.com/x?y=1">https://a.com/x?y=1</a>)');
  const q = o.quoteHistory(['📨 2026-11-09 · us (NOOCAP) · Re: x\nHi Yulia,<br /><br />Checking in.<br />Best']);
  assert.doesNotMatch(q.text + q.html, /&lt;br|<br \/>/);
  assert.match(q.text, /> Hi Yulia,\n> \n> Checking in\./);
});

// Nov 10: Mia (CapCut) answered our access email with UID steps; they go to the editor, never with money in them
test('tool access replies are spotted and made editor-safe', async () => {
  const T = await import('../lib/toolaccess.js');
  const mia = 'Okay, please share your CapCut UID with me. Also, since your brief is for Dreamina, you need to download and register a Dreamina account and send over your Dreamina UID.\nHow to get your Dreamina UID:\n1. Log in to the Dreamina official website: https://dreamina.capcut.com/\nThe fee of $1,500 is paid after posting.';
  assert.ok(T.isAccessReply(mia));
  assert.ok(!T.isAccessReply('Hi, are you running into any difficulties? I am happy to help.'));
  const safe = T.editorSafe(mia);
  assert.ok(safe.some((l) => /Dreamina UID/.test(l)));
  assert.ok(!safe.some((l) => /\$|fee|paid/i.test(l)), 'no money for editors');
  const msg = T.editorMessage({ brand: 'CapCut', creator: 'Chris', title: 'CapCut × Chris', cardUrl: 'https://notion.so/x', lines: safe, at: '123456789012345678' });
  assert.match(msg, /<@123456789012345678>/);
  assert.match(msg, /For the brand/);
});

// System check Nov 10: Luma AI x Chris approved the script only in Chris's inbox; the deal stayed at Script Sent
test('creator-inbox email: an explicit script approval is recognised, questions and change notes are not', async () => {
  const { scriptApprovedIn } = await import('../lib/leads.js');
  assert.equal(scriptApprovedIn('Hi Team Chris, Good news! Your script has been approved by the Luma team. The next step is to create your account on Luma.'), true);
  assert.equal(scriptApprovedIn('We approved the script, go ahead and film.'), true);
  assert.equal(scriptApprovedIn('Has the script been approved by your team yet?'), false);
  assert.equal(scriptApprovedIn('The script is approved with a few changes to the hook, see feedback below.'), false);
  assert.equal(scriptApprovedIn('Please send the script once it is approved internally.'), false);
});

// Nov 10: one check before every send, built from the mistakes that reached brands
test('preflight puts thread, subject, CC and body right, or holds the email', async () => {
  const { preflight, cleanBody } = await import('../lib/preflight.js');
  const deal = { threadId: '1a19ac2c52e4e0b9', messageRfc: '<brand@creator.co>', threadCc: 'collab@chriscordero.net', threadSubject: 'Re: Following Up: Bluehost AI', creator: 'Chris' };
  // a follow-up made in a stray thread, with no CC and HTML in the text
  const r = preflight({ kind: 'Follow-up', to: 'smahi@creator.co', cc: '', subject: 'Bluehost × Chris - contract and brief', body: 'Hi Smahi,<br /><br />Just checking in on **the invite**.<br />Best,<br />Chris\'s Team', threadId: '19aaaaaaaaaaaaaa', replyTo: '' }, deal);
  assert.equal(r.hold.length, 0);
  assert.equal(r.draft.threadId, deal.threadId);
  assert.equal(r.draft.replyTo, deal.messageRfc);
  assert.equal(r.draft.subject, 'Re: Following Up: Bluehost AI');
  assert.match(r.draft.cc, /collab@chriscordero\.net/);
  assert.doesNotMatch(r.draft.body, /<br|\*\*/);
  // no brand thread at all: held, never a new email
  const h = preflight({ kind: 'Follow-up', to: 'x@brand.com', subject: 'Hi', body: 'Hi there, just checking in on the brief for this video.' }, { creator: 'Chris' });
  assert.match(h.hold.join(' '), /no email thread/);
  // placeholders and empty emails are held
  assert.match(preflight({ kind: 'Reply', to: 'x@brand.com', replyTo: '<a@b.c>', subject: 'Re: x', body: 'Hi [Name], here is the link: {{link}} for the video.' }, null).hold.join(' '), /still has/);
  // a Reply to a second brand thread keeps its own thread and subject
  const rep = preflight({ kind: 'Reply', to: 'erick@creator.co', replyTo: '<erick@creator.co>', threadId: '19bbbbbbbbbbbbbb', subject: 'Re: Bluehost AI | Paid Creator Collaboration', body: 'Hi Erick, thanks for the new invite, Chris will opt in today.' }, deal);
  assert.equal(rep.draft.threadId, '19bbbbbbbbbbbbbb');
  assert.equal(rep.draft.subject, 'Re: Bluehost AI | Paid Creator Collaboration');
  assert.equal(cleanBody('See [the cut](https://f.io/x) &amp; reply'), 'See the cut: https://f.io/x & reply');
});

// Nov 10: editors get only the steps (no rep, agency, emails, quoted thread, brand name)
test('tool access steps are instructions only', async () => {
  const T = await import('../lib/toolaccess.js');
  const mia = `Okay, please share your CapCut UID with me. Also, since your brief is for
Dreamina, you need to download and register a Dreamina account and send
over your Dreamina UID. This will help you create the content smoothly.
How to get your Dreamina UID:
1. Log in to the Dreamina official website: https://dreamina.capcut.com/
2. Click your profile avatar at the top right of the page
3. Right-click the avatar, and your UID will be automatically copied to
your clipboard. You will see the pop-up notice "userId copy success" once
copied.
Mia Brown | BD
GrowMaxValue Agency
📧mia.brown@growmaxvalue.com
On Mon, Nov 9, 2026 at 10:27 PM noocap collab <noocapcollab@gmail.com>
wrote:
> Hi Mia, thanks for approving the script`;
  const steps = T.instructionsOnly(mia);
  const all = steps.join('\n');
  assert.doesNotMatch(all, /Mia|GrowMax|@growmaxvalue|noocap collab|wrote:/);
  assert.match(all, /send over your Dreamina UID\./);
  assert.ok(steps.some((l) => /^3\. Right-click the avatar, and your UID will be automatically copied to your clipboard\./.test(l)));
  const msg = T.editorMessage({ brand: 'CapCut', creator: 'Chris', title: 'CapCut × Chris', cardUrl: 'u', lines: steps });
  assert.doesNotMatch(msg, /from CapCut|emails it to/);
});

// Nov 11: Yulia said access was granted and that the video link 404s; only the access part is the editor's
test('only the account part of a brand email goes to the editor', async () => {
  const T = await import('../lib/toolaccess.js');
  const yulia = T.editorSafe(T.instructionsOnly(`Hi team,
Apologies for not getting back to you yesterday. As soon as I received your
message, I contacted the development team to ask them to enable your
access. My understanding is that access has now been granted, which is
great!
I'm having trouble opening your video draft, though. The link gives me a
404 error. Could you please check it and resend the link?
Thank you! I'm looking forward to watching the draft.`).join('\n'));
  const y = T.accessPart(yulia);
  assert.equal(y.steps.length, 0, 'nothing to do in the tool');
  assert.ok(y.granted, 'access granted is noted');
  assert.ok(y.other.some((l) => /404|resend/.test(l)), 'the broken link stays with the PM to answer');
  const mia = T.accessPart(['Okay, please share your CapCut UID with me.', 'How to get your Dreamina UID:', '1. Log in to the Dreamina official website: https://dreamina.capcut.com/']);
  assert.ok(mia.steps.length >= 2);
});

test('preflight holds <UNKNOWN> and tidies mail-merge greetings', async () => {
  const { preflight } = await import('../lib/preflight.js');
  assert.match(preflight({ kind: 'Reply', to: 'a@b.co', replyTo: '<x@y.z>', subject: 'Re: x', body: 'Hi Eva,\n\nWhenever <UNKNOWN> is ready to move forward, just reply here.' }, null).hold.join(' '), /UNKNOWN/);
  assert.match(preflight({ kind: 'Reply', to: 'a@b.co', replyTo: '<x@y.z>', subject: 'Re: x', body: 'Hi williamm,\n\nThanks for the note about the campaign timing.' }, null).draft.body, /^Hi Williamm,/);
  assert.match(preflight({ kind: 'Reply', to: 'a@b.co', replyTo: '<x@y.z>', subject: 'Re: x', body: 'Hi Creator,\n\nThanks for the note about the campaign timing.' }, null).draft.body, /^Hi there,/);
});

test('a second-reader flag holds the draft in team mode too (Dreamina and OiiOii auto-sent while flagged, Nov 10)', async () => {
  const { secondReadHolds } = await import('../lib/outbox.js');
  assert.equal(secondReadHolds('team'), true);
  assert.equal(secondReadHolds('on'), true);
  assert.equal(secondReadHolds('shadow'), false);
  assert.equal(secondReadHolds('off'), false);
});

test('a new-campaign deal with the old deal\'s copied invoice never chases it (Dreamina BD-70, Nov 10)', async () => {
  const { copiedInvoice } = await import('../lib/heartbeat.js');
  const oldDeal = { id: 'a', threadId: 't1', invoiceSent: '2026-11-01', created: '2026-09-28T02:50:35Z', stage: 'Invoiced' };
  const copy = { id: 'b', threadId: 't1', invoiceSent: '2026-11-01', created: '2026-11-08T10:06:01Z', stage: 'Invoiced' };
  assert.equal(copiedInvoice(copy, [oldDeal, copy]), true, 'the newer deal is the copy');
  assert.equal(copiedInvoice(oldDeal, [oldDeal, copy]), false, 'the original deal still chases');
  assert.equal(copiedInvoice({ ...copy, invoiceSent: '2026-11-20' }, [oldDeal, copy]), false, 'its own later invoice is chased');
  assert.equal(copiedInvoice({ ...copy, threadId: 't2' }, [oldDeal, copy]), false);
});

test('the invoice sync never puts an old invoice on a deal opened after it (Dreamina BD-70 kept getting the Oct invoice)', async () => {
  const { invoiceDealFor } = await import('../lib/money.js');
  const newDeal = { id: 'b', created: '2026-11-08T10:06:01Z', stage: 'Price Agreed' };
  const oldDeal = { id: 'a', created: '2026-09-28T02:50:35Z', stage: 'Invoiced', invoiceSent: '2026-11-01' };
  assert.equal(invoiceDealFor([newDeal, oldDeal], '2026-11-01').id, 'a', 'the deal holding the invoice keeps it');
  assert.equal(invoiceDealFor([newDeal, { ...oldDeal, invoiceSent: '' }], '2026-11-01').id, 'a', 'a deal opened later never gets it');
  assert.equal(invoiceDealFor([newDeal], '2026-11-01'), null);
  assert.equal(invoiceDealFor([newDeal], '2026-11-20').id, 'b', 'its own later invoice is fine');
});

// Nov 11: Readdy and ElevenLabs could not open first cuts because a full stop followed the link
test('a link is never followed by a full stop or comma in the email', async () => {
  const { linksAlone, preflight } = await import('../lib/preflight.js');
  assert.equal(linksAlone('The first cut is ready for your review at https://f.io/4z1wDGD5. Please let us know.'), 'The first cut is ready for your review at:\n\nhttps://f.io/4z1wDGD5\n\nPlease let us know.');
  assert.equal(linksAlone("Here's the first cut of the video: https://f.io/bTfgtvKC. Please take a look."), "Here's the first cut of the video:\n\nhttps://f.io/bTfgtvKC\n\nPlease take a look.");
  assert.doesNotMatch(linksAlone('the link https://f.io/6CLu_W2h, once reviewed'), /W2h,/);
  const r = preflight({ kind: 'Draft video', to: 'harper@readdy.ai', replyTo: '<a@b>', subject: 'Re: x', body: 'Hi Harper,\n\nThe first cut is ready at https://f.io/4z1wDGD5. Thanks!\n\nBest,\nLindsay\'s Team' }, null);
  assert.doesNotMatch(r.draft.body, /https:\/\/\S*[.,](\s|$)/);
});

test('a brand saying the link does not open is spotted', async () => {
  const { linkBroken } = await import('../lib/inbox.js');
  assert.ok(linkBroken("Unfortunately, we're unable to open the link on our end, it doesn't seem to load properly for us. Could you please re-share the video link?"));
  assert.ok(linkBroken("I'm having trouble opening your video draft, though. The link gives me a 404 error."));
  assert.ok(!linkBroken('Thanks, the video looks great, approved!'));
  assert.ok(!linkBroken('Please change the music at 0:12 and add the link in the caption.'));
});

// System check Nov 11: "editor replies: Cannot read properties of null (reading 'trim')" every 30 minutes from 62aae1a,
// because plain() gives null for an empty "For the brand" field, so no editor reply was ever picked up
test('editor replies: an empty For the brand field never crashes, and acknowledgements are not details', async () => {
  const T = await import('../lib/toolaccess.js');
  const { plain } = await import('../lib/notion.js');
  assert.equal(plain({ type: 'rich_text', rich_text: [] }), null);
  assert.doesNotThrow(() => String(plain({ type: 'rich_text', rich_text: [] }) || '').trim());
  assert.equal(T.editorReplyText(['ok', 'thanks!']), '');
  assert.equal(T.editorReplyText(['7676360876761269265', 'CapCut UID: 4401089801 Dreamina UID: 7676360876761269265', 'done']), 'CapCut UID: 4401089801 Dreamina UID: 7676360876761269265');
  const src = (await import('node:fs')).readFileSync(new URL('../lib/toolaccess.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /plain\(card\.properties\?\.\[FOR_BRAND\]\)\.trim\(\)/, 'plain() can be null: wrap it before trim');
});

// System check Nov 11: Runway asked in Chris's inbox to rerun the November campaign like for like; it stayed on the Invoiced deal
test('a rerun of the same campaign is a new-campaign invite', async () => {
  const { campaignInviteIn } = await import('../lib/inbox.js');
  assert.ok(campaignInviteIn('Client was really pleased with Chris and wanted to know if we can rerun the same campaign again for November? Like for like (Same deliverables + cost)'));
  assert.ok(campaignInviteIn("We'd love to invite you to our latest Dreamina campaign at the same rate"));
  assert.ok(!campaignInviteIn('Thank you for sharing the invoice. It is in our payment queue, due to be paid 13/11/26'));
  assert.ok(!campaignInviteIn('The campaign went really well, thanks again!'));
  const src = (await import('node:fs')).readFileSync(new URL('../lib/leads.js', import.meta.url), 'utf8');
  assert.match(src, /openCampaignInquiry/, 'the creator-inbox path opens the inquiry too');
});

// System check Nov 11: the inbox read returned we_promised as one string and the whole email failed to file (Runway x Chris)
test('list fields from the inbox reader are always lists', async () => {
  const { normalizeRead } = await import('../lib/inbox.js');
  const x = normalizeRead({ summary: 'one point', we_promised: 'two new scripts', delivers: null });
  assert.deepEqual(x.we_promised, ['two new scripts']);
  assert.deepEqual(x.delivers, []);
  assert.deepEqual(x.summary, ['one point']);
  assert.doesNotThrow(() => x.we_promised.filter(Boolean));
});

// System check Nov 11: a first-draft link drafted from WhatsApp after script approval went out as a Script email (Gamut x Lindsay)
test('a cut link drafted from chat after script approval is a Draft video email', async () => {
  const { chatEmailKind } = await import('../lib/ask.js');
  const body = "Hi,<br /><br />Here's the first draft for your review.<br />https://drive.google.com/drive/folders/1VwU8BOSC7hCocCFOv5jjRWmcuyWISrTf";
  assert.equal(chatEmailKind('Script', 'Script Approved', body), 'Draft video');
  assert.equal(chatEmailKind('Script', 'Brief Received', 'Here is the script: https://docs.google.com/document/d/x'), 'Script');
  assert.equal(chatEmailKind('Invoice', 'Posted', body), 'Invoice');
});

// System check Nov 11: the same draft card reached Pratham twice in a row (Gamut x Lindsay)
test('a draft card is not sent twice within 15 minutes', async () => {
  const { cardedRecently } = await import('../lib/whatsapp.js');
  const now = Date.parse('2026-11-11T14:20:00Z');
  const st = { messages: [{ meta: 'draft', draft: 'abc', at: '2026-11-11T14:15:00Z' }] };
  assert.ok(cardedRecently(st, 'abc', now));
  assert.ok(!cardedRecently(st, 'xyz', now));
  assert.ok(!cardedRecently(st, 'abc', Date.parse('2026-11-11T15:00:00Z')));
});

test('brand wiki groups the same brand under one key', async () => {
  const { brandKey, groupByBrand } = await import('../lib/wiki.js');
  assert.equal(brandKey('Higgsfield.AI'), brandKey('Higgsfield'));
  assert.equal(brandKey('Bluehost 2'), 'bluehost');
  assert.equal(brandKey('Luma AI'), 'luma');
  assert.notEqual(brandKey('CapCut'), brandKey('Dreamina'));
  const g = groupByBrand([{ id: '1', brand: 'Higgsfield.AI', creator: 'Lindsay' }, { id: '2', brand: 'Higgsfield', creator: 'Chris' }, { id: '3', brand: 'Readdy AI', creator: 'Lindsay' }]);
  assert.equal(g.length, 2);
});

test('one-line emails do not rebuild the deal record', async () => {
  const { isTrivial } = await import('../lib/memory.js');
  assert.ok(isTrivial('Thanks! Looking forward to it.'));
  assert.ok(isTrivial('Received, will review shortly.'));
  assert.ok(!isTrivial('Approved! Please send the invoice.'));
  assert.ok(!isTrivial('Here is the link https://f.io/x'));
  assert.ok(!isTrivial('Can we post on the 14th?'));
});

test('Dreamina x Chris / AI Inspo x Duncan, Nov 12: a brand describing the script review still to come is not script approved', async () => {
  const { applyTextGuards, goAheadToVideo } = await import('../lib/inbox.js');
  const jenny = 'Hi,\nThank you for your update. I fully understand that you will submit the\nscript for review and start video production upon our approval.\n\nHowever, our timeline is extremely tight at this moment. We must receive\nboth the script and UID today to keep the whole project on track.';
  const inspo = 'STEP-BY-STEP Collaboration Guide\n\n3.Script Preparation\n\nPlease write the script based on the production guide and materials we\nprovide.\n\n4.Script Approval\n\nPlease send us the script for review.\n\n5.Filming & Editing\n\nPlease proceed with filming and editing according to the approved script\nand production guide.';
  assert.equal(goAheadToVideo(jenny), false);
  assert.equal(goAheadToVideo(inspo), false);
  assert.equal(applyTextGuards({ event: 'brand_reply', from_role: 'brand' }, { text: jenny }).event, 'brand_reply');
  assert.equal(applyTextGuards({ event: 'brand_reply', from_role: 'brand' }, { text: inspo }).event, 'brand_reply');
  // A real go-ahead still counts
  assert.equal(goAheadToVideo('The script has been reviewed and looks great. You can now move forward with the video draft.'), true);
});

test('CapCut x Lindsay, Nov 12: contract and payment key points never reach the video card', async () => {
  const { pageBody } = await import('../lib/briefs.js');
  const blocks = pageBody({ x: { brand: 'CapCut', summary: ['Campaign brief provided via link', 'Collaboration agreement contract attached, needs signature and return', 'Publication deadline: November 27', 'Payment 100% within 7 days after all conditions met (publication + W-8/W-9 + invoice)'] }, email: { from: 'a', subject: 'b', date: 'c' }, links: [], uploads: [] });
  const text = JSON.stringify(blocks);
  assert.match(text, /Publication deadline/);
  assert.doesNotMatch(text, /contract attached/i);
  assert.doesNotMatch(text, /Payment 100%/);
});

test('CapCut x Lindsay, Nov 12: "3 promotional videos" is three cards', async () => {
  const { videoCount } = await import('../lib/briefs.js');
  assert.equal(videoCount({ deliverables: '3 promotional videos for CapCut APP on Instagram, 30–60 seconds each' }), 3);
  assert.equal(videoCount({ deliverables: 'two branded reels' }), 2);
  assert.equal(videoCount({ deliverables: 'One dedicated long-form YouTube video (8-10 minutes)' }), 1);
  assert.equal(videoCount({ deliverables: 'one instagram reel (collab post) + cross post on TikTok' }), 1);
});

test('a brief that only sits in the quoted thread is found, without the budget (Dreamina x Chris, Nov 12)', async () => {
  const { quotedBrief } = await import('../lib/inbox.js');
  const mail = `Hi,
Thank you for your update. Our timeline is extremely tight. We must receive both the script and UID today.

Jenny, BD

Chris Cordero <collab@chriscordero.net> wrote:
> Hi Jenny,
> We will move forward and submit the script shortly for approval.
>
> On Wed, Nov 11, 2026 at 9:43 PM Jenny Guo <jenny@viralvibe.llc> wrote:
>> We're excited to move forward with this Dreamina collaboration! Please find the key project details below:
>> Project: Dreamina
>> Deliverables: 1 reel+7d bio + 1mon adcode
>> Budget: $1200 USD
>> Content Direction: Topic 2 – Artist Team
>> Brief:
>> https://rcne281884cj.feishu.cn/wiki/XQ5KwTi26iNsr0kQrldcAK3FnFf?from=from_copylink
>> Script Submission: 11/11`;
  const b = quotedBrief(mail);
  assert.ok(b.includes('feishu.cn/wiki/XQ5KwTi26iNsr0kQrldcAK3FnFf'));
  assert.ok(b.includes('Topic 2'));
  assert.ok(!/1200/.test(b));
  assert.equal(quotedBrief('Thanks, the payment went out today.\n\n> On Mon you wrote:\n> Here is our invoice https://pay.stripe.com/x'), '');
  const { DOC_LINK } = await import('../lib/briefs.js');
  assert.ok(DOC_LINK.test('https://rcne281884cj.feishu.cn/wiki/abc'));
});

// System check Nov 12 (Readdy AI x Lindsay): a stale queued WhatsApp ask went out after we had already answered it,
// and it blocked the brand's newer question for that deal.
test('a queued WhatsApp ask is dropped once the deal moved, and a newer ask replaces it (Readdy AI x Lindsay, Nov 12)', async () => {
  const fs = await import('node:fs');
  const W = await import('../lib/whatsapp.js');
  const queued = '2026-11-11T09:20:00.000Z';
  assert.equal(W.queuedAskStale(queued, { lastOur: '2026-11-11T09:28:00.000Z', lastBrand: '2026-11-11T09:10:00.000Z' }), true);
  assert.equal(W.queuedAskStale(queued, { lastOur: '2026-11-10T09:00:00.000Z', lastBrand: '2026-11-11T10:15:00.000Z' }), true);
  assert.equal(W.queuedAskStale(queued, { lastOur: '2026-11-10T09:00:00.000Z', lastBrand: '2026-11-11T09:10:00.000Z' }), false);
  assert.equal(W.queuedAskStale(queued, null), false);
  const src = fs.readFileSync(new URL('../lib/whatsapp.js', import.meta.url), 'utf8');
  assert.match(src, /if \(await askIsStale\(m\)\) \{ m\.meta = 'stale-ask'; m\.resolved = true; continue; \}/);
  assert.match(src, /meta === 'pending-ask' && m\.infoAsk\?\.dealId === ask\.dealId && !m\.resolved\);\s*if \(queued\) \{ queued\.content/);
});

test("a creator's earnings link shows only their own rows and nothing internal", async () => {
  process.env.CREATOR_REVENUE_KEYS = 'Chris:aaaaaaaaaaaaaaaaaaaaaaaa';
  const { creatorView } = await import('../api/revenue.js');
  const d = { generated_at: 'x', today: '2026-11-12', cuts: { Chris: 0, Lindsay: 20 }, videos: [
    { creator: 'Chris', title: 'CapCut × Chris', brand: 'CapCut', status: '7- In Edit', date: '2026-11-18', amount: 1500, paid: false, deal: { expected: '2026-12-18', url: 'https://notion/deal' }, link: 'https://notion/card', revUrl: 'r', suggested: 9, cutCollected: true },
    { creator: 'Lindsay', title: 'X', amount: 3000 },
  ] };
  const v = await creatorView('Chris', d);
  assert.equal(v.videos.length, 1);
  const s = JSON.stringify(v);
  assert.ok(!/notion|cutCollected|"cuts"|Lindsay|suggested|revUrl/i.test(s));
  assert.equal(v.videos[0].stage, 'In production');
});

test("a creator can only save rows that are theirs, and only money fields", async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../api/revenue.js', import.meta.url), 'utf8');
  const save = src.slice(src.indexOf('export async function creatorSave'), src.indexOf('export default'));
  assert.ok(/x\.key === b\.key && ck\(x\.creator\) === ck\(creator\)/.test(save));
  assert.ok(!/cutCollected|skip/.test(save));
});

test('outreach: the right brands are picked for a creator', async () => {
  const { pickBrands } = await import('../lib/outreach.js');
  const P = (o) => ({ id: o.k, properties: {
    Key: { type: 'rich_text', rich_text: [{ plain_text: o.k }] }, Brand: { type: 'title', title: [{ plain_text: o.b }] },
    'Contact Emails': { type: 'rich_text', rich_text: [{ plain_text: o.e || `hi@${o.k}` }] },
    'Offer Type': { type: 'select', select: { name: o.t || 'Paid offer' } }, 'Do Not Contact': { type: 'checkbox', checkbox: !!o.dnc },
    Approached: { type: 'multi_select', multi_select: (o.a || []).map((name) => ({ name })) }, 'Worked With': { type: 'multi_select', multi_select: [] },
    'Pitched For': { type: 'multi_select', multi_select: (o.p || []).map((name) => ({ name })) }, 'Last Pitched': { type: 'date', date: o.lp ? { start: o.lp } : null },
    'Last Seen': { type: 'date', date: { start: o.ls || '2026-11-01' } }, 'Reach-outs': { type: 'rich_text', rich_text: [{ plain_text: o.r ?? '1 Nov 2026 · Chris · X · Paid offer · lead, waiting on brand' }] }, 'Top Budget USD': { type: 'number', number: o.u || 0 }, 'Contact Name': { type: 'rich_text', rich_text: [] } } });
  const pool = [P({ k: 'good.com', b: 'Good', u: 2000 }), P({ k: 'gift.com', b: 'Gift', t: 'Gifted' }), P({ k: 'dnc.com', b: 'Dnc', dnc: 1 }),
    P({ k: 'own.com', b: 'Own', a: ['Lindsay'] }), P({ k: 'old.com', b: 'Old', ls: '2025-01-01' }), P({ k: 'recent.com', b: 'Recent', p: ['Lindsay'], lp: '2026-11-01' }),
    P({ k: 'busy.com', b: 'Busy AI' }), P({ k: 'q.com', b: 'Q' }), P({ k: 'cheap.com', b: 'Cheap', u: 300 }), P({ k: 'offeronly.com', b: 'OfferOnly', r: '2 Nov 2026 · Chris · OfferOnly · Paid offer · lead, new offer' })];
  const out = pickBrands('Lindsay', pool, [{ creator: 'Lindsay', poolKey: 'q.com' }], [{ brand: 'Busy', creator: 'Chris' }], { now: Date.parse('2026-11-12') });
  assert.deepEqual(out.map((x) => x.brand), ['Good', 'Cheap']);
});

test('outreach: the template fills in and follows the creator', async () => {
  const { render, nextUp } = await import('../lib/outreach.js');
  const t = 'I manage [creator] (X+ followers). Since [creator] is an AI creator, he would fit. His audience wants {brand}.';
  assert.equal(render(t, { creator: 'Lindsay', followers: '250K', pronoun: 'she', brand: 'Acme' }), 'I manage Lindsay (250K+ followers). Since Lindsay is an AI creator, she would fit. Her audience wants Acme.');
  const cs = [{ creator: 'Chris', status: 'Running', followUp1: 'fu', followUp2: '' }, { creator: 'Brad', status: 'Paused', followUp1: '', followUp2: '' }];
  const now = Date.parse('2026-11-12T15:00:00Z');
  const rows = [{ id: 1, creator: 'Chris', status: 'Queued', created: '2026-11-10' }, { id: 2, creator: 'Brad', status: 'Queued', created: '2026-11-01' },
    { id: 3, creator: 'Chris', status: 'Sent', lastSentAt: '2026-11-07T15:00:00Z' }];
  assert.equal(nextUp(cs, rows, now).row.id, 3); // a due follow-up goes first
  assert.equal(nextUp(cs, rows.slice(0, 2), now).row.id, 1); // a paused creator never sends
});

test('a creator looping noocapcollab in for the contract and brief is a handover, and the brief gets chased twice', async () => {
  const { isHandover, briefChaseDue, briefChaseText } = await import('../lib/leads.js');
  assert.ok(isHandover('Hi Lily,\n\nThat works for me. I can publish the video within two weeks.\n\nPlease send over the contract and brand brief and I am looping noocapcollab@gmail.com in the thread in so we can move straight into scripting.', 'lily@macaron-ai.com', 'noocapcollab@gmail.com'));
  assert.ok(!isHandover('What would the contract terms be? Our rate is $1,500.', '', 'noocapcollab@gmail.com'));
  const base = { status: 'Locked', nextStep: 'Handed to noocapcollab: waiting for the brief', lastOur: '2026-11-06T11:07:00Z', lastBrand: '2026-11-06T03:43:00Z' };
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(briefChaseDue({ ...base, n: 0, now }), 'chase');
  assert.equal(briefChaseDue({ ...base, n: 1, lastOur: '2026-11-11T10:00:00Z', now }), null); // 3 days between chases
  assert.equal(briefChaseDue({ ...base, n: 2, now }), 'handoff');
  assert.equal(briefChaseDue({ ...base, n: 0, lastBrand: '2026-11-08T10:00:00Z', now }), null); // the brand answered
  assert.equal(briefChaseDue({ ...base, n: 0, now, dealHasBrief: true }), null);
  assert.match(briefChaseText({ n: 1, brand: 'TapNow AI', name: 'Lily', creator: 'Chris' }), /^Hi Lily,\n\nJust following up on the contract and brief for TapNow AI/);
});

test('a handover nobody chased for weeks is not chased out of the blue (Hailuo, Oct 28)', async () => {
  const { briefChaseDue } = await import('../lib/leads.js');
  assert.equal(briefChaseDue({ status: 'Locked', nextStep: 'Handed to noocapcollab: waiting for the brief', lastOur: '2026-10-28T07:15:00Z', lastBrand: '2026-10-26T03:30:00Z', n: 0, now: Date.parse('2026-11-12T12:00:00Z') }), null);
});

test('outreach skips an agency mid-deal with another creator, matched by its email domain (growmaxvalue / CapCut)', async () => {
  const { pickBrands } = await import('../lib/outreach.js');
  const row = { id: 'g', properties: { Key: { type: 'rich_text', rich_text: [{ plain_text: 'growmaxvalue.com' }] }, Brand: { type: 'title', title: [{ plain_text: 'growmaxvalue.com (agency)' }] },
    'Contact Emails': { type: 'rich_text', rich_text: [{ plain_text: 'jenny.c@growmaxvalue.com' }] }, 'Offer Type': { type: 'select', select: { name: 'Paid offer' } }, 'Do Not Contact': { type: 'checkbox', checkbox: false },
    Approached: { type: 'multi_select', multi_select: [] }, 'Worked With': { type: 'multi_select', multi_select: [] }, 'Pitched For': { type: 'multi_select', multi_select: [] }, 'Last Pitched': { type: 'date', date: null },
    'Last Seen': { type: 'date', date: { start: '2026-11-10' } }, 'Reach-outs': { type: 'rich_text', rich_text: [{ plain_text: '10 Nov 2026 · Lindsay · CapCut · deal, brief received' }] }, 'Top Budget USD': { type: 'number', number: 3000 }, 'Contact Name': { type: 'rich_text', rich_text: [] } } };
  const now = Date.parse('2026-11-12');
  assert.equal(pickBrands('Valeri', [row], [], [{ brand: 'CapCut', creator: 'Chris', stage: 'In Production', brandEmail: 'mia.brown@growmaxvalue.com' }], { now }).length, 0);
  assert.equal(pickBrands('Valeri', [row], [], [], { now })[0].brand, 'Growmaxvalue');
});

test('outreach: a saved campaign with no pronoun still uses she for Valeri, Lindsay and Nicole', async () => {
  const { defaultPronoun } = await import('../lib/outreach.js');
  assert.equal(defaultPronoun('Valeri'), 'she'); assert.equal(defaultPronoun('Lindsay'), 'she'); assert.equal(defaultPronoun('Chris'), 'he');
});

test("outreach: the creator's Instagram goes on its own line before the sign-off, nothing after the link", async () => {
  const { withInstagram } = await import('../lib/outreach.js');
  const out = withInstagram('Hi,\n\nPitch.\n\nThanks', 'Valeri');
  assert.equal(out, "Hi,\n\nPitch.\n\nYou can see Valeri's content here:\nhttps://www.instagram.com/valeridoesai/\n\nThanks");
  assert.equal(withInstagram('Hi,\n\nThanks', 'Brad'), 'Hi,\n\nThanks');
});

test('a signed contract from WhatsApp finds its deal, and asks when it is not clear', async () => {
  const { matchDeal, looksLikeContract, contractEmail } = await import('../lib/contracts.js');
  const deals = [
    { id: '1', brand: 'Atoms', creator: 'Lindsay', stage: 'Price Agreed', brandEmail: 'gina@luminarysm.com' },
    { id: '2', brand: 'OiiOii', creator: 'Chris', stage: 'Price Agreed', brandEmail: 'vera@luminarysm.com' },
    { id: '3', brand: 'TapNow AI', creator: 'Chris', stage: 'Paid', brandEmail: 'lily@macaron-ai.com' },
  ];
  assert.equal(matchDeal({ filename: 'Atoms_Lindsay_Agreement_signed.pdf' }, deals)?.id, '1');
  assert.equal(matchDeal({ caption: 'oiioii signed', filename: 'scan.pdf' }, deals)?.id, '2');
  assert.equal(matchDeal({ filename: 'contract.pdf', text: 'This Agreement is made between Luminary SM and the creator' }, deals), null); // agency runs two deals: ask
  assert.equal(matchDeal({ filename: 'TapNow contract.pdf' }, deals), null); // paid deal: not a target
  // Topview AI x Lindsay, Nov 22: a paused duplicate on the same thread never ties with the live deal
  const dup = [
    { id: '94', brand: 'Topview AI', creator: 'Lindsay', stage: 'Script Approved', brandEmail: 'limsuwern@topview.ai', threadId: 't1' },
    { id: '95', brand: 'Topview AI', creator: 'Lindsay', stage: 'Script Approved', brandEmail: 'limsuwern@topview.ai', threadId: 't1', paused: true },
  ];
  assert.equal(matchDeal({ filename: 'Influencer Services Agreement - Topview AI x Lindsay Gonzales (signed).pdf' }, dup)?.id, '94');
  assert.equal(matchDeal({ caption: 'Topview' }, dup)?.id, '94');
  assert.equal(matchDeal({ caption: 'Topview' }, [{ ...dup[1], threadId: 't2' }])?.id, '95'); // paused alone still matches
  assert.ok(looksLikeContract('scan.pdf', 'IN WITNESS WHEREOF the parties have signed'));
  assert.ok(!looksLikeContract('thumbnail.png', 'hello'));
  assert.match(contractEmail(deals[0]), /^Hi Gina,\n\nPlease find the signed contract attached/);
});

test('a contract inside a brief email is found: unnamed PDFs, and contract links next to the word "contract"', async () => {
  const { contractIn, contractDocLinks } = await import('../lib/inbox.js');
  const brief = 'Hi! Here is the brief: https://docs.google.com/document/d/BRIEF123/edit\nAnd the contract for signing: https://docs.google.com/document/d/CONTRACT456/edit\nThanks';
  assert.deepEqual(contractDocLinks(brief), ['https://docs.google.com/document/d/CONTRACT456/edit']);
  const c = contractIn({ text: 'Please find the brief and our collaboration details attached.', attachments: [{ filename: 'Collaboration.pdf', mimeType: 'application/pdf', data: 'x' }, { filename: 'Brief.pdf', mimeType: 'application/pdf', data: 'y' }] });
  assert.equal(c.unnamed.length, 1);
  assert.equal(c.unnamed[0].filename, 'Collaboration.pdf');
  const named = contractIn({ text: 'Brief and contract attached', attachments: [{ filename: 'Brief.pdf', mimeType: 'application/pdf' }, { filename: 'Agreement_Atoms.pdf', mimeType: 'application/pdf' }] });
  assert.deepEqual(named.files.map((f) => f.filename), ['Agreement_Atoms.pdf']);
});

test('an Anthropic spend limit tells Harsh once that brand emails are going unread (system check, Nov 12)', async () => {
  const { spendLimitAlert } = await import('../lib/pause.js');
  const sent = [];
  const send = async (content, channel) => { sent.push({ content, channel }); return true; };
  const err = 'Claude 400: {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}}';
  assert.equal(await spendLimitAlert(err, send), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'pm');
  assert.match(sent[0].content, /^⚠️ \*\*Brand emails are not being read/);
  assert.match(sent[0].content, /console\.anthropic\.com/);
  // The headline is fixed, so discord()'s 12-hour dedupe sends it once however many emails fail
  await spendLimitAlert(err.replace('2026-12-01', '2027-01-01'), send);
  assert.equal(sent[0].content.split('\n')[0], sent[1].content.split('\n')[0]);
  // A passing overload is not a spend limit: no alert
  assert.equal(await spendLimitAlert('Claude 529: overloaded', send), false);
  assert.equal(sent.length, 2);
});

test('an email held by the second reader still stamps who wrote last, so no follow-up chases a brand that just answered (Upfluence, Nov 13)', async () => {
  const { heldBrandStamps } = await import('../lib/inbox.js');
  const email = { date: 'Thu, 12 Nov 2026 09:17:00 +0000', messageId: '<CAHKsOKSWp@mail.gmail.com>' };
  const m = Object.fromEntries(heldBrandStamps(email, { from_role: 'brand' }));
  assert.equal(m['Last Brand Reply'], '2026-11-12T14:47:00+05:30');
  assert.equal(m['Follow-ups Sent'], 0);
  assert.equal(m['Message ID'], '<CAHKsOKSWp@mail.gmail.com>');
  // Our own side or the creator writing is not a brand reply
  assert.deepEqual(heldBrandStamps(email, { from_role: 'creator' }), []);
  assert.deepEqual(heldBrandStamps(email, { from_role: 'us' }), []);
});

test('a brand asking WHEN gets a WhatsApp ask to Harsh, never a draft with a [DATE] gap (Manyfast x Chris, Nov 13)', async () => {
  const { asksForDate } = await import('../lib/briefs.js');
  assert.equal(asksForDate('After trying the account, could you let us know when you expect to share the script, video draft and proposed publication date?'), true);
  assert.equal(asksForDate('Could you share your timeline for the first cut?'), true);
  assert.equal(asksForDate('How soon can the video go live?'), true);
  assert.equal(asksForDate('Do you have a CapCut Pro subscription and enough credits?'), false);
  assert.equal(asksForDate('Could you suggest a comment keyword for your audience?'), false);
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/briefs.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /write "\[DATE\]" where the date goes/);
});

test('a UID or code the brand email, deal and Harsh never gave holds the reply (Dreamina x Chris, Nov 13)', async () => {
  const O = await import('../lib/outbox.js');
  const src = 'From: Jenny Guo\n\nCould you please send me your Dreamina UID as soon as possible?\n{"brand":"Dreamina","creator":"Chris"}';
  const bad = O.checkDraft({ body: 'Hi Jenny,\n\nOur Dreamina UID is 829104.\n\nBest,\nChris\'s Team', creator: 'Chris', sources: src });
  assert.ok(bad.issues.some((i) => /829104/.test(i) && /made up/.test(i)));
  // the same number in the facts is fine, and without sources (WhatsApp answers) nothing is checked
  assert.equal(O.checkDraft({ body: 'Our Dreamina UID is 829104.', creator: 'Chris', sources: src + ' UID 829104' }).issues.length, 0);
  assert.equal(O.checkDraft({ body: 'Our Dreamina UID is 829104.', creator: 'Chris' }).issues.length, 0);
  // words after "code" are not codes
  assert.deepEqual(O.inventedCodes('The code is ready and the ID is attached.', src), []);
  assert.deepEqual(O.inventedCodes('Use promo code LINDSAY_PROMO2 at checkout.', src), ['LINDSAY_PROMO2']);
});

test('proof of an earlier payment never marks a later invoice paid (Zeely AI x Duncan, Nov 13)', async () => {
  const { earlierProof } = await import('../lib/inbox.js');
  const mem = 'HISTORY:<br />2026-10-23 brand first payment transfer confirmation sent.<br />2026-11-13 brand Victoria Ev states the second half of the payment was sent and asks to check it.';
  assert.equal(earlierProof(mem, '', '2026-11-03'), false);
  assert.equal(earlierProof(mem, '', ''), true);
  assert.equal(earlierProof('2026-11-05 brand payment confirmation attached', '', '2026-11-03'), true);
  assert.equal(earlierProof('', 'receipt attached on the old invoice', '2026-11-03'), false);
});

test('a step-by-step guide with script approval as a future step is never script_approved (AI Inspo x Duncan, test bank, Nov 13)', async () => {
  const I = await import('../lib/inbox.js');
  const text = "Hi ,\n\nHere is the Google Drive folder.\n\nSTEP-BY-STEP Collaboration Guide\n1.Payment Information\nPlease provide your payment information.\n3.Script Preparation\nPlease write the script based on the production guide.\n4.Script Approval\nPlease send us the script for review.\n5.Filming & Editing\nPlease proceed with filming and editing according to the approved script and production guide.\n\nBest regards,\nJessie";
  const x = { event: 'script_approved', from_role: 'brand' };
  I.applyTextGuards(x, { text });
  assert.equal(x.event, 'brand_reply');
  const y = { event: 'script_approved', from_role: 'brand' };
  I.applyTextGuards(y, { text: 'The script is approved! Please proceed with filming. Once done, send the draft for review.' });
  assert.equal(y.event, 'script_approved');
});

test('our "send the contract and brief and we will start the script" is not a script we owe (Fotor x Chris, Nov 13)', async () => {
  const I = await import('../lib/inbox.js');
  const latest = "Hi Marina,\n\nThanks for pushing for that budget. We can move forward with $1,200 for the\nvideo package.\n\nPlease send over the contract and content brief to noocapcollab@gmail.com\n(cc'd here), and we will get started on the script and send it over for\nyour review.\n\nThanks";
  assert.deepEqual(I.scriptPromiseKept(['Script'], 'creator', latest).promised, []);
  assert.deepEqual(I.scriptPromiseKept(['Script', 'signed contract'], 'noocap', "We'll send the revised script tomorrow and the signed contract today.").promised, ['Script', 'signed contract']);
});

test('a follow-up auto-sent earlier in the same heartbeat counts as our newest email (JEEVMEDIA x Lindsay, Nov 14)', async () => {
  const { latestOurEmail } = await import('../lib/heartbeat.js');
  const deal = { lastOur: '2026-11-09T12:00:00.000Z', lastBrand: '2026-11-09T10:00:00.000Z' };
  assert.equal(latestOurEmail(deal, null, '2026-11-13T23:54:00.000Z'), '2026-11-13T23:54:00.000Z');
  assert.equal(latestOurEmail(deal, '2026-11-10T08:00:00.000Z', '2026-11-13T23:54:00.000Z'), '2026-11-13T23:54:00.000Z');
  assert.equal(latestOurEmail(deal, null, '2026-11-01T00:00:00.000Z'), '2026-11-09T12:00:00.000Z');
});

test('a past-due chase written after 18:30 UTC on the due date is not retired as before-due (Runway AI x Chris, Nov 14)', async () => {
  const { writtenBeforeDue } = await import('../lib/heartbeat.js');
  assert.equal(writtenBeforeDue('2026-11-13T18:36:24.000Z', '2026-11-13'), false);
  assert.equal(writtenBeforeDue('2026-11-13T10:00:00.000Z', '2026-11-13'), true);
  assert.equal(writtenBeforeDue('2026-11-11T18:36:00.000Z', '2026-11-13'), true);
  assert.equal(writtenBeforeDue(null, '2026-11-13'), false);
});

test('a cut is "revised" for the brand only when the brand already had a cut (PromoCut x Brad, Nov 14)', async () => {
  const { brandRevised } = await import('../lib/brandsend.js');
  assert.equal(brandRevised({ revisions: 1, sentBefore: false }), false);
  assert.equal(brandRevised({ revisions: 1, sentBefore: true }), true);
  assert.equal(brandRevised({ revisions: 0, sentBefore: true }), false);
});

test('notes on cuts with timestamps are video feedback, never script changes (zenbusiness-ugc-notes, Nov 14)', async () => {
  const { applyTextGuards, notesOnCut } = await import('../lib/inbox.js');
  const text = 'Hi team,\n\nThanks for the cuts! A few changes before we can approve:\nUGC 1 · 0:12 please show the dashboard for 2 more seconds\nUGC 3 · 0:04s missing the ® after Velo\n\nThanks!';
  assert.equal(applyTextGuards({ event: 'script_changes', feedback: 'x' }, { text }).event, 'video_feedback');
  assert.equal(notesOnCut('Please change the hook line in the script, and cut the second paragraph'), false);
  assert.equal(notesOnCut('Please cut the intro a bit shorter and lead with the pricing'), false);
  assert.equal(applyTextGuards({ event: 'script_changes' }, { text: 'Can you make the intro of the script shorter?' }).event, 'script_changes');
});

test('a follow-up wait counts real days since our email, not IST calendar days (ElevenLabs x Duncan, Nov 14)', async () => {
  const { elapsedDays } = await import('../lib/heartbeat.js');
  assert.equal(elapsedDays('2026-11-11T14:19:00.000Z', Date.parse('2026-11-13T18:35:00.000Z')), 2);
  assert.equal(elapsedDays('2026-11-11T14:19:00.000Z', Date.parse('2026-11-14T14:20:00.000Z')), 3);
  assert.equal(elapsedDays(null), null);
});

test('System check Nov 14 night: a process guide stays brand_reply even when a later guard would call it approved (AI Inspo x Duncan)', async () => {
  const { applyTextGuards } = await import('../lib/inbox.js');
  const text = "Hi ,\n\nHere is the Google Drive folder containing all the detailed collaboration information.\n\n【Collaboration Confirmed】\n1. Product: one video promoting AI Inspo\n\nSTEP-BY-STEP Collaboration Guide】\n1.Payment Information\nPlease provide your payment information.\n3.Script Preparation\nPlease write the script based on the production guide and materials we provide.\n4.Script Approval\nPlease send us the script for review.\n5.Filming & Editing\nPlease proceed with filming and editing according to the approved script and production guide.\n6.Video Review\nOnce the video is completed, please send us the first draft for review.\n\nBest regards,\nJessie";
  for (const ev of ['script_approved', 'brief', 'script_changes', 'brand_reply']) {
    const x = applyTextGuards({ event: ev, from_role: 'brand' }, { text });
    assert.notEqual(x.event, 'script_approved', `${ev} became script_approved`);
  }
  // a real approval still counts
  const ok = applyTextGuards({ event: 'script_approved', from_role: 'brand' }, { text: 'The script looks great, approved! Please proceed with filming.' });
  assert.equal(ok.event, 'script_approved');
});

test('System check Nov 14 night: an email of the same kind sent minutes ago blocks a second draft (Teamily AI x Brad)', async () => {
  const { sentWithinHours } = await import('../lib/heartbeat.js');
  const now = Date.parse('2026-11-14T12:15:07Z');
  assert.equal(sentWithinHours('2026-11-14T12:14:00.000Z', 12, now), true);
  assert.equal(sentWithinHours('2026-11-13T23:00:00.000Z', 12, now), false);
  assert.equal(sentWithinHours(null, 12, now), false);
});

test('writeEmail guard: no "here is" for a file the email does not carry (Dreamina x Chris, Nov 14)', async () => {
  const { claimsMissingAttachment, dropAttachClaims } = await import('../lib/outbox.js');
  const bad = "Hi Jenny,\n\nHere is the cover image and caption for your final review.\n\nBest,\nChris's Team";
  assert.equal(claimsMissingAttachment(bad, {}, 'Reply'), true);
  assert.equal(claimsMissingAttachment(bad, { caption: 'x' }, 'Reply'), false);
  assert.equal(claimsMissingAttachment('Hi,\n\nHere is the cut: https://f.io/x\n', {}, 'Reply'), false);
  assert.equal(claimsMissingAttachment(bad, {}, 'Script'), false);
  assert.equal(claimsMissingAttachment('Hi Jenny,\n\nThanks for the update, we will go ahead.\n', {}, 'Reply'), false);
  assert.ok(!/Here is/.test(dropAttachClaims(bad)));
  assert.equal(claimsMissingAttachment("Hi Kat,\n\nHere's a quick update on timing: Lindsay films Monday.\n", {}, 'Reply'), false);
});

// ---------- script writer hand-off lands on the flagged card (CapCut x Chris, Nov 15) ----------
test('Send to Script Writer on card (2) never moves or notes video 1 and leaves the deal alone', async () => {
  const { scriptPingTarget } = await import('../lib/inbox.js');
  const deal = { brand: 'CapCut', creator: 'Chris', linkedVideo: 'https://app.notion.com/p/CapCut-Chris-40f508e99dda81d0b637f7d05510295d' };
  const card2 = 'https://www.notion.so/CapCut-Chris-2-413508e99dda81a1aed5f60f8b7ea0ab';
  assert.deepEqual(scriptPingTarget(deal, card2), { target: card2, touchDeal: false });
  // the deal's own card, or no card given (WhatsApp / email path): the old behaviour
  assert.equal(scriptPingTarget(deal, 'https://www.notion.so/40f508e99dda81d0b637f7d05510295d').touchDeal, true);
  assert.deepEqual(scriptPingTarget(deal, null), { target: deal.linkedVideo, touchDeal: true });
});

// ---------- sibling cards of an email deal are not orphan scripts (CapCut x Lindsay (2)/(3), Nov 16) ----------
test('Script-ready WhatsApp PDF never goes for card (2)/(3) of an email deal, still goes for WhatsApp deals', async () => {
  const { cardOfEmailDeal } = await import('../lib/heartbeat.js');
  const email = { brand: 'CapCut', creator: 'Lindsay', threadId: '1a1cadfa732fd290', channel: 'Email', linkedVideo: 'https://app.notion.com/p/CapCut-Lindsay-415508e99dda81aa8f7cd2b1b1c0aa01' };
  const wa = { brand: 'Higgsfield.AI', creator: 'Lindsay', threadId: '', channel: 'WhatsApp', linkedVideo: 'https://app.notion.com/p/x-415508e99dda812eaedccdfbd165398d' };
  assert.equal(cardOfEmailDeal({ title: 'CapCut × Lindsay (2)', creator: 'Lindsay' }, [email, wa]), true);
  assert.equal(cardOfEmailDeal({ title: 'CapCut × Lindsay (3)', creator: 'Lindsay' }, [email]), true);
  assert.equal(cardOfEmailDeal({ title: 'Higgsfield.AI × Lindsay (2)', creator: 'Lindsay' }, [email, wa]), false);
  assert.equal(cardOfEmailDeal({ title: 'CapCut × Chris (2)', creator: 'Chris' }, [email]), false);
});

// ---------- no tool-access ask after the brand gave an account; greet by signed name (Manyfast x Chris, Nov 16) ----------
test('Tool access: skipped when the brand already shared a trial login, and greets the signed name', async () => {
  const { brandGaveAccount, greetingName } = await import('../lib/inbox.js');
  assert.equal(brandGaveAccount('2026-11-11 Brand confirmed move forward; sent trial account; shared product angle and tracking link.'), true);
  assert.equal(brandGaveAccount('', 'Login: https://manyfast.io/en/\nEmail: chriscordero@manyfast.io\nPassword: R#Wa5U5ks6ZV'), true);
  assert.equal(brandGaveAccount('2026-11-10 brand approved script with one note.'), false);
  const text = 'Thanks again—looking forward to seeing the video!\n\nBest,\nSeungjoo Lee (Konan)\nManyfast';
  assert.equal(greetingName('"이승주" <konan@manyfast.io>', text), 'Seungjoo');
  assert.equal(greetingName('Yulia Ivanova <yulia@kudosnarratives.com>', ''), 'Yulia');
  assert.equal(greetingName('<x@y.com>', ''), '');
});

// ---------- no second tool-access ask when the thread already had one (Emergent x Chris, Nov 16) ----------
test('Tool access: skipped when our earlier email in the thread already asked for noocaptools access', async () => {
  const { accessAlreadyAsked } = await import('../lib/inbox.js');
  const emergent = "📨 2026-08-06 · us (NOOCAP) · Re: Emergent X thechriscordero Paid Collab!\nHi Naman,\n\nCould you also please provide us access to the Pro version of the tool so we can proceed with the video production?\n\nPlease grant access to the following email address: noocaptools@gmail.com\n\nThank you\n\n📨 2026-08-06 · brand (Naman Khandelwal <naman@emergent.sh>) · Re: Emergent X thechriscordero Paid Collab!\nyes added\n\n📨 2026-11-16 · brand (\"Karan Varyani\" <karan.v@emergent.sh>) · Re: Emergent X thechriscordero Paid Collab!\nScript looks good to proceed with production.";
  assert.equal(accessAlreadyAsked(emergent), true);
  assert.equal(accessAlreadyAsked("📨 2026-11-01 · Chris's team · Re: X\nOur filming account is noocaptools@gmail.com"), true);
  // a brand line mentioning the address is not our ask; no mention at all = ask
  assert.equal(accessAlreadyAsked("📨 2026-11-16 · brand (Rajeshwari <r@jeevmedia.net>) · Re: Brand Sponsorship Offer\nLindsay's script has been approved by the brand."), false);
  assert.equal(accessAlreadyAsked(''), false);
});

// ---------- no payment chase while a brand's "we paid" claim waits for proof (Zeely AI x Duncan, Nov 16) ----------
test('Payment chase: held while the brand says it paid and we wait for the receipt', async () => {
  const { paymentClaimPending } = await import('../lib/heartbeat.js');
  const zeely = { nextAction: 'Brand says it paid but sent no proof: waiting for their payment confirmation (Stripe invoice still shows sent, not paid)', memory: '', lastBrand: '2026-11-13T12:15:00.000Z', lastOur: '2026-11-06T20:38:00.000Z' };
  assert.equal(paymentClaimPending(zeely), true);
  // we asked for the receipt after their claim and they went quiet: chasing may resume
  assert.equal(paymentClaimPending({ ...zeely, lastOur: '2026-11-14T10:00:00.000Z' }), false);
  // an ordinary unpaid invoice is chased as before
  assert.equal(paymentClaimPending({ nextAction: 'Waiting for payment', memory: 'OPEN NOW: Waiting on brand: payment of INV-004', lastBrand: '2026-11-05', lastOur: '2026-11-06' }), false);
});

// ---------- a WhatsApp brief for a brand whose deal is finished gets its own deal (Higgsfield x Chris, Nov 16) ----------
test('WhatsApp new brief: never offered as an addition to a Posted, Invoiced or Paid deal', async () => {
  const { isFinishedStage } = await import('../api/whatsapp.js');
  assert.equal(isFinishedStage('Posted'), true);
  assert.equal(isFinishedStage('Paid'), true);
  assert.equal(isFinishedStage('Invoiced'), true);
  assert.equal(isFinishedStage('Script Approved'), false);
  assert.equal(isFinishedStage('Price Agreed'), false);
});

test('a brand chasing the editor\'s revisions is never a WhatsApp ask for Harsh (Dreamina x Chris, Nov 16)', async () => {
  const { teamWorkOnly } = await import('../lib/owed.js');
  assert.equal(teamWorkOnly('Make the requested revisions to the video watermark and cover image logo and send them to the brand.'), true);
  assert.equal(teamWorkOnly('Send the revised cut'), true);
  // a date for the work, or something only we have, still goes to Harsh
  assert.equal(teamWorkOnly('when can we expect the video draft'), false);
  assert.equal(teamWorkOnly('Share the live link of the first video and the 60-day ad code'), false);
  assert.equal(teamWorkOnly(''), false);
});

test('a follow-up goes to the brand contact who wrote last in the conversation (ZenBusiness x Lindsay, Nov 16)', async () => {
  const { latestBrandSender, transcriptLine } = await import('../lib/memory.js');
  const tx = [
    transcriptLine({ who: 'brand (Ronnie Choi <ronnie.choi@zenbusiness.com>)', date: '2026-10-22', subject: 'Re: Paid Collab', text: 'feedback' }),
    transcriptLine({ who: 'us (NOOCAP)', date: '2026-11-01', subject: 'Re: Paid Collab', text: 'following up' }),
    transcriptLine({ who: 'brand (Natalie Swanson <natalie.swanson@zenbusiness.com>)', date: '2026-11-03', subject: 'Re: Paid Collab', text: 'Please see the below feedback.' }),
    transcriptLine({ who: 'us (NOOCAP)', date: '2026-11-05', subject: 'Re: Paid Collab', text: 'round 3' }),
  ].join('\n\n');
  assert.equal(latestBrandSender(tx), 'natalie.swanson@zenbusiness.com');
  // the escaped form Notion shows on the page reads the same
  assert.equal(latestBrandSender('📨 2026-11-03 · brand (Natalie Swanson \\<natalie.swanson@zenbusiness.com>) · Re: x'), 'natalie.swanson@zenbusiness.com');
  assert.equal(latestBrandSender('📨 2026-11-05 · us (NOOCAP) · Re: x'), '');
});

// System check Nov 17: flushPending changed a queued message's meta/at/wid, the merge kept the saved 'pending' copy as
// a different message, and every 10-minute run sent the same asks and contract alerts again (03:37, 03:47, 03:57 UTC)
test('a queued WhatsApp message is sent once: the merge drops its pending copy and a re-queued copy is not resent', async () => {
  const { mergeMessages, pendingKey, pendingAlreadySent } = await import('../lib/whatsapp.js');
  const queued = { role: 'assistant', meta: 'pending-doc', content: '📄 Contract: HoneyBook × Chris', at: '2026-11-16T20:27:47.729Z' };
  const sent = { ...queued, pk: pendingKey(queued), meta: 'alert', wid: 'wamid.1', at: '2026-11-17T03:37:57.517Z' };
  const merged = mergeMessages([sent], [queued]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].meta, 'alert');
  // A queued copy that came back next to the already-sent one is recognised as sent
  const st = { messages: [{ ...queued }, sent] };
  assert.equal(pendingAlreadySent(st, st.messages[0]), true);
  // A genuinely new queued message is still sent
  const fresh = { role: 'assistant', meta: 'pending-ask', content: '🙋 Manyfast × Duncan is asking', at: '2026-11-17T03:40:00Z' };
  assert.equal(pendingAlreadySent({ messages: [fresh, sent] }, fresh), false);
});

// System check Nov 17: the Atoms agreement ("Automate AI Consulting x Auremere") auto-sent to Holo AI x Chris because
// "holo" turned up across word breaks once the contract text was squashed into one string
test('a signed contract is matched to a brand only by whole words in its text', async () => {
  const { matchDeal } = await import('../lib/contracts.js');
  const deals = [
    { id: 'holo', brand: 'Holo AI', creator: 'Chris', stage: 'Negotiating', brandEmail: 'anitadundovic@arch.agency' },
    { id: 'atoms', brand: 'Atoms', creator: 'Lindsay', stage: 'Signed', brandEmail: 'may@atoms.dev' },
  ];
  const text = 'This Agreement is made between Auremere Pte Ltd and Automate AI Consulting. Anyone who logs in to the platform agrees to these terms.';
  assert.equal(matchDeal({ caption: 'here you go', filename: 'Automate AI Consulting x Auremere - Agreement (signed).pdf', text }, deals), null);
  assert.equal(matchDeal({ filename: 'contract.pdf', text: 'Agreement between Holo AI Inc. and Chris Cordero' }, deals)?.id, 'holo');
});

// Harsh, Nov 17: "build steps so that the PM won't send the contract to the wrong brand"
test('a signed contract only goes out on its own when every safety check passes', async () => {
  const { contractChecks, hardStop, creatorsNamed } = await import('../lib/contracts.js');
  const holo = { id: 'holo', brand: 'Holo AI', creator: 'Chris', brandEmail: 'anitadundovic@arch.agency', threadId: 't-holo' };
  const atoms = { id: 'atoms', brand: 'Atoms', creator: 'Lindsay', brandEmail: 'may@atoms.dev', threadId: 't-atoms' };
  const text = 'This Agreement is made between Auremere Holdings and Party B (Influencer): Automate AI Consulting.';
  const rows = [{ dealIds: ['atoms'], threadId: 't-atoms' }];
  assert.deepEqual(creatorsNamed(text), ['Lindsay']);
  // The Nov 16 mistake: Lindsay's contract for Holo AI x Chris is a hard stop, even if Harsh names Holo
  const w1 = contractChecks(holo, { caption: 'send to holo', filename: 'x.pdf', text, answered: true, openRows: rows });
  assert.ok(hardStop(w1) && w1.some((w) => /for Lindsay/.test(w)));
  // Brand only guessed (not in caption or file name): ask
  assert.ok(contractChecks(atoms, { caption: 'here you go', filename: 'Automate AI Consulting x Auremere.pdf', text, openRows: rows }).some((w) => /isn't named/.test(w)));
  // Brand named, creator matches, contract waiting: goes
  assert.deepEqual(contractChecks(atoms, { caption: 'share this with atoms', filename: 'a.pdf', text, openRows: rows }), []);
  // No contract from the brand waiting for a signature: ask, unless Harsh named the brand in his answer
  assert.ok(contractChecks(atoms, { caption: 'atoms', filename: 'a.pdf', text, openRows: [] }).some((w) => /hasn't sent us a contract/.test(w)));
  assert.deepEqual(contractChecks(atoms, { caption: 'atoms', filename: 'a.pdf', text, answered: true, openRows: [] }), []);
  // A bare first name in the text is not proof of who the contract is for
  assert.deepEqual(creatorsNamed('Chris from our team will review this agreement'), []);
});

// Harsh, Nov 17: fixed replies for the brand messages that keep coming back
test('fixed replies go only at the right stage, before the brand deadline, and once per thread', async () => {
  const { BUILT_IN, templateBlock, fillTemplate, addWorkingDays } = await import('../lib/replytemplates.js');
  const t = (k) => ({ ...BUILT_IN.find((x) => x.key === k), active: true });
  assert.equal(templateBlock(t('video_eta'), { stage: 'Script Approved', today: '2026-11-17' }), '');
  assert.match(templateBlock(t('video_eta'), { stage: 'Submitted', today: '2026-11-17' }), /deal is at Submitted/);
  assert.match(templateBlock(t('video_eta'), { stage: 'Script Approved', deadline: '2026-11-19', today: '2026-11-17' }), /deadline/);
  assert.equal(templateBlock(t('video_eta'), { stage: 'Script Approved', deadline: '2026-11-28', today: '2026-11-17' }), '');
  assert.match(templateBlock(t('video_eta'), { stage: 'Script Approved', today: '2026-11-17', sentRecently: true }), /already went/);
  assert.match(templateBlock({ ...t('script_review_ack'), active: false }, { stage: 'Script Sent', today: '2026-11-17' }), /no active/);
  assert.equal(addWorkingDays('2026-11-20', 2), '2026-11-24'); // Friday + 2 working days = Tuesday
  const body = fillTemplate(t('video_eta').body, { from: 'Rajeshwari Sardar <rajeshwari@jeevmedia.net>', deal: { creator: 'Lindsay', brand: 'X' } });
  assert.match(body, /^Hi Rajeshwari,/);
  assert.match(body, /Lindsay's Team$/);
  assert.match(fillTemplate(t('script_eta').body, { from: 'partnerships@brand.com', deal: { creator: 'Chris' } }), /^Hi there,/);
  for (const x of BUILT_IN) assert.doesNotMatch(x.body, /—|–|\bnot just\b|\bisn't\b[^.]*\bit's\b/); // Harsh's writing rules
});

// Harsh, Nov 17 (Manyfast x Chris): the 50% upfront invoice can't be blocked by "video not posted"
test('the upfront share is invoiced before the video is posted, for its share only', async () => {
  const { dueNow, raiseChecks } = await import('../lib/invoicing.js');
  const d = { creator: 'Chris', stage: 'Script Approved', finalRate: 1500, paymentTerms: '50% upon script approval, 50% after publication', stripeInvoices: '', deliverables: '1 dedicated Instagram Reel', threadId: 't', messageRfc: 'm', brandEmail: 'jun@manyfast.io' };
  assert.deepEqual(dueNow(d), { part: 'upfront', pct: 50, amount: 750 });
  const checks = raiseChecks(d, { bill: { company_name: 'Slate Media Co., Ltd.' }, connected: true });
  assert.ok(checks.every((c) => c.ok), checks.filter((c) => !c.ok).map((c) => c.t).join(', '));
  // once the upfront invoice is out, the rest waits for the posted video
  const after = { ...d, stripeInvoices: 'upfront | in_1 | sent | 750' };
  assert.equal(dueNow(after).part, 'final');
  assert.equal(dueNow(after).amount, 750);
  assert.ok(raiseChecks(after, { bill: { company_name: 'X' }, connected: true }).some((c) => !c.ok && c.k === 'posted'));
});

test('a greeting to the person the email goes to is kept even before they signed anything', async () => {
  const { fixGreeting } = await import('../lib/invoiceguard.js');
  const convo = '📨 2026-11-17 · brand ("이승주" <konan@manyfast.io>) · Re: x\nHi Chris and team,\n\nBest,\nSeungjoo (Konan)';
  assert.equal(fixGreeting('Hi Jun,\n\nCould you share…', convo, 'jun@manyfast.io').changed, false);
  assert.equal(fixGreeting('Hi Mark,\n\nCould you share…', convo, 'jun@manyfast.io').changed, true);
});

test('a thread subject naming YouTube does not contradict a brief for Instagram, TikTok and Facebook', async () => {
  const { checkInvoice } = await import('../lib/invoiceguard.js').catch(() => ({}));
  const { platformsIn, brandLines } = await import('../lib/invoiceguard.js');
  const convo = '📨 2026-11-17 · brand ("Jun" <jun@manyfast.io>) · Re: Paid YouTube collaboration — Manyfast × Duncan\nHi Duncan and team,\n\nPlease issue the invoice in the name of our agency.';
  const bodies = brandLines(convo).map((l) => l.replace(/^📨[^\n]*\n/, '')).join('\n');
  assert.deepEqual(platformsIn(bodies), []);
  assert.ok(typeof checkInvoice === 'function');
});

test('a video approval is never lost to a script event in the same email (CapCut x Chris, Nov 16-17)', async () => {
  const { applyTextGuards, videoApprovalIn, pickScriptCards } = await import('../lib/inbox.js');
  const nov16 = 'Hi, your video has passed the review. Please publish it as required as soon as possible.\n\nKindly let me know immediately after posting and share the 60-day adcode with me.';
  const nov17 = 'Hi, please publish it as soon as possible. Our client is waiting for your release.\n\nHere are the revision notes for the second script: The hook should focus on budget pressure.\n\nFor the third script, please use this new brief.';
  assert.ok(videoApprovalIn(nov16));
  assert.ok(videoApprovalIn(nov17));
  assert.ok(!videoApprovalIn('Here is the script, please review it and let us know.'));
  assert.ok(!videoApprovalIn('The script has been approved, please film the video.'));
  const a = applyTextGuards({ event: 'script_approved', from_role: 'brand' }, { text: nov16 });
  assert.equal(a.event, 'video_feedback'); assert.equal(a.video_approved, true);
  const b = applyTextGuards({ event: 'script_changes', from_role: 'brand', feedback: 'Second script: hook on budget pressure' }, { text: nov17 });
  assert.equal(b.event, 'script_changes'); assert.equal(b.also_video_approved, true);
  // our own email never approves anything
  assert.ok(!applyTextGuards({ event: 'brand_reply', from_role: 'noocap' }, { text: nov16 }).also_video_approved);
  // script notes go to the cards still at scripting, never the filmed video
  const cards = [{ url: 'v1', num: 9 }, { url: 'v2', num: 5 }, { url: 'v3', num: 5 }, { url: 'v4', num: 7 }];
  assert.deepEqual(pickScriptCards(cards), ['v2', 'v3']);
  assert.deepEqual(pickScriptCards([{ url: 'v1', num: 5 }, { url: 'v2', num: 5 }]), ['v1']);
  assert.deepEqual(pickScriptCards([{ url: 'v1', num: 10 }]), []);
});

test('content money words reach the script writer, deal money never does (CapCut x Chris, Nov 17)', async () => {
  const { forScriptWriter } = await import('../lib/briefs.js');
  const keep = ['1. The hook should focus on budget pressure and marketing challenges, then introduce Dreamina and CapCut PC',
    '2. Put the Black Friday price on the end card', '3. Say the whole ad cost me about a coffee', '4. Add the paid partnership label'];
  assert.deepEqual(forScriptWriter(['Script changes:', ...keep].join('\n')).split('\n').slice(1), keep);
  for (const l of ['Our budget for this campaign is $500', 'The fee is 50% upfront', 'Your rate works for us', 'We will pay on posting', 'Budget is 800 USD'])
    assert.equal(forScriptWriter(`head\n${l}`), 'head', l);
});

test('safety net: an ask the PM did nothing about is reported (Nov 17)', async () => {
  const { missedAsks } = await import('../lib/inbox.js');
  const nov16 = 'Hi, your video has passed the review. Please publish it as required as soon as possible. Kindly let me know immediately after posting and share the 60-day adcode with me.';
  // what the PM did on Nov 16 before the fix: filed it as a script approval
  assert.deepEqual(missedAsks(nov16, { event: 'script_approved', from_role: 'brand' }, 'Deal Script Approved, video 6- To Film'), ['approved a video or asked us to publish', 'asked for the ad code']);
  // handled properly: nothing to report
  assert.deepEqual(missedAsks(nov16, { event: 'video_feedback', from_role: 'brand' }, 'Deal Approved, Video Intake set to To Post'), []);
  const nov17 = 'Hi, please publish it as soon as possible.\n\nHere are the revision notes for the second script: the hook should focus on budget pressure.';
  assert.deepEqual(missedAsks(nov17, { event: 'script_changes', from_role: 'brand' }, 'Script changes sent to Rudraksh · video approved: CapCut × Chris set to To Post'), []);
  assert.deepEqual(missedAsks(nov17, { event: 'brand_reply', from_role: 'brand' }, 'Harsh notified'), ['approved a video or asked us to publish', 'sent notes on a script']);
  assert.deepEqual(missedAsks('Can you send the invoice with your bank details?', { event: 'brand_reply', from_role: 'brand' }, 'Left unread for Harsh to reply [unread thread:1]'), []);
  assert.deepEqual(missedAsks(nov16, { event: 'brand_reply', from_role: 'noocap' }, ''), []);
});

test('video approval wording from Dreamina x Chris (Nov 16)', async () => {
  const { videoApprovalIn } = await import('../lib/inbox.js');
  assert.ok(videoApprovalIn('Thanks! The video looks good now and is approved. Please update the cover image and caption.'));
  assert.ok(videoApprovalIn('Great work, everything is approved on our side.'));
  assert.ok(!videoApprovalIn('Once the video is approved we will process the payment.'));
  assert.ok(!videoApprovalIn('Your script is approved, please film the video.'));
});

test('a deal past the brief with no video card is flagged (CodeRabbit x Chris, Nov 17)', async () => {
  const { dealsWithoutCard } = await import('../lib/heartbeat.js');
  const out = dealsWithoutCard([
    { brand: 'CodeRabbit', stage: 'Brief Received', linkedVideo: '' },
    { brand: 'HoneyBook', stage: 'Brief Received', linkedVideo: 'https://app.notion.com/p/x' },
    { brand: 'Teamily', stage: 'Negotiating', linkedVideo: '' },
    { brand: 'Paused one', stage: 'Script Approved', linkedVideo: '', paused: true },
  ]);
  assert.deepEqual(out.map((d) => d.brand), ['CodeRabbit']);
});

test('automatic sends hold filler, placeholders and flagged drafts (lesson seen 12 times)', async () => {
  const { autoHoldReason } = await import('../lib/outbox.js');
  const ok = { why: 'Fixed reply', body: 'Hi Mia,\n\nThanks, the script will be with you in 2 to 3 working days.\n\nBest,\nChris\'s Team', creator: 'Chris' };
  assert.equal(autoHoldReason(ok), null);
  assert.match(autoHoldReason({ ...ok, body: 'Hi Mia,\n\nWe will publish it right away.\n\nBest,\nChris\'s Team' }), /promises to send/);
  assert.match(autoHoldReason({ ...ok, body: 'Hi Mia,\n\nThe video goes live on [date].\n\nBest,\nChris\'s Team' }), /placeholder/);
  assert.match(autoHoldReason({ ...ok, why: 'Needs you: the second reader flagged it · Follow-up' }), /second reader/);
});

test('one WhatsApp message per thing (lesson seen 4 times)', async () => {
  const { alreadySent } = await import('../lib/whatsapp.js');
  const now = new Date().toISOString();
  const st = { messages: [{ role: 'assistant', at: now, content: '📝 Script ready: FABLE 5.2 × Lindsay\nHere is the PDF' }] };
  assert.ok(alreadySent(st, '📝 Script ready: FABLE 5.2 × Lindsay\nno deal to send it from'));
  assert.ok(!alreadySent(st, '💬 Brand reply: CapCut × Chris\nMia asked for the ad code'));
  assert.ok(!alreadySent({ messages: [{ role: 'assistant', at: new Date(Date.now() - 2 * 36e5).toISOString(), content: '📝 Script ready: FABLE 5.2 × Lindsay' }] }, '📝 Script ready: FABLE 5.2 × Lindsay'));
});

test('a brand chasing team work still gets the fixed timing reply (CodeRabbit x Chris, Nov 17)', async () => {
  const { templateForWork } = await import('../lib/inbox.js');
  assert.equal(templateForWork('Send the draft script'), 'script_eta');
  assert.equal(templateForWork('Make the requested revisions to the watermark'), 'revision_eta');
  assert.equal(templateForWork('Send the first draft video'), 'video_eta');
  assert.equal(templateForWork('Share the ad code'), null);
});

test('a brand signing page on its own domain counts as a contract (Runway x Chris, Nov 17)', async () => {
  const { ownSignLinks, contractIn } = await import('../lib/inbox.js');
  const t = 'Hey Team,\n\nI believe the payment issues is now in hand.\n\nCould you sign the contract for the next campaign please: https://agreements.houseofmarketers.com/sign/_ZnD0Me1plcRpNbQeU7kT6_9TriTNgF3\n\nThanks!';
  assert.deepEqual(ownSignLinks(t), ['https://agreements.houseofmarketers.com/sign/_ZnD0Me1plcRpNbQeU7kT6_9TriTNgF3']);
  assert.ok(contractIn({ text: t, attachments: [] })?.links?.length);
  assert.deepEqual(ownSignLinks('Here is the brief: https://docs.example.com/brief/123'), []);
  assert.deepEqual(ownSignLinks('Sign up here: https://app.example.com/signup'), []);
});

test('the newest email in a deal record says who wrote last', async () => {
  const { lastEntry } = await import('../lib/unanswered.js');
  const t = '📨 2026-11-17 · us (NOOCAP) · Re: Holo\nHi Anita, here are the details.\n\n📨 2026-11-17 · brand ("Dori Zussmann" <dori@narrativegroup.co>) · Re: HoneyBook\nThanks for sharing the signed contract! The next step is to get the script please.';
  const e = lastEntry(t);
  assert.equal(e.side, 'brand'); assert.match(e.text, /next step is to get the script/);
  assert.equal(lastEntry('📨 2026-11-17 · Chris\'s team · Re: X\nHi').side, 'ours');
});

test('typos of our own inboxes and Message-IDs never reach To or Cc (HoneyBook x Chris, Nov 17)', async () => {
  const { fixAddressList, cleanCc } = await import('../lib/outbox.js');
  const { threadCcFrom } = await import('../lib/briefs.js');
  assert.equal(fixAddressList('ollab@chriscordero.net, CAEsMoLQCVr73sbjTepX3q+vdYvAcEqEMbqwLVzN2LjhphY082A@mail.gmail.com, yulia@kudosnarratives.com'), 'collab@chriscordero.net, yulia@kudosnarratives.com');
  assert.equal(threadCcFrom({ from: 'Dori <dori@narrativegroup.co>', to: 'ollab@chriscordero.net, noocapcollab@gmail.com' }), 'collab@chriscordero.net');
  assert.equal(cleanCc('ollab@chriscordero.net', 'dori@narrativegroup.co', 'noocapcollab', 'Chris'), 'collab@chriscordero.net');
  assert.equal(fixAddressList('mia.brown@growmaxvalue.com'), 'mia.brown@growmaxvalue.com');
});

test('product price talk reaches the script writer (Teamily AI x Brad, Nov 17)', async () => {
  const { forScriptWriter } = await import('../lib/briefs.js');
  const l = '8. Changing the price in Studio will not make every agent revise its work on its own. Clarify whether the client edits the price directly.';
  assert.equal(forScriptWriter(`head\n${l}`), `head\n${l}`);
  assert.equal(forScriptWriter('head\nThe price for this collab is 1,500 USD'), 'head');
  assert.equal(forScriptWriter('head\nOur budget for this is tight'), 'head');
});

// Nov 17: Tripo 3D x Valeri sat at Negotiating after we accepted $650 and asked for the contract; Valchy x Valeri had no
// email dates at all. Neither was chased.
test('heartbeat: accepted offer awaiting contract is chased; dateless deals count from creation', async () => {
  const hb = await import('../lib/heartbeat.js');
  const mem = 'AGREED: x<br /><br />HISTORY:<br />2026-10-12 us / NOOCAP counter-offered $800 per video.<br />2026-11-11 brand / Zeelot proposed $650 per video.<br />2026-11-11 us / NOOCAP accepted $650 per video and requested contract.<br /><br />BILLING: not yet';
  assert.equal(hb.weAcceptedAndAsked(mem), true);
  assert.equal(hb.weAcceptedAndAsked(mem.replace('2026-11-11 us / NOOCAP accepted $650 per video and requested contract.', '2026-11-12 brand sent the contract.')), false);
  assert.equal(hb.weAcceptedAndAsked('HISTORY:<br />2026-11-11 us countered at $900.'), false);
  assert.equal(hb.latestOurEmail({ created: '2026-11-05T18:05:00.000Z' }, null, null), '2026-11-05T18:05:00.000Z');
  assert.equal(hb.latestOurEmail({ lastOur: '2026-11-10', created: '2026-11-05' }, null, null), '2026-11-10');
});

// System check Nov 17 night: test bank zeely-second-half-sent-no-proof-nov13 broke after the 14:54 commits because
// "was also sent" did not count as a payment claim; the AI reader alone decided and it said brand_reply
test('payment claim: "the second half of the payment was also sent" is a claim (Zeely x Duncan, Nov 13)', async () => {
  const I = await import('../lib/inbox.js');
  const text = "Hi  Duncan's Team,\n\nI see that the second half of the payment was also sent, could you please check it on your side?\n\nBest,\nVictoria";
  assert.equal(I.isPaymentClaimed(text), true);
  assert.equal(I.isPaymentClaimed('The payment has also been sent today'), true);
  assert.equal(I.isPaymentClaimed('The payment will be sent next week'), false);
  const x = I.applyTextGuards({ event: 'brand_reply', from_role: 'brand', needs_reply: true }, { text });
  assert.equal(x.event, 'payment_confirmed');
});

// System check Nov 17 night: CapCut BD-46 moved from Chris to Brad while a reply signed "Chris's Team" waited
test('send guard: signature must match the deal creator (CapCut x Brad, Nov 17)', async () => {
  const O = await import('../lib/outbox.js');
  assert.equal(O.signatureMismatch("Hi Alisa,<br /><br />Thanks.<br /><br />Best,<br />Chris's Team", 'Brad'), 'Chris');
  assert.equal(O.signatureMismatch("Hi Alisa,\n\nBest,\nBrad's Team", 'Brad'), null);
  assert.equal(O.signatureMismatch("Hi,\n\nBest,\nValeri's Team", 'Valeri'), null);
  assert.equal(O.signatureMismatch("Hi,\n\nBest,\nNOOCAP", 'Brad'), null);
  assert.equal(O.signatureMismatch("Hi,\n\nBest,\nDavid Iya's Team", 'David Iya'), null);
  assert.equal(O.signatureMismatch("Hi,\n\nBest,\nValerie's Team", 'Valeri'), null);
});

test('"we will publish it immediately" is a filler promise too, so an automatic send holds it (test bank capcut-chris-cleared-to-post-nov16)', async () => {
  const { autoHoldReason, checkDraft } = await import('../lib/outbox.js');
  const ok = { why: 'Fixed reply', body: '', creator: 'Chris' };
  for (const line of ['We will publish it immediately.', "We'll get it live straight away.", 'I will share the link ASAP.']) {
    assert.match(autoHoldReason({ ...ok, body: `Hi Mia,\n\n${line}\n\nBest,\nChris's Team` }) || '', /promises to send/, line);
  }
  // a brand asking for something "immediately" is not our promise
  assert.equal(checkDraft({ body: "Hi Mia,\n\nThanks for confirming the video can go live immediately after approval. It is attached here.\n\nBest,\nChris's Team" }).issues.length, 0);
});

test('an invoice email that carries the live links counts as the links email (Readdy AI, Nov 18)', async () => {
  const { carriesPostedLinks } = await import('../lib/outbox.js');
  const links = 'https://www.instagram.com/reel/DfvNh_pGUud/\nhttps://www.youtube.com/shorts/A93bIb5wbPM';
  assert.equal(carriesPostedLinks('The Readdy video is live:<br />Instagram: https://www.instagram.com/reel/DfvNh_pGUud/<br />Here is the invoice for $1,200.', links), true);
  assert.equal(carriesPostedLinks('Here is the invoice for $1,200. Please pay using this link: https://invoice.stripe.com/i/x', links), false);
  assert.equal(carriesPostedLinks('Here is the invoice.', ''), false);
});

test('a draft with a filler promise is rewritten once (CapCut x Chris test bank case, Nov 18)', async () => {
  const { needsFillerRewrite, NO_FILLER } = await import('../lib/outbox.js');
  assert.equal(needsFillerRewrite("Thanks Mia! We'll get it published as soon as possible and share the link right away."), true);
  assert.equal(needsFillerRewrite('Thanks Mia! We will publish it immediately.'), true);
  assert.equal(needsFillerRewrite('Thanks Mia, we will share the live link and the ad code in this thread.'), false);
  assert.equal(needsFillerRewrite('We will publish it right away.', `x ${NO_FILLER}`), false);
});

// Nov 18: Dreamina x Chris, the brand said "please publish" and nobody asked for billing details until after posting
test('invoicing: billing details are asked as soon as the video is approved', async () => {
  const I = await import('../lib/invoicing.js');
  const deal = { stage: 'Approved', brandEmail: 'jenny@viralvibe.llc', finalRate: 1500, billing: '' };
  assert.equal(I.earlyBillingAsk(deal, []), true);
  assert.equal(I.earlyBillingAsk({ ...deal, stage: 'Submitted' }, []), false);
  assert.equal(I.earlyBillingAsk({ ...deal, channel: 'WhatsApp' }, []), false);
  assert.equal(I.earlyBillingAsk(deal, [{ part: 'final', id: 'in_1', status: 'draft' }]), false);
  assert.equal(I.earlyBillingAsk({ ...deal, finalRate: 0 }, []), false);
});

test('invoiceOrder puts approved or posted deals with no billing ahead of payment checks', async () => {
  const { invoiceOrder } = await import('../lib/invoicing.js');
  const deals = [
    { brand: 'Paid check', stage: 'Invoiced', stripeInvoices: 'final | in_1 | sent | 1000' },
    { brand: 'Quiet', stage: 'Script Sent' },
    { brand: 'Dreamina', stage: 'Posted', billing: '' },
    { brand: 'Asked', stage: 'Submitted', invoiceRequested: true },
  ];
  assert.deepEqual(invoiceOrder(deals).map((d) => d.brand), ['Asked', 'Dreamina', 'Paid check', 'Quiet']);
});

test('billingFromText reads company details the brand wrote out (Gamut x Lindsay, Nov 18)', async () => {
  const { billingFromText } = await import('../lib/invoicing.js');
  const text = 'Hi team,\n\nSure, here are our billing details for the invoice:\n\nDatawizz Inc. (operating Gamut)\n360 Pine Street, Suite 400\nSan Francisco, CA 94104, USA\nEIN: 33-4477838\n\nPlease send the invoice for the second payment ($2,000) to iddo.gino@gamut.so together with the live link, and we\'ll get it paid.\n\nThanks!\nIddo';
  const b = billingFromText(text, 'Iddo Gino <iddo.gino@gamut.so>');
  assert.equal(b.company_name, 'Datawizz Inc. (operating Gamut)');
  assert.equal(b.address, '360 Pine Street, Suite 400, San Francisco, CA 94104, USA');
  assert.equal(b.tax_id, 'EIN 33-4477838');
  assert.equal(b.email, 'iddo.gino@gamut.so');
  assert.equal(billingFromText('Thanks, the video looks great, Acme Inc is happy', 'a@b.com'), null);
  assert.equal(billingFromText('Can you send the invoice?', 'a@b.com'), null);
});

test('billing_on_approval template exists, goes at Approved, and asks for company details with the ASAP line', async () => {
  const { BUILT_IN, templateBlock } = await import('../lib/replytemplates.js');
  const t = BUILT_IN.find((x) => x.key === 'billing_on_approval');
  assert.ok(t && /as soon as possible/.test(t.body) && /billing details/.test(t.body));
  assert.equal(templateBlock({ ...t, active: true }, { stage: 'Approved', today: '2026-11-18', sentRecently: false }), '');
  assert.match(templateBlock({ ...t, active: true }, { stage: 'Script Sent', today: '2026-11-18', sentRecently: false }), /deal is at/);
});

test('isHandover catches "I have also looped in noocapcollab to take it over" (Igniters Media x Chris, Nov 18)', async () => {
  const { isHandover } = await import('../lib/inbox.js');
  const email = { to: 'hello@ignitersmedia.com, noocapcollab@gmail.com', cc: '', text: 'Please send over the contract and brand brief, and we will take it from here. I have also looped in noocapcollab@gmail.com to take it over from here moving forward.\n\nThanks,\nChris' };
  assert.equal(isHandover(email, { from_role: 'creator', brand: 'Igniters Media' }), true);
  assert.equal(isHandover({ ...email, to: 'hello@ignitersmedia.com' }, { from_role: 'creator', brand: 'Igniters Media' }), false);
});

test('any fill-in left in square brackets is a placeholder, so an automatic send holds it (test bank capcut-chris-cleared-to-post-nov16, Nov 18)', async () => {
  const { autoHoldReason, checkDraft, needsFillerRewrite } = await import('../lib/outbox.js');
  const ok = { why: 'Fixed reply', body: '', creator: 'Chris' };
  for (const line of ['The ad code is [adcode is].', 'Our UID is [INSERT UID].', 'It goes live on [post date].']) {
    assert.match(autoHoldReason({ ...ok, body: `Hi Mia,\n\n${line}\n\nBest,\nChris's Team` }) || '', /placeholder/, line);
    assert.equal(needsFillerRewrite(`Hi Mia,\n\n${line}`), true, line);
  }
  // a markdown link and a numbered reference are not fill-ins
  assert.equal(checkDraft({ body: "Hi Mia,\n\nHere is the [revised cut](https://f.io/abc) and video [2] notes.\n\nBest,\nChris's Team" }).issues.length, 0);
});

test('a link from another campaign never stays in a written email (test bank tripo-lindsay-account-email-wrong-link-nov18)', async () => {
  const { foreignLinks, dropForeignLinks } = await import('../lib/outbox.js');
  const bad = "Hi Rajeshwari,\n\nThanks for following up.\nhttps://higgsfield-ai.notion.site/astra-6-2-x-higgsfield-game-vi\n\nLindsay X Higgsfield\n\nBest,\nLindsay's Team";
  const allowed = JSON.stringify({}) + "\nHi Team, could you please share the registered email ID of Lindsay's Tripo account?";
  assert.deepEqual(foreignLinks(bad, allowed), ['higgsfield-ai.notion.site/astra-6-2-x-higgsfield-game-vi']);
  assert.doesNotMatch(dropForeignLinks(bad, allowed), /higgsfield-ai/);
  // links the email was given (facts, the brand's own thread) stay, written with or without www and a trailing dot
  const facts = JSON.stringify({ frameio: 'https://f.io/AbC123', pay_link: 'https://invoice.stripe.com/i/acct_1/xyz' });
  assert.deepEqual(foreignLinks('Here is the cut: https://f.io/AbC123. Pay here: https://www.invoice.stripe.com/i/acct_1/xyz', facts), []);
});

test('Invoices never carry the creator\'s own billing address or Tax ID (Harsh, Nov 18, Chris)', async () => {
  const { paymentText } = await import('../lib/invoiceguard.js');
  const t = paymentText({ 'Account Holder Name': 'Christopher Allen', 'Bank Name': 'Middlesex Federal Savings', 'Billing Address': '715 N Patterson Park Ave, Baltimore MD 21205', 'Tax ID': '99-1222704', 'Legal / Company Name': 'CORD Creations' });
  assert.ok(/Middlesex/.test(t));
  assert.ok(!/Patterson|99-1222704/.test(t));
});

test('a fixed reply with Harsh\'s "as soon as possible" line is not held; an AI draft with it still is', async () => {
  const { autoHoldReason, BUILT_IN } = { ...(await import('../lib/outbox.js')), ...(await import('../lib/replytemplates.js')) };
  const body = BUILT_IN.find((t) => t.key === 'billing_on_approval').body.replace('{name}', 'Jenny').replace('{creator}', 'Chris');
  assert.equal(autoHoldReason({ body, creator: 'Chris', why: 'Fixed reply (sent by hand) [template:billing_on_approval]: Dreamina × Chris' }), null);
  assert.ok(autoHoldReason({ body, creator: 'Chris', why: 'Reply to the brand' }));
});

test('second reader "wrong person" is dropped when the cut goes to a brand contact already in the thread (Manyfast x Chris, Nov 18)', async () => {
  const { dropKnownContactFlags } = await import('../lib/outbox.js');
  const convo = '📨 2026-11-16 · brand (이승주 <konan@manyfast.io>) · Re: Paid Reel\nThanks for the script\n\n📨 2026-11-17 · brand (Jun <jun@manyfast.io>) · Re: Paid Reel\nInvoice please';
  const p = ['Wrong person: email is addressed to Seungjoo (konan@manyfast.io), but the latest message was from Jun (jun@manyfast.io) or it should go to Seungjoo as the content contact, but wait,'];
  assert.deepEqual(dropKnownContactFlags(p, 'konan@manyfast.io', { brandEmail: 'jun@manyfast.io' }, convo), []);
  assert.equal(dropKnownContactFlags(['Wrong person: addressed to someone at another brand'], 'x@other.com', { brandEmail: 'jun@manyfast.io' }, convo).length, 1);
  assert.equal(dropKnownContactFlags(['Invented fact: date Nov 30'], 'konan@manyfast.io', {}, convo).length, 1);
});

test('a cut greeting Seungjoo goes To konan@, not to Jun the billing contact (Manyfast x Chris, Nov 18)', async () => {
  const { greetedAddress, dropKnownContactFlags } = await import('../lib/outbox.js');
  const convo = '📨 2026-11-17 · brand (이승주 <konan@manyfast.io>) · Re: Paid Reel\nHi Chris and team,\nPlease keep all content and production communication here with me.\n\nBest,\nSeungjoo (Konan)\n\n📨 2026-11-17 · brand (Jun <jun@manyfast.io>) · Re: Paid Reel\nHere are our billing details.\nJun';
  const body = 'Hi Seungjoo,<br /><br />Here is the first video draft: https://f.io/x<br /><br />Best,<br />Chris\'s Team';
  assert.equal(greetedAddress(body, convo), 'konan@manyfast.io');
  assert.equal(greetedAddress('Hi team,', convo), null);
  // addressed to Jun but greeting Seungjoo: the flag stays
  assert.equal(dropKnownContactFlags(['Wrong person: addressed to Jun but it greets Seungjoo'], 'jun@manyfast.io', { brandEmail: 'jun@manyfast.io' }, convo, body).length, 1);
  assert.equal(dropKnownContactFlags(['Wrong person: addressed to Seungjoo but the latest message was from Jun'], 'konan@manyfast.io', { brandEmail: 'jun@manyfast.io' }, convo, body).length, 0);
});

test('the loop-in reply (Harsh\'s fixed wording) is not held for its own "straight away" line (Fotor x Duncan, night check Nov 18)', async () => {
  const { autoHoldReason, checkDraft } = await import('../lib/outbox.js');
  const { handoverAckText } = await import('../lib/inbox.js');
  const body = handoverAckText({ name: 'Zoey', brand: 'Fotor', creator: 'Duncan' });
  assert.ok(checkDraft({ body, creator: 'Duncan' }).issues.length > 0); // the filler check alone would hold it
  assert.equal(autoHoldReason({ body, creator: 'Duncan', why: "Loop-in reply: Duncan's team handed Fotor to us; confirming we take it from here and asking for the brief and contract" }), null);
  assert.ok(autoHoldReason({ body, creator: 'Duncan', why: 'Reply to the brand' }));
});

test('big attachments are fetched from Gmail parts by name; the card has no Source email section (Nov 19)', async () => {
  const { partsWithFiles, needsFetch } = await import('../lib/gmailfiles.js');
  const payload = { parts: [{ mimeType: 'text/plain', body: {} }, { filename: 'Influencer Brief - AI Video Fest (1).pdf', mimeType: 'application/pdf', body: { attachmentId: 'ANG', size: 168966 } }] };
  assert.deepEqual(partsWithFiles(payload).map((p) => p.filename), ['Influencer Brief - AI Video Fest (1).pdf']);
  assert.equal(needsFetch({ filename: 'a.pdf', size: 5e6 }), true);
  assert.equal(needsFetch({ filename: 'a.pdf', size: 5e6, data: 'x' }), false);
  const { pageBody } = await import('../lib/briefs.js');
  const blocks = pageBody({ x: { summary: ['A point'] }, email: { from: 'Karan <k@e.sh>', subject: 'S', date: 'D' }, links: [], uploads: [], docText: '' });
  assert.ok(!JSON.stringify(blocks).includes('Source email'));
});

// System check, Nov 19: Emergent x Chris, a campaign brief PDF whose email said the formal agreement comes later was filed
// as a contract and the auto "thanks for sending the contract, we'll sign it" reply went out
test('a brief that says the agreement comes later is not a contract', async () => {
  const { contractIn } = await import('../lib/inbox.js');
  const pdf = [{ filename: 'AI Video Fest - Creator Guidelines.pdf', mimeType: 'application/pdf', data: 'x' }];
  assert.equal(contractIn({ text: 'Hi Team, please find the campaign details attached. Once you confirm the intent to go live on 23rd Nov, I will share the formal agreement for signature.', attachments: pdf }), null);
  assert.equal(contractIn({ text: 'The attached document is the campaign brief, not the final contract.', attachments: pdf }), null);
  // a real contract still counts
  assert.ok(contractIn({ text: 'Please find the agreement attached for signature.', attachments: pdf }));
  assert.ok(contractIn({ text: 'Contract attached, please sign.', attachments: [{ filename: 'Agreement_Kylon.pdf', mimeType: 'application/pdf' }] }));
});

test('a brand email that asks something stays unread when nothing was sent or drafted (Harsh, Nov 19)', async () => {
  const { keepUnread } = await import('../lib/inbox.js');
  assert.equal(keepUnread({ needs_reply: true }, 'Deal memory updated'), true);
  assert.equal(keepUnread({ we_owe: 'Confirm the publishing date' }, 'Stage set'), true);
  assert.equal(keepUnread({ needs_reply: true }, 'Sent the fixed reply "video_eta"'), false);
  assert.equal(keepUnread({ needs_reply: true }, 'Brief updated · reply drafted'), false);
  assert.equal(keepUnread({ needs_reply: false, we_owe: null }, 'thanks noted'), false);
});

test('publish_date_confirm uses the card POST DATE and nothing else (Luma x Chris, Nov 19)', async () => {
  const { BUILT_IN, fillTemplate, fmtDay } = await import('../lib/replytemplates.js');
  const t = BUILT_IN.find((x) => x.key === 'publish_date_confirm');
  assert.equal(fmtDay('2026-11-21'), 'Saturday, November 21');
  const b = fillTemplate(t.body, { from: 'Upendra Singh <upendra@njagency.co>', deal: { creator: 'Chris' }, postDate: 'Saturday, November 21' });
  assert.match(b, /^Hi Upendra,/);
  assert.match(b, /goes live on Saturday, November 21/);
  assert.ok(!/\{post_date\}/.test(b));
});

test('one send per draft: a fresh claim from another send blocks a second send (Luma x Chris, Nov 19)', async () => {
  const { sendClaimState, claimText } = await import('../lib/outbox.js');
  const now = Date.now();
  assert.equal(sendClaimState('', 'abc', now), 'free');
  assert.equal(sendClaimState('n8n returned 500', 'abc', now), 'free');
  assert.equal(sendClaimState(claimText('abc', now - 1000), 'abc', now), 'mine');
  assert.equal(sendClaimState(claimText('xyz', now - 1000), 'abc', now), 'taken');
  assert.equal(sendClaimState(claimText('xyz', now - 1000), undefined, now), 'taken');
  assert.equal(sendClaimState(claimText('xyz', now - 4 * 60 * 1000), 'abc', now), 'free');
});

test('an image-only brand email is read from its picture (Katlas receipt for Dreamina x Chris, Nov 19)', async () => {
  const { messageImages } = await import('../lib/inbox.js');
  const text = '[cid:2106b540]\n________________________________\nFrom: noocap collab <noocapcollab@gmail.com>\nSent: Wednesday, 18 November 2026 21:07\nSubject: Re: Paid Collaboration with Dreamina\n\nHey Katlas,\n\nHere\'s 9 Digit ACH Routing number 211370150\n\nThank you\n';
  const img = { filename: 'Outlook-zi1nnziv.jpg', mimeType: 'image/jpg', data: Buffer.alloc(40000).toString('base64') };
  const got = messageImages({ text, attachments: [img, { filename: 'logo.png', mimeType: 'image/png', data: Buffer.alloc(2000).toString('base64') }] });
  assert.equal(got.length, 1);
  assert.equal(got[0].mimeType, 'image/jpeg');
  assert.equal(messageImages({ text: 'Hi team, '.repeat(40), attachments: [img] }).length, 0);
});

test('a Zoho-quoted brand email is answered from its newest message only (CapCut x Brad, Nov 19)', async () => {
  const { latestPart, brandAsks, asksForDate } = await import('../lib/briefs.js');
  const text = 'Hi there,\n\nJust checking in to see if the video can be produced within this week or the next. If not please tell us your earliest timeline for the video.\n\nBest regards,\nAlisa\n\n---- On Tue, 17 Nov 2026 11:35:29 +0800 Alisa <alisa@globeinflu.com> wrote ---\n\nHi there,\n\nWould it be possible to continue with the original brief for Brad instead?\n';
  const latest = latestPart(text);
  assert.ok(!/original brief/.test(latest));
  const asks = brandAsks(latest);
  assert.ok(asks.length >= 1);
  assert.ok(asks.some(asksForDate));
  assert.ok(!asks.some((q) => /original brief/.test(q)));
  // a closing line is not an ask
  assert.equal(brandAsks('Here is the brief. Let us know if you have any questions.').length, 0);
  assert.ok(!/original brief/.test(latestText(text)));
  assert.ok(!/旧/.test(latestPart('Thanks!\n发件人: Cassie <x@y.com>\n旧')));
});

test('only the newest queued WhatsApp ask per deal goes out (Luma x Chris, Nov 19)', async () => {
  const { oneQueuedAskPerDeal } = await import('../lib/whatsapp.js');
  const msgs = [
    { meta: 'pending-ask', at: '2026-11-19T07:34:37Z', infoAsk: { dealId: 'luma' } },
    { meta: 'pending-ask', at: '2026-11-19T07:37:58Z', infoAsk: { dealId: 'luma' } },
    { meta: 'pending-ask', at: '2026-11-19T09:18:52Z', infoAsk: { dealId: 'capcut' } },
  ];
  oneQueuedAskPerDeal(msgs);
  assert.deepEqual(msgs.map((m) => m.meta), ['stale-ask', 'pending-ask', 'pending-ask']);
});

test('"null" from the model is never a Next Action (SpeakOn x Chris, Nov 19)', async () => {
  const { ourAskText } = await import('../lib/inbox.js');
  assert.equal(ourAskText('null'), null);
  assert.equal(ourAskText('Waiting for null'), null);
  assert.equal(ourAskText(null), null);
  assert.equal(ourAskText('Cassie to approve the updated script'), 'Cassie to approve the updated script');
});

test('a video is ready for the brand 4 days before its publish deadline (CapCut x Lindsay, Nov 19)', async () => {
  const { readyBy } = await import('../lib/briefs.js');
  const r = readyBy('2026-11-27');
  assert.equal(r.ready, '2026-11-23');
  assert.equal(r.readyLabel, 'Monday, November 23');
  assert.equal(readyBy(''), null);
});

test('a Stripe payment gives Harsh a note to forward to the creator (Harsh, Nov 19)', async () => {
  const { paidForwardText } = await import('../lib/invoicing.js');
  const t = paidForwardText({ brand: 'Manyfast', creator: 'Duncan' }, { amount_paid: 160000, number: 'INV-005', customer_name: 'Slate Media Co., Ltd.', status_transitions: { paid_at: Date.parse('2026-11-18T06:00:00Z') / 1000 }, hosted_invoice_url: 'https://invoice.stripe.com/x' }, 'extra');
  assert.match(t, /Payment received: Manyfast × Duncan/);
  assert.match(t, /Hi Duncan, Manyfast's payment of \$1,600 .* November 18 \(invoice INV-005, paid by Slate Media Co\., Ltd\.\)/);
  assert.match(t, /Paid invoice: https:\/\/invoice\.stripe\.com\/x/);
  assert.ok(!/Forward this to/.test(t));
});

test('a payment Stripe confirms gets the fixed thank-you, no ask to Harsh (Harsh, Nov 19)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(src, /export async function paymentThanks/);
  assert.match(src, /fromBrand && \(stripePaid \|\| proof\.length\)\) \{ try \{ rev \+= ` · \$\{await paymentThanks\(deal, email\)\}`/);
  const inv = fs.readFileSync(new URL('../lib/invoicing.js', import.meta.url), 'utf8');
  assert.match(inv, /\^Brand says it paid/);
  const { templateBlock } = await import('../lib/replytemplates.js');
  assert.equal(templateBlock({ active: true, stages: ['Paid'] }, { stage: 'Paid', today: '2026-11-19', sentRecently: false }), '');
  assert.match(templateBlock({ active: true, stages: ['Paid'] }, { stage: 'Paid', today: '2026-11-19', sentRecently: 'sent' }), /already went/);
});

test('a brand saying it paid, written into the deal memory, is not payment proof (ElevenLabs x Duncan, Nov 19)', async () => {
  const { earlierProof } = await import('../lib/inbox.js');
  const mem = 'HISTORY: 2026-11-02 brand confirmed invoice submitted to finance. 2026-11-19 brand stated finance confirmed invoice paid.<br /><br />BILLING: Invoice sent 2026-10-30. Brand states invoice paid as of 2026-11-19.';
  assert.equal(earlierProof(mem, '', '2026-10-30'), false);
  assert.equal(earlierProof('2026-11-20 brand sent the transfer confirmation (receipt attached)', '', '2026-10-30'), true);
});

test('a wrapped "wrote:" line and a broken-up link never become the brand\'s question (Fotor x Duncan, Luma AI x Lindsay, Nov 19)', async () => {
  const { latestPart, brandAsks } = await import('../lib/briefs.js');
  // Gmail wrapped "wrote:" onto its own line, so our quoted "Could you share the brief" was picked as Fotor's question
  const fotor = 'Hi Duncan\'s Team,\n\nThanks so much!\nDeliverables: 1 dedicated video.\n\nBest,\nZoey | Fotor Team\n\nOn Thu, Nov 19, 2026 at 4:20 PM noocap collab <noocapcollab@gmail.com>\nwrote:\n\n> Hi Zoey,\n>\n> Could you share the brief and the contract in this thread? Once we have\n> them, we\'ll start on the script straight away.\n';
  const latest = latestPart(fotor);
  assert.ok(!/Could you share/.test(latest));
  assert.equal(brandAsks(latest).length, 0);
  // a quoted line is never the brand's own question, even without an "On … wrote" header
  assert.equal(brandAsks('Thanks!\n> Could you share the brief and the contract in this thread?').length, 0);
  // a Google link wrapped across two lines left "d/12PP…/edit?" behind as a "question"
  const luma = 'Hey Team,\n\nHere\'s the content brief: https://docs.google.com/presentation/\nd/12PPK0Sgf1dHRyuYwsDI5xxdnH8jPZRSF-sPLC7BvwV0/edit?usp=drivesdk\n\nPlease review it and share your script for approval.\n';
  assert.ok(!brandAsks(latestPart(luma)).some((q) => /edit\?|\/d\//.test(q)));
  // real questions still count
  assert.equal(brandAsks('Thanks for the update. When can we expect the script?').length, 1);
});

test('a retired Gemini model (404) is skipped, not the end of the chain (Leads email failed, system check Nov 19)', async () => {
  const { MODEL_CHAIN, tryNextModel } = await import('../lib/gemini.js');
  assert.ok(!MODEL_CHAIN().includes('gemini-2.5-flash-lite'));
  assert.equal(tryNextModel(404), true);
  assert.equal(tryNextModel(429), true);
  assert.equal(tryNextModel(400), false);
});

test('a bare "Okay" on WhatsApp is not the answer to a brand\'s ask (Vmake AI x Lindsay, system check Nov 19)', async () => {
  const fs = await import('node:fs');
  const { isBareAck } = await import('../api/whatsapp.js');
  for (const t of ['Okay', 'ok', 'OK.', 'noted', 'got it', '👍', 'Thanks!']) assert.equal(isBareAck(t), true, t);
  for (const t of ['ok the code is ABC123', 'lindsay@example.com', 'okay send the contract to Vmake', '']) assert.equal(isBareAck(t), false, t);
  const wa = fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8');
  const fn = wa.slice(wa.indexOf('async function answerInfoAsk'), wa.indexOf('async function answerInfoAsk') + 1800);
  assert.match(fn, /if \(!file && isBareAck\(text\)\) \{ await say\(/);
  assert.ok(fn.indexOf('isBareAck') < fn.indexOf('writeEmail'));
});

test('a brand\'s "we paid" on a deal Stripe already marked Paid sends no second WhatsApp (ElevenLabs x Duncan, system check Nov 19)', async () => {
  const fs = await import('node:fs');
  const { paidAlready } = await import('../lib/inbox.js');
  assert.equal(paidAlready({ stage: 'Paid', paidDate: '2026-11-19' }), true);
  assert.equal(paidAlready({ stage: 'Invoiced', paidDate: '' }), false);
  assert.equal(paidAlready({ stage: 'Paid', paidDate: '' }), false);
  const src = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  const c = src.slice(src.indexOf("case 'payment_confirmed': {"), src.indexOf("case 'payment_confirmed': {") + 2500);
  assert.match(c, /if \(paidAlready\(deal\)\) \{ await patchDeal\(deal, \(set\) => common\(set\)\); did = [^;]+; break; \}/);
  assert.ok(c.indexOf('paidAlready(deal)') < c.indexOf('stripeState'));
});

test('a contract the brand sends is never treated as our signed copy (Fotor x Duncan, Nov 20)', async () => {
  const { signedBack } = await import('../lib/inbox.js');
  assert.equal(signedBack({ from_role: 'brand', delivers: ['signed contract'] }), false);
  assert.equal(signedBack({ from_role: 'noocap', delivers: ['contract'] }), true);
  assert.equal(signedBack({ from_role: 'creator', delivers: ['signed contract'] }), true);
});

test('deals paid upfront reach the script step (Manyfast x Duncan, Nov 20)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(src, /const ordered = \[\.\.\.upfrontPaid,/);
  assert.match(src, /if \(deal\.upfrontOnly\) continue;/);
});

test('a card back at 5 with a new script version goes again; an unchanged one does not (CapCut x Chris, Nov 20)', async () => {
  const { revisedCards } = await import('../lib/heartbeat.js');
  const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
  const cards = [{ id: a, num: 5, title: 'CapCut × Chris (2)' }, { id: b, num: 5, title: 'CapCut × Chris (3)' }, { id: c, num: 12, title: 'CapCut × Chris' }];
  const vers = { sent: new Map([[a, '111111111111'], [b, '222222222222'], [c, '333333333333']]), pending: new Set() };
  const cur = { [a]: '999999999999', [b]: '222222222222', [c]: '000000000000' };
  assert.deepEqual(revisedCards(cards, vers, cur).map((x) => x.title), ['CapCut × Chris (2)']);
  assert.deepEqual(revisedCards(cards, { ...vers, pending: new Set([a]) }, cur), []);
  assert.deepEqual(revisedCards(cards, { sent: new Map(), pending: new Set() }, cur), []);
});

test('a card back at 5 after Script Changes goes again as a revised script (Harsh, Nov 20)', async () => {
  const { changedSinceSent } = await import('../lib/heartbeat.js');
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const cards = [{ id: a, num: 5, title: 'CapCut × Lindsay (1)' }, { id: b, num: 5, title: 'CapCut × Lindsay (2)' }];
  const vers = { sentAt: new Map([[a, '2026-11-18T10:00:00Z'], [b, '2026-11-18T10:00:00Z']]), pending: new Set() };
  const marks = new Map([[a, '2026-11-19T22:00:00Z'], [b, '2026-11-17T09:00:00Z']]);
  assert.deepEqual(changedSinceSent(cards, vers, marks).map((c) => c.title), ['CapCut × Lindsay (1)']);
  assert.deepEqual(changedSinceSent(cards, { ...vers, pending: new Set([a]) }, marks), []);
});

test('a card whose script already went from another deal of the same brand is not owed again (Runway AI x Chris, Nov 20)', async () => {
  const { cardsScriptedElsewhere } = await import('../lib/heartbeat.js');
  const nov = '41b508e99dda814dbc98cd2aa2c91bf4';
  const row = (st, video, ctx = '') => ({ properties: { Status: { type: 'select', select: { name: st } }, Video: { url: video }, Context: { rich_text: [{ plain_text: ctx }] } } });
  const rows = [row('Sent', `https://app.notion.com/p/Runway-AI-Chris-${nov}`, `fp ${nov}=a282c58a7c59`)];
  assert.equal(cardsScriptedElsewhere(rows).has(nov), true);
  assert.equal(cardsScriptedElsewhere([row('Rejected', `https://app.notion.com/p/Runway-AI-Chris-${nov}`)]).has(nov), false);
  assert.equal(cardsScriptedElsewhere([row('Draft', null, `Script cards: https://app.notion.com/p/x-${nov}`)]).has(nov), true);
});

test('"wireframe" in cut feedback is not a bank-transfer ask (Manyfast x Chris, Nov 20)', async () => {
  const { asksOtherPayment } = await import('../lib/invoiceguard.js');
  assert.equal(asksOtherPayment('The wireframe-to-finished-UI transition and Favorites demonstration are much clearer. Around 16 seconds, the caption still says "cloud code."'), null);
  assert.equal(asksOtherPayment('Give the wireframe and finished prototype a little more screen time.'), null);
  assert.equal(asksOtherPayment('We can only pay by wire transfer, please send your bank details.'), 'Bank transfer');
  assert.equal(asksOtherPayment('Can we pay via PayPal instead?'), 'PayPal');
});

// System check Nov 20 (CapCut x Brad): the inbox asked Pratham about Alisa's chase, then the "we owe" sweep asked the
// same thing 7 minutes later. The inbox now writes the sweep's own mark, so the two must agree for one brand email.
test('the inbox and the owed sweep share one "already asked" mark per brand email', async () => {
  const { owedMark, owedItem } = await import('../lib/owed.js');
  const { istStamp } = await import('../lib/tools.js');
  const id = '3ff508e9-9dda-81eb-a238-e614f2a1ecba';
  const emailAt = Date.parse('2026-11-20T07:05:00Z');
  const inboxMark = owedMark(id, istStamp(emailAt));
  const deal = { id, brand: 'CapCut', creator: 'Brad', stage: 'Submitted', lastBrand: istStamp(emailAt), lastOur: '2026-11-16T14:54:00+05:30', memory: "OPEN NOW: We owe: Brad's earliest timeline for the video" };
  const item = owedItem(deal, '2026-11-20');
  assert.ok(item);
  assert.equal(owedMark(id, item.since), inboxMark);
  // late evening UTC is the next day in IST: both sides use the IST day
  assert.equal(owedMark(id, istStamp(Date.parse('2026-11-20T20:00:00Z'))), `${id} 2026-11-21`);
});

// System check Nov 20 (Manyfast x Duncan, paid 100% upfront): Seungjoo's script notes were made into an UPDATED SCRIPT
// on the card, back at 5, but the revised script never went: a Paid deal with a Script Sent Date left the script step.
test('a deal paid upfront stays in the script step until its video posts, so a revised script goes', async () => {
  const { upfrontScriptDeal } = await import('../lib/heartbeat.js');
  const deal = { stage: 'Paid', linkedVideo: 'https://notion.so/x', paidDate: '2026-11-18', scriptSent: '2026-11-20', postedLinks: '' };
  assert.equal(upfrontScriptDeal(deal, 2), true);
  assert.equal(upfrontScriptDeal({ ...deal, postedLinks: 'https://instagram.com/p/1' }, 2), false);
  assert.equal(upfrontScriptDeal({ ...deal, stage: 'Invoiced' }, 2), false);
  assert.equal(upfrontScriptDeal(deal, 45), false);
});
test('the script PDF starts at the newest "updated script" heading, never sending the old and new script together', async () => {
  const { scriptStart } = await import('../lib/pdf.js');
  assert.equal(scriptStart([null, 'Script', null, null, 'UPDATED SCRIPT:', null]), 4);
  assert.equal(scriptStart(['📋 Brief from Manyfast', 'Script', null]), 1);
  assert.equal(scriptStart(['✅ Approved script (2026-11-20)', 'Script', null]), 0);
  assert.equal(scriptStart([null, null]), -1);
});

test('the Gemini fallback notice checks the shared log, not just memory (Harsh, Nov 20: #pm-alerts spam)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/claude.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!\(await claimOnce\(NOTICE_EVENT, 6/);
});

test('only one PM copy wins an alert claim: earliest row, ties to the smallest id (Harsh, Nov 20: 5 notices at once)', async () => {
  const { winnerOf } = await import('../lib/briefs.js');
  const t = '2026-11-20T10:12:00.000Z';
  assert.equal(winnerOf([{ id: 'c', created_time: t }, { id: 'a', created_time: t }, { id: 'b', created_time: t }]), 'a');
  assert.equal(winnerOf([{ id: 'a', created_time: '2026-11-20T10:13:00.000Z' }, { id: 'z', created_time: t }]), 'z');
  assert.equal(winnerOf([{ id: 'a', created_time: t, in_trash: true }, { id: 'b', created_time: t }]), 'b');
  assert.equal(winnerOf([]), null);
});

test('a dropped draft is not rewritten until a new email lands (Harsh, Nov 20: Manyfast invoice drafted 3 nights)', async () => {
  const { droppedBlocks } = await import('../lib/outbox.js');
  const rej = { created_time: '2026-11-19T00:17:00.000Z', last_edited_time: '2026-11-19T00:20:00.000Z', properties: { Error: { rich_text: [{ plain_text: 'Auto-rejected by system check: repeats' }] } } };
  const now = Date.parse('2026-11-20T00:17:00.000Z');
  assert.equal(droppedBlocks([rej], { lastEmail: ['2026-11-17T10:00:00+05:30', null], now }), true);
  assert.equal(droppedBlocks([rej], { lastEmail: ['2026-11-19T12:00:00+05:30'], now }), false);
  assert.equal(droppedBlocks([rej], { now }), false); // old rule without email dates: auto-reject blocks 24h only
});

test('a brand question is asked on WhatsApp, never answered by an AI draft first (Harsh, Nov 20)', async () => {
  const fs = await import('node:fs');
  const b = fs.readFileSync(new URL('../lib/briefs.js', import.meta.url), 'utf8');
  const i = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.doesNotMatch(b, /Check the answer\$\{/);
  assert.doesNotMatch(i, /Needs you: \$\{deal\.brand\} asked: /);
  assert.match(i, /question asked on WhatsApp/);
});

test('a loop-in reply asks only for what the thread is still missing (Topview x Lindsay, Nov 20)', async () => {
  const { handoverAckText, handoverHas } = await import('../lib/inbox.js');
  const has = handoverHas({ text: "Here's the brief with more details: https://app.notion.com/p/topviewguide/IG-TT-Collaboration-Brief-x" });
  assert.deepEqual(has, { briefShared: true, contractShared: false });
  const t = handoverAckText({ name: 'Limsuwern', brand: 'Topview AI', creator: 'Lindsay', ...has });
  assert.match(t, /Could you share the contract in this thread\?/);
  assert.doesNotMatch(t, /brief and the contract/);
  assert.match(handoverAckText({ brand: 'X', creator: 'Chris' }), /share the brief and the contract/);
  assert.equal(handoverHas({ text: 'hi', attachments: [{ filename: 'Agreement.pdf' }] }).contractShared, true);
});

test('a held loop-in still gets its deal opened, never a reply (Harsh, Nov 20: Topview x Lindsay)', async () => {
  const { heldNeedsDeal } = await import('../lib/inbox.js');
  const email = { threadId: 't1', from: 'collab <collab@automateaiconsulting.com>', to: 'limsuwern@topview.ai', cc: 'noocapcollab@gmail.com', text: 'We are adding noocapcollab@gmail.com in the thread. My team can take it over from here.' };
  const x = { from_role: 'creator', brand: 'Topview AI' };
  assert.equal(heldNeedsDeal(email, x, { threadId: 'other' }), true); // matched to Chris's old Topview deal: still opens Lindsay's
  assert.equal(heldNeedsDeal(email, x, { threadId: 't1' }), false); // this thread already has its deal
  assert.equal(heldNeedsDeal(email, { from_role: 'brand', brand: 'X', deal_stage: 'Negotiating' }, null), false); // leads stay with management
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8'), /I wrote nothing to the brand/);
});

test('cheap jobs run on Gemini light models, brand emails stay on Claude (Harsh, Nov 20)', async () => {
  const { routeOf } = await import('../lib/claude.js');
  const { LITE_CHAIN } = await import('../lib/gemini.js');
  assert.equal(routeOf('inbox'), 'claude');
  assert.equal(routeOf('drafts'), 'claude');
  assert.equal(routeOf('whatsapp'), 'claude');
  assert.equal(routeOf('leads'), 'gemini-only');
  assert.equal(routeOf('memory'), 'gemini-only');
  assert.equal(routeOf('wiki'), 'gemini-only');
  assert.equal(routeOf('second-read'), 'gemini-then-claude');
  assert.ok(LITE_CHAIN().every((m) => /lite/.test(m)), 'cheap jobs never use the Flash quota kept for Claude\'s backup');
});

test('an email over 36 hours old on a tracked deal is recorded without AI', async () => {
  const { oldTrackedEmail } = await import('../lib/inbox.js');
  const now = Date.parse('2026-11-20T12:00:00Z');
  const deals = [{ id: 'd', threadId: 't1', brand: 'B' }];
  assert.equal(oldTrackedEmail({ threadId: 't1', date: '2026-11-18T10:00:00Z' }, deals, now)?.id, 'd');
  assert.equal(oldTrackedEmail({ threadId: 't1', date: '2026-11-20T10:00:00Z' }, deals, now), null);
  assert.equal(oldTrackedEmail({ threadId: 't9', date: '2026-11-18T10:00:00Z' }, deals, now), null);
});

test('a lead email waiting on Gemini\'s free quota is retried, never given up on', async () => {
  const { AI_DOWN } = await import('../api/leads.js');
  assert.match("leads runs on Gemini's free tier and it is unavailable now (Gemini 429 (gemini-flash-lite-latest): quota); retried later", AI_DOWN);
});

test('a brand-new creator-inbox email is sorted by Claude, lead-thread follow-ups and our own emails by Gemini (Harsh, Nov 20)', async () => {
  const { leadJob } = await import('../lib/leads.js');
  const { routeOf } = await import('../lib/claude.js');
  assert.equal(routeOf(leadJob({})), 'claude');
  assert.equal(routeOf(leadJob({ known: true })), 'gemini-only');
  assert.equal(routeOf(leadJob({ ours: true })), 'gemini-only');
});

test('while Claude is paused every AI call goes straight to Gemini (Harsh, Nov 20: Gemini only until Dec 1)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/gemini.js', import.meta.url), 'utf8');
  assert.match(src, /freeOnly\.getStore\(\) \|\| anthropicPaused\(\)\) && hasGemini\(\)/);
});

test('the same contract reaches WhatsApp once, however many emails carry it (Runway x Chris, Nov 20)', async () => {
  const { contractKey } = await import('../lib/inbox.js');
  const a = contractKey({ links: ['https://agreements.houseofmarketers.com/sign/jPJbLWueqtiqD5a1BeXyQ'] }, { threadId: 't1' });
  const b = contractKey({ links: ['https://agreements.houseofmarketers.com/sign/jPJbLWueqtiqD5a1BeXyQ?utm=mail'] }, { threadId: 't2' });
  assert.equal(a, b);
  assert.equal(contractKey({ files: [{ filename: 'Agreement.pdf' }] }, { threadId: 't1' }), 't1:agreement.pdf');
  assert.equal(contractKey({}, {}), '');
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8'), /contract already sent to WhatsApp, not sent again/);
});

test('a contract in a creator\'s own inbox reaches WhatsApp too, once (Noxinfluencer x Chris, Nov 20)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/leads.js', import.meta.url), 'utf8');
  assert.match(src, /else if \(CREATOR_INBOX_CONTRACTS\) \{/);
  const { CREATOR_INBOX_CONTRACTS } = await import('../lib/leads.js');
  assert.equal(CREATOR_INBOX_CONTRACTS, false, 'Harsh, Nov 21: only noocapcollab contracts are shared for now');
  const { contractWhatsApp } = await import('../lib/inbox.js');
  assert.equal(typeof contractWhatsApp, 'function');
});

test('a signed contract naming the deal\'s creator, for a contract the brand is waiting on, needs no brand name (Luma AI x Lindsay, Nov 21)', async () => {
  const { contractChecks } = await import('../lib/contracts.js');
  const deal = { id: 'd1', brand: 'Luma AI', creator: 'Lindsay', brandEmail: 'upendra@njagency.co', threadId: 't1', stage: 'Signed' };
  const text = 'CONTENT CREATION AGREEMENT between NJ AGENCY and Lindsay Gonzales ("Creator") promoting Luma';
  assert.deepEqual(contractChecks(deal, { caption: 'here you go', filename: 'Lindsay_Gonzales_Content_Creation_Agreement (signed).pdf', text, openRows: [{ dealIds: ['d1'] }] }), []);
  // no contract waiting from the brand: still asks
  assert.ok(contractChecks(deal, { caption: 'here you go', filename: 'x.pdf', text, openRows: [] }).length > 0);
  // the text names another creator: still a hard stop
  const chrisDeal = { ...deal, creator: 'Chris' };
  assert.ok(contractChecks(chrisDeal, { caption: 'here you go', filename: 'x.pdf', text, openRows: [{ dealIds: ['d1'] }] }).some((w) => /contract is for/.test(w)));
});

test('a contract sent by an agency platform is named after the brand in the subject (Renoise via Noxinfluencer, Nov 21)', async () => {
  const { contractBrand } = await import('../lib/contracttrack.js');
  assert.equal(contractBrand({ subject: 'Re: [Renoise] Instagram Content Collaboration Proposal', from: '"Helen" <renoise@net.noxinfluencer.com>' }), 'Renoise');
  assert.equal(contractBrand({ subject: 'Agreement', from: 'may@atoms.dev' }), 'Atoms');
});

test('a swipe-reply naming the brand on "which brand?" sends the signed contract, never a draft (Luma AI x Lindsay, Nov 21)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/whatsapp.js', import.meta.url), 'utf8');
  const ask = src.indexOf("replyTo?.meta === 'contract-ask' && replyTo.file");
  const info = src.indexOf('else if (infoAskFor(st, replyTo, text)');
  assert.ok(ask > 0 && ask < info, 'the contract answer is checked before older brand questions');
  assert.ok(src.indexOf("m.type === 'document' && await signedContract(") < info, 'a dropped contract is checked before older brand questions');
  assert.ok(src.indexOf('pendingContract(st) && await signedContract(') < info, 'the brand name for a waiting contract too');
  assert.match(src, /meta: hard \? 'contract-done' : 'contract-ask', file: hard \? undefined : file, wid: sentId\(sentAsk\)/);
});

test('a cut reaches the brand even with no AI: the fixed cut email is used (Harsh, Nov 21)', async () => {
  const { plainCutBody, greetingFor } = await import('../lib/brandsend.js');
  assert.equal(greetingFor('kepan@katlasmedia.com'), 'Hi Kepan,');
  assert.equal(greetingFor('outreach@katlasmedia.com'), 'Hi,');
  assert.equal(plainCutBody(greetingFor('anita@arch.agency'), 'https://f.io/x', 'Chris', false), "Hi Anita,\n\nHere is the cut for your review: https://f.io/x\n\nBest,\nChris's Team");
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../lib/brandsend.js', import.meta.url), 'utf8'), /cut email writer down, fixed text used/);
});

test('a 7- In Edit row with an editor on Harsh\'s own board is sent to the editor (Harsh, Nov 21: MCP COOKED to Prabal; board now uses the numbered statuses)', async () => {
  const { wantsEditor } = await import('../lib/harshboard.js');
  const row = (status, editor) => ({ properties: { Status: { status: { name: status } }, Editor: { select: editor ? { name: editor } : null } } });
  assert.equal(wantsEditor(row('7- In Edit', 'PRABAL')), true);
  assert.equal(wantsEditor(row('7- In Edit', null)), false);
  assert.equal(wantsEditor(row('4- Script Draft', 'PRABAL')), false);
});

test('preflight holds made-up creator details and auto emails carrying legal details (Topview x Lindsay, Nov 21)', async () => {
  const { preflight } = await import('../lib/preflight.js');
  const body = "Hi Su Wern,\n\nAttached is the script for the campaign.\n\nRegarding the agreement, here are Lindsay's details:\n\nBusiness Name: Lindsay Creative LLC\nLegal Name: Lindsay Smith\nLegal Address: 123 Maple Street, Suite 400, Los Angeles, CA 90001\nContact Email: lindsay@noocap.com\n\nBest,\nLindsay's Team";
  const r = preflight({ kind: 'Script', to: 'limsuwern@topview.ai', replyTo: '<a@topview.ai>', threadId: '1a1f8b27a70d5c97', subject: 'Re: Collaboration: Topview AI', body }, null);
  assert.ok(r.hold.length, 'the made-up details must hold the email');
  const real = "Hi Su Wern,\n\nHere are the details for the agreement.\n\nLegal Name: Lindsay Gonzales\nContact Email: lindsay@automateaiconsulting.com\n\nBest,\nLindsay's Team";
  assert.ok(preflight({ kind: 'Script', to: 'x@b.com', replyTo: '<a@b.c>', subject: 'Re: x', body: real }, null).hold.length, 'a script email never carries legal details');
  assert.equal(preflight({ kind: 'Other', to: 'x@b.com', replyTo: '<a@b.c>', subject: 'Re: x', body: real }, null).hold.length, 0, 'a reply made from Harsh can carry real details');
  assert.equal(preflight({ kind: 'Script', to: 'x@b.com', replyTo: '<a@b.c>', subject: 'Re: x', body: 'Hi Su Wern,\n\nAttached is the script for the campaign. Let us know your feedback.\n\nBest,\nLindsay\'s Team' }, null).hold.length, 0);
});

test('hashtag-only notes on an approved reel are not video changes (Dreamina x Chris, Nov 18)', async () => {
  const { hashtagOnly } = await import('../lib/inbox.js');
  assert.equal(hashtagOnly('Revise the hashtags to: #Dreamina #MarketingStudio #HireDreamina #Seedance #DreaminaPartner'), true);
  assert.equal(hashtagOnly('Around 16 seconds, the caption still says "cloud code." Please change this to "Claude Code."'), false);
  assert.equal(hashtagOnly('Please add the watermark to the upper right corner and use #Dreamina in the caption'), false);
  assert.equal(hashtagOnly('Less B-roll and more screen recordings'), false);
});

test('no billing reminder or payment chase over the brand\'s unanswered email (Dreamina x Chris, Nov 20)', async () => {
  const { brandWaitingOnUs } = await import('../lib/heartbeat.js');
  const now = Date.parse('2026-11-20T18:47:00Z');
  const deal = { lastBrand: '2026-11-18T14:12:00Z', lastOur: '2026-11-18T14:09:00Z' };
  assert.equal(brandWaitingOnUs(deal, 'Billing details', now), true);
  assert.equal(brandWaitingOnUs(deal, 'Payment chase', now), true);
  assert.equal(brandWaitingOnUs(deal, 'Follow-up', now), false);
  assert.equal(brandWaitingOnUs({ lastBrand: '2026-11-18T02:55:00Z', lastOur: '2026-11-18T11:58:00Z' }, 'Payment chase', now), false);
  assert.equal(brandWaitingOnUs({ lastBrand: '2026-11-10T10:00:00Z', lastOur: '2026-11-05T10:00:00Z' }, 'Payment chase', now), false, 'a past-due chase is not blocked forever');
});

// System check, Nov 21: commits 6b97eaf, e681588 and 73c992c were each reported BROKEN on a different set of writer
// cases although none touched the writer. A would-be regression is re-run once and only a second fail counts.
test('test bank: a regression that passes on its re-run is noise, a second fail is kept', async () => {
  const { confirmRegressions, compare } = await import('../lib/testbank.js');
  const cases = [{ id: 'a', everPassed: true }, { id: 'b', everPassed: true }, { id: 'c', everPassed: false }];
  const results = [{ id: 'a', fails: ['repeats the mistake'] }, { id: 'b', fails: ['repeats the mistake'] }, { id: 'c', fails: ['repeats'] }];
  const ran = [];
  const rerun = (c) => { ran.push(c.id); return c.id === 'a' ? { fails: [], got: 'ok' } : { fails: ['repeats again'] }; };
  const out = await confirmRegressions(cases, results, rerun);
  assert.deepEqual(ran.sort(), ['a', 'b']); // never-passed cases are not re-run
  const { regressions, stillBroken } = compare(cases, out);
  assert.deepEqual(regressions.map((r) => r.id), ['b']);
  assert.deepEqual(stillBroken.map((r) => r.id), ['c']);
  assert.equal(out.find((r) => r.id === 'a').id, 'a');
  // Past the deadline nothing is re-run and the fails stand
  const late = await confirmRegressions(cases, results, rerun, { deadline: Date.now() - 1 });
  assert.equal(compare(cases, late).regressions.length, 2);
});

// Topview AI x Lindsay, system check Nov 21: the tool-access draft greeted "Hi Lim" (Su Wern's family name) and replied to
// her first email of Nov 20 instead of her Nov 21 approval that carried the agreement.
test('tool access: greets the sign-off name and replies to the approval email itself', async () => {
  const { greetingName, toolAccessDeal } = await import('../lib/inbox.js');
  const text = 'Hi Lindsay’s Team,\n\nThe script looks good to go.\n\nBest Regards,\n\nSu Wern\n\nMarketing Manager\n\nM: +60 16 628 7982';
  assert.equal(greetingName('"Lim Su Wern" <limsuwern@topview.ai>', text), 'Su Wern');
  assert.equal(greetingName('Yulia Ivanova <yulia@kudosnarratives.com>', 'Thanks,\nYulia'), 'Yulia');
  const deal = { id: 'd', threadId: '1a1f8b27a70d5c97', messageRfc: '<1a1f8b8c261@topview.ai>' };
  assert.equal(toolAccessDeal(deal, { threadId: '1a1f8b27a70d5c97', messageId: '<1a1fc5db2a7@topview.ai>' }).messageRfc, '<1a1fc5db2a7@topview.ai>');
  assert.equal(toolAccessDeal(deal, { threadId: 'other-thread', messageId: '<x@y>' }).messageRfc, '<1a1f8b8c261@topview.ai>');
  assert.equal(toolAccessDeal(deal, {}).messageRfc, '<1a1f8b8c261@topview.ai>');
});

test('deals with a card at Script Approval go first in the deal loop (Harsh, Nov 21: scripts not getting sent)', async () => {
  const { scriptCardDeals } = await import('../lib/heartbeat.js');
  const deals = [{ brand: 'Fotor', creator: 'Duncan', linkedVideo: null }, { brand: 'Riverside', creator: 'Duncan', linkedVideo: 'https://app.notion.com/p/419508e99dda808d93a0c78a0cbf350c' }, { brand: 'Fotor', creator: 'Chris' }];
  const cards = [{ id: '419508e9-9dda-808d-93a0-c78a0cbf350c', creator: 'Duncan', title: 'whatever' }, { id: 'x', creator: 'Duncan', title: 'Fotor × Duncan' }];
  const got = scriptCardDeals(deals, cards).map((d) => `${d.brand}/${d.creator}`);
  assert.deepEqual(got, ['Fotor/Duncan', 'Riverside/Duncan']);
});

test('editor reminders: stage waits, halved at 2 days, urgent today/tomorrow (Harsh, Nov 21)', async () => {
  const { nudgeFor } = await import('../lib/editornudge.js');
  const now = Date.parse('2026-11-21T08:00:00Z'); // 13:30 IST
  const ago = (h) => new Date(now - h * 36e5).toISOString();
  // far go-live: assigned 13h ago -> editor only; 25h -> Harsh too
  let n = nudgeFor({ status: 'Assigned', assignedAt: ago(13), goLive: '2026-11-28' }, now);
  assert.equal(n.editor, true); assert.equal(n.harsh, false);
  n = nudgeFor({ status: 'Assigned', assignedAt: ago(25), goLive: '2026-11-28' }, now);
  assert.equal(n.harsh, true);
  n = nudgeFor({ status: 'Assigned', assignedAt: ago(5), goLive: null }, now);
  assert.equal(n.editor, false);
  // CTAs: 7h after approval -> editor
  n = nudgeFor({ status: 'To Post', approvedAt: ago(7), goLive: '2026-11-30' }, now);
  assert.equal(n.stage, 'cta'); assert.equal(n.editor, true); assert.equal(n.harsh, false);
  // 2 days out: halves, Harsh with the editor
  n = nudgeFor({ status: 'Changes', changesAt: ago(7), goLive: '2026-11-23' }, now);
  assert.equal(n.editor, true); assert.equal(n.harsh, true);
  // today: anything is behind, at once
  n = nudgeFor({ status: 'Claude running', startedAt: ago(3.2), goLive: '2026-11-21' }, now);
  assert.equal(n.urgent, true); assert.equal(n.editor, true); assert.equal(n.harsh, true);
  // just handed over: no ping yet, even for tomorrow (SAVED REELS, Nov 23: pinged 2 minutes after assignment)
  assert.equal(nudgeFor({ status: 'Assigned', assignedAt: ago(0.05), goLive: '2026-11-22' }, now), null);
  assert.equal(nudgeFor({ status: 'Claude running', startedAt: ago(0.2), goLive: '2026-11-21' }, now), null);
  // tomorrow after midday IST: editing is behind; CTA stage tomorrow is not
  n = nudgeFor({ status: 'Manual editing', startedAt: ago(4), goLive: '2026-11-22' }, now);
  assert.equal(n.urgent, true);
  assert.equal(nudgeFor({ status: 'To Post', approvedAt: ago(1), goLive: '2026-11-22' }, now), null);
  // waiting on Harsh or the brand: nothing
  assert.equal(nudgeFor({ status: 'In Review', goLive: '2026-11-21' }, now), null);
});

test('test bank: commits that do not touch email handling never start a run; runs batch up (Harsh, Nov 21: Gemini quota)', async () => {
  const { gateReason, EMAIL_FILES } = await import('../lib/testbank.js');
  const now = Date.parse('2026-11-21T13:00:00Z');
  const last = { at: '2026-11-21T08:00:00Z', commit: 'aaaaaaa', lessonAt: '2026-11-21T07:00:00Z' };
  assert.equal(gateReason({ last, commit: 'bbbbbbb', lessonAt: last.lessonAt, now, emailChange: false }), null);
  assert.equal(gateReason({ last, commit: 'bbbbbbb', lessonAt: last.lessonAt, now, emailChange: true }), 'commit');
  assert.equal(gateReason({ last: { ...last, at: '2026-11-21T11:30:00Z' }, commit: 'bbbbbbb', lessonAt: last.lessonAt, now, emailChange: true }), null);
  assert.equal(gateReason({ last: { ...last, at: '2026-11-21T09:00:00Z' }, commit: 'bbbbbbb', lessonAt: last.lessonAt, now, emailChange: null }), null);
  assert.equal(EMAIL_FILES.test('lib/inbox.js'), true);
  assert.equal(EMAIL_FILES.test('lib/editornudge.js'), false);
  assert.equal(EMAIL_FILES.test('lib/harshboard.js'), false);
});

test('"it\'s duncan" for a waiting contract picks the deal from the contract text among Duncan\'s deals (Nov 22)', async () => {
  const { dealFromCreatorAnswer } = await import('../lib/contracts.js');
  const deals = [{ brand: 'Luma AI', creator: 'Duncan', stage: 'Signed' }, { brand: 'Fotor', creator: 'Duncan', stage: 'Brief Received' }, { brand: 'Fotor', creator: 'Chris', stage: 'Script Sent' }];
  const r = dealFromCreatorAnswer("it's duncan", { filename: 'INFLUENCER AGREEMENT-thechriscordero.pdf', text: 'This agreement is between Chengdu Everimaging d/b/a Fotor and Duncan Rogoff' }, deals);
  assert.equal(r.deal.brand, 'Fotor'); assert.equal(r.deal.creator, 'Duncan');
  const none = dealFromCreatorAnswer("it's duncan", { text: 'agreement with some company' }, deals);
  assert.equal(none.deal, null); assert.equal(none.creator, 'Duncan'); assert.equal(none.options.length, 2);
  assert.equal(dealFromCreatorAnswer('hello', { text: 'Fotor' }, deals).creator, null);
});

// ---------- Topview AI x Lindsay, Nov 22: contract_ack promised a script that had already gone and been approved ----------
test('a fixed contract ack never promises a script the brand already has', async () => {
  const { dropSentScriptPromise } = await import('../lib/replytemplates.js');
  const ack = "Hi Lim,\n\nThanks for sending the contract over. We've received it and will review and sign it, and we'll share the script with you here in this thread.\n\nBest,\nLindsay's Team";
  const after = dropSentScriptPromise(ack, { stage: 'Script Approved', scriptSent: '2026-11-21' });
  assert.equal(/script/i.test(after), false);
  assert.match(after, /will review and sign it\.\n\nBest,/);
  // before the script went, the promise stays (Fotor x Duncan, Nov 20)
  assert.equal(dropSentScriptPromise(ack, { stage: 'Signed' }), ack);
  // a whole sentence about the script goes too
  assert.equal(dropSentScriptPromise("Hi Zoey,\n\nThanks, we've got it. We'll send the script here soon.\n\nBest,\nDuncan's Team", { scriptSent: '2026-11-21' }), "Hi Zoey,\n\nThanks, we've got it.\n\nBest,\nDuncan's Team");
});

// ---------- CapCut x Chris BD-67, Nov 19 and Nov 22: billing asked for a 3-video fee after video 1 only ----------
test('a multi-video deal is not invoiced while videos are still owed', async () => {
  const { partDue, videosStillOwed } = await import('../lib/invoicing.js');
  const capcut = { stage: 'Posted', deliverables: '3 short-form videos (signed contract, GrowMaxValue agency)', postedLinks: '',
    memory: 'BILLING: not yet<br /><br />OPEN NOW: We owe: revised third script and first draft of the second video.' };
  assert.equal(videosStillOwed(capcut), true);
  assert.equal(partDue(capcut, 'final', ''), false);
  // the brand asking for the invoice still makes it due
  assert.equal(partDue({ ...capcut, stage: 'Submitted', invoiceRequested: true }, 'final', ''), true);
  // all three reels live: due
  const done = { ...capcut, memory: 'OPEN NOW: Waiting on brand: payment', postedLinks: 'https://www.instagram.com/reel/A1/ https://www.instagram.com/reel/B2/ https://www.instagram.com/reel/C3/' };
  assert.equal(partDue(done, 'final', ''), true);
  // a single-video deal is untouched
  assert.equal(partDue({ stage: 'Posted', deliverables: '1 dedicated video', memory: 'We owe: the live link' }, 'final', ''), true);
});

test('videos owed by a deal: shorts/reels/videos counted, stories and syndication are not (Upfluence × Duncan, Nov 22)', async () => {
  const { videosOwed, cardsForDeal } = await import('../lib/missingcards.js');
  assert.equal(videosOwed('2x YouTube Shorts (syndicated to TikTok, Facebook, Instagram), 2x Instagram Stories (minimum 2 frames each)'), 2);
  assert.equal(videosOwed('1 Instagram Reel + 1 story'), 1);
  assert.equal(videosOwed('Three dedicated videos'), 3);
  assert.equal(videosOwed('one YouTube integration and 2 reels'), 3);
  assert.equal(videosOwed(''), 0);
  assert.deepEqual(cardsForDeal(['UPFLUENCE × DUNCAN 1', 'Fotor × Duncan', 'Random'], 'Upfluence'), ['UPFLUENCE × DUNCAN 1']);
});

test('"approved the second script" picks card 2, not the next card waiting (CapCut × Lindsay, Nov 20)', async () => {
  const { approvedScriptNumber, pickScriptCards } = await import('../lib/inbox.js');
  const mail = 'Our creative team has also approved the second script, so you can go ahead and start producing the second video. Regarding the third script, it still requires some revisions.';
  assert.equal(approvedScriptNumber(mail), 2);
  assert.equal(approvedScriptNumber('The second script has been approved'), 2);
  const cards = [{ title: 'CapCut × Lindsay', num: 7, url: 'c1' }, { title: 'CapCut × Lindsay (3)', num: 5, url: 'c3' }, { title: 'CapCut × Lindsay (2)', num: 5, url: 'c2' }];
  assert.equal(pickScriptCards(cards, mail)[0], 'c2');
});

// Nov 23 morning check: cut chases drafted on a weekend sat in Approvals until Monday because autopilot held every
// follow-up on New York weekends (Polar x Valeri, ZenBusiness x Lindsay, Flova x Duncan). Rule 50: cut chases excepted.
test('a cut chase sends on a weekend, other follow-ups wait for Monday', async () => {
  const { weekendHold } = await import('../lib/heartbeat.js');
  assert.equal(weekendHold('Follow-up', "No reply for 3 days at Submitted (waiting for the brand to review the video) (follow-up 4, until they answer). Harsh's rule: once a video is sent for approval, we follow up every 3 days"), false);
  assert.equal(weekendHold('Follow-up', 'Rewritten by system check: this one only chases the revised cut (cut chases run every 3 days, weekends included).'), false);
  assert.equal(weekendHold('Follow-up', 'No reply for 3 days at Script Sent (waiting for their approval of the script we sent) (follow-up 3, until they answer).'), true);
  assert.equal(weekendHold('Lead follow-up', 'No reply for 5 days'), true);
  assert.equal(weekendHold('Payment chase', 'Past due'), false, 'payment chases are held elsewhere, not by this check');
});

// Nov 23 morning check: AI Inspo x Duncan's notes on our script PDF opened with "happy to receive your first video
// draft", the reader said video_feedback, the readers split and the deal waited for Harsh. Only a script went out.
test('notes on a script-only deal are never treated as cut feedback', async () => {
  const { scriptOnlyStage } = await import('../lib/inbox.js');
  assert.equal(scriptOnlyStage('Script Sent'), true);
  assert.equal(scriptOnlyStage('Price Agreed'), true);
  assert.equal(scriptOnlyStage('Submitted'), false, 'a cut is with the brand at Submitted');
  assert.equal(scriptOnlyStage('Approved'), false);
  const src = (await import('node:fs')).readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(src, /x\.event === 'video_feedback' && scriptOnlyStage\(deal\.stage\)/, 'the video_feedback -> script_changes guard runs before the second read');
  assert.ok(src.indexOf("scriptOnlyStage(deal.stage)") < src.indexOf('const held = await secondReadGate({ email, x, deal, who, usage, cost })'));
});

test('a creator loop-in with the brief gets the take-over reply and the brand, not the creator, as Brand Email (HubSpot x Duncan, Nov 20)', async () => {
  const { isHandover, handoverBrandEmail } = await import('../lib/inbox.js');
  const e = { from: 'Collab Oration <collab@buildroom.ai>', to: 'Piers Moore <piers@redthread.co>', cc: 'noocapcollab <noocapcollab@gmail.com>', text: 'Hi Piers,\n\nPlease feel free to send the contract and paperwork to noocapcollab@gmail.com so the rest of our team can be in the loop to take things forward from here.\n\nThanks' };
  assert.equal(isHandover(e, { from_role: 'noocap', brand: 'HubSpot' }), true);
  assert.equal(handoverBrandEmail(e), 'piers@redthread.co');
  const fs = await import('node:fs');
  const ib = fs.readFileSync(new URL('../lib/inbox.js', import.meta.url), 'utf8');
  assert.match(ib, /if \(r\?\.createdDeal && isHandover\(email, x\)\)/);
  const b = fs.readFileSync(new URL('../lib/briefs.js', import.meta.url), 'utf8');
  assert.match(b, /addrs\.find\(\(a\) => !ourSide\(a\)/);
});

// System check, Nov 23 (Atoms x Lindsay): "xiaohua su" <may@atoms.dev> signs "May"; the fixed reply opened "Hi xiaohua"
test('a fixed reply greets the name the brand signs with, capitalised', async () => {
  const { BUILT_IN, fillTemplate } = await import('../lib/replytemplates.js');
  const body = BUILT_IN.find((x) => x.key === 'script_eta').body;
  const text = "Hi Lindsay's team,\n\nI wanted to follow up on the revised script. How is it coming along?\n\nThank you!\n\nBest,\nMay\n";
  assert.match(fillTemplate(body, { from: '"xiaohua su" <may@atoms.dev>', deal: { creator: 'Lindsay' }, text }), /^Hi May,/);
  assert.match(fillTemplate(body, { from: '"xiaohua su" <may@atoms.dev>', deal: { creator: 'Lindsay' } }), /^Hi Xiaohua,/);
  // our own people signing never become the greeting
  assert.match(fillTemplate(body, { from: 'Daniela Ruiz <daniela@closedune.com>', deal: { creator: 'Chris' }, text: 'Ok\n\nBest,\nHarsh\n' }), /^Hi Daniela,/);
});

// System check, Nov 23 (Atoms x Lindsay): a second "2 to 3 working days" to a brand chasing the first one
test('an open timing promise blocks a second ETA reply until the work goes out', async () => {
  const { BUILT_IN, templateBlock, openEtaPromise } = await import('../lib/replytemplates.js');
  const t = (k) => ({ ...BUILT_IN.find((x) => x.key === k), active: true });
  const ack = { why: 'Fixed reply (sends on its own) [template:script_changes_ack] [from:x]: Atoms × Lindsay', status: 'Sent', kind: 'Reply', created: '2026-11-19T10:00:00Z' };
  assert.equal(openEtaPromise([ack]), '2026-11-19');
  assert.equal(openEtaPromise([ack, { why: 'Revised script', status: 'Sent', kind: 'Script', created: '2026-11-21T10:00:00Z' }]), '');
  assert.equal(openEtaPromise([{ ...ack, status: 'Rejected' }]), '');
  assert.match(templateBlock(t('script_eta'), { stage: 'Brief Received', today: '2026-11-23', etaPromised: '2026-11-19' }), /already promised a time/);
  assert.equal(templateBlock(t('script_eta'), { stage: 'Brief Received', today: '2026-11-23', etaPromised: '' }), '');
  // new notes after a script we sent still get their own acknowledgement
  assert.equal(templateBlock(t('script_changes_ack'), { stage: 'Script Sent', today: '2026-11-23', etaPromised: '2026-11-19' }), '');
});

test('a deal with no Linked Video uses its one card at 5 for the script (Dreamina x Chris, Nov 23)', async () => {
  const fs = await import('node:fs');
  const h = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(h, /const scriptCard = video \|\| \(dealCardList && dealCardList\.length === 1 && dealCardList\[0\]\.num === 5/);
  assert.match(h, /if \(!scriptsByCard && scriptCard && scriptCard\.num === 5/);
});

test('a cold inquiry asking for "your usual rates" is an inquiry, never a brief (Intimeros x Chris, Nov 19)', async () => {
  const { briefIsInquiry } = await import('../lib/inbox.js');
  const email = { threadId: 't1', text: "Hi Chris,\n\nWe're interested in creating a short Instagram Reel about AI companions.\n\nWould you be interested in collaborating? If so, could you share your usual rates for Instagram Reels, Stories, or other available formats?\n\nBest regards,\nIntimeros Team" };
  assert.ok(briefIsInquiry(email, { brand: 'Intimeros', event: 'brief' }, [])?.asksRate);
  assert.equal(briefIsInquiry({ threadId: 't2', text: 'Here is the brief for the video, the script goes to Anna.' }, { brand: 'X' }, []), null);
});
