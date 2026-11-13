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
  const c = ib.slice(ib.indexOf("case 'payment_confirmed'"), ib.indexOf("case 'payment_confirmed'") + 2500);
  assert.match(c, /if \(fromBrand && !hasProof\)/);
  assert.match(c, /ask them to share the payment confirmation/);
});

test('a hand-filed deal with no email thread is treated as a WhatsApp deal (Buzzy × Brad got an email-style invoice ping)', async () => {
  const fs = await import('node:fs');
  const b = fs.readFileSync(new URL('../lib/briefs.js', import.meta.url), 'utf8');
  assert.match(b, /channel: get\('Channel'\) \|\| \(!get\('Thread ID'\) && !get\('Message ID'\) && get\('Deal Source'\) === 'Manually added' \? 'WhatsApp' : 'Email'\)/);
  const h = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(h, /waOnce\('Script ready'/);
  assert.match(h, /waOnce\('Posted'/);
});

test('payment details are printed as text on the invoice when the deal or creator has them (Mediacube)', async () => {
  const I = await import('../lib/invoicing.js');
  assert.equal(I.paymentDetails({ paymentDetails: 'Bank: X\nIBAN: Y', creator: 'Duncan' }), 'Bank: X\nIBAN: Y');
  process.env.PAYMENT_DETAILS_DUNCAN = 'Bank: Z\\nSWIFT: Q';
  assert.equal(I.paymentDetails({ creator: 'Duncan' }), 'Bank: Z\nSWIFT: Q');
  delete process.env.PAYMENT_DETAILS_DUNCAN;
  assert.equal(I.paymentDetails({ creator: 'Duncan' }), '');
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
  assert.match(hb, /const SCRIPT_FOLLOW_UPS = 5;/);
  assert.match(hb, /const SCRIPT_FOLLOW_GAP = 3;/);
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

test('no follow-up to the brand while we owe the revised cut (CapCut x Chris, Nov 9)', async () => {
  const fs = await import('node:fs');
  const { ourMoveText } = await import('../lib/heartbeat.js');
  assert.equal(ourMoveText("Editor making the brand's changes", 'Chris'), true);
  assert.equal(ourMoveText('Brad reshooting the video with original footage', 'Chris'), true);
  assert.equal(ourMoveText('Waiting for the brand to review the revised cut', 'Chris'), false);
  const hb = fs.readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8');
  assert.match(hb, /status === 'Changes' : false;\n\s*const ourMove = changesOpen \|\|/);
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
  assert.match(cutInstructions('', false), /Do not answer or raise anything else/);
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
