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

