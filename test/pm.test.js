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
