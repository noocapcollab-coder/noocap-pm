// The test bank: real emails that tripped the PM up, with the answer a careful person would give. lib/evals.js runs
// the PM's own reader (plus the fixed guards and the second reader) on every one of them each night, so a change that
// makes the AI misjudge one of these again is caught within a day. Add a case for every new kind of mistake.
// expect: event (must equal) | not_event (must not equal) | flags (fields that must be truthy) | not_stage (deal_stage must not be)
export const CASES = [
  {
    id: 'runway-payment-queue', why: 'Runway marked Paid on Nov 3',
    deal: { brand: 'Runway AI', creator: 'Chris', stage: 'Invoiced', threadId: 't-runway' },
    email: { from: 'Payments Team <payments@houseofmarketers.com>', subject: 'Re: @thechriscordero x RUNWAY AI [Collaboration Inquiry]', threadId: 't-runway',
      text: 'Hi\n\nThank you for sharing the invoice. I can confirm receipt and also that this invoice is now in our payment queue, due to be paid 13/11/26\n\nThank you\nPavinder' },
    expect: { not_event: 'payment_confirmed', not_stage: 'Paid' },
  },
  {
    id: 'weglot-faved-approval', why: 'Weglot approval sent to Rudraksh as a brief update, Nov 3',
    deal: { brand: 'Weglot', creator: 'Lindsay', stage: 'Script Sent', threadId: 't-weglot', linkedVideo: 'yes' },
    email: { from: 'Faved <creators@faved.com>', subject: 'Weglot Paid Sponsorship x Automate AI Consulting - deal-ceqmqr', threadId: 't-weglot',
      text: "Hi Automate AI Consulting,\n\nThere has been an update to your Weglot Paid Sponsorship x Automate AI Consulting deal.\n\nUpdate\nWeglot - Approved Idea, Script & Live Date With Feedback:\nHere is the validated version with few updates :)\n\n(0:00) If you build WordPress sites for local businesses, there's one add-on almost nobody offers.\n(0:12) This is Weglot 2.0, a plugin for WordPress. Install it, pick your languages, and it translates the whole site.\n(0:40) So that's the add-on. Set it up once on every client site. Link in bio, try Weglot 2.0 for free.\n\nNext Step\nDraft video - waiting on creator submission\n\nSubmit Topic, Caption & Live Date" },
    expect: { event: 'script_approved' },
  },
  {
    id: 'speakon-second-reel', why: 'SpeakOn reel 2 brief landed on reel 1, Nov 3',
    deal: { brand: 'SpeakOn AI', creator: 'Chris', stage: 'Paid', threadId: 't-speakon', linkedVideo: 'yes' },
    email: { from: 'Cassie <heduodd@gmail.com>', subject: 'Re: 回复: 回复: Paid Tech Sponsorship with SpeakOn AI', threadId: 't-speakon',
      text: "Hi Chris and team!\nHope you're doing well!\nNow that we've completed the payment for our first collaboration, we'd love to start planning and scheduling our second Reel!\nIdeally, we'd like to get this one published as soon as possible. I've attached the creative brief for your reference. https://app.notion.com/p/SpeakON-Notes-Agent-Brief-406f07094bef8099954ae9629937623a\nCould you take a look and let me know when you think you'd be able to share the first script with us?\nBest,\nCassie" },
    expect: { event: 'brief' },
  },
  {
    id: 'runway-ad-codes', why: 'Ad codes became a promise email instead of a question for Harsh',
    deal: { brand: 'Runway AI', creator: 'Chris', stage: 'Invoiced', threadId: 't-runway' },
    email: { from: 'Natalie Brown <natalie.brown@houseofmarketers.co.uk>', subject: 'Re: @thechriscordero x RUNWAY AI [Collaboration Inquiry]', threadId: 't-runway',
      text: 'Hi Team,\n\nThanks for this - could you send me the ad codes for TT and IG for the 2nd video?\n\nThe payments team will handle comms regarding payments\n\nThanks' },
    expect: { not_event: 'payment_confirmed', flags: ['needs_reply', 'needs_our_info'] },
  },
  {
    id: 'zeely-claimed-paid', why: 'A "we already paid" claim must be read as a payment claim (the code then checks Stripe/proof)',
    deal: { brand: 'Zeely AI', creator: 'Duncan', stage: 'Invoiced', threadId: 't-zeely' },
    email: { from: 'Victoria Ev <victoria@mediacube.io>', subject: 'Re: ZEELY AI campaign & Duncan Rogoff | Learn Claude Code', threadId: 't-zeely',
      text: 'Hi team,\n\nWe have already paid the 50% advance for this collaboration. Please let us know if you need anything else.\n\nBest regards,\nVictoria' },
    expect: { event: 'payment_confirmed' },
  },
  {
    id: 'real-payment-sent', why: 'A real payment must still be recognised',
    deal: { brand: 'Softr', creator: 'Lindsay', stage: 'Invoiced', threadId: 't-softr' },
    email: { from: 'Kat <katerina@softr.io>', subject: 'Re: September video topics', threadId: 't-softr',
      text: 'Hi team,\n\nThe payment for the invoice was sent today by bank transfer, transaction reference TRX-88213-SOFTR. Please confirm once you receive it.\n\nThanks,\nKat' },
    expect: { event: 'payment_confirmed' },
  },
  {
    id: 'zenbusiness-ugc-notes', why: 'Change notes on cuts became a reply email, Nov 3',
    deal: { brand: 'ZenBusiness', creator: 'Lindsay', stage: 'Submitted', threadId: 't-zen', linkedVideo: 'yes' },
    email: { from: 'ZenBusiness Team <creators@zenbusiness.com>', subject: 'Re: ZenBusiness x Lindsay UGC', threadId: 't-zen',
      text: 'Hi team,\n\nThanks for the cuts! A few changes before we can approve:\nUGC 1 · 0:12 please show the dashboard for 2 more seconds\nUGC 3 · 0:04s missing the ® after Velo\n\nThanks!' },
    expect: { event: 'video_feedback' },
  },
  {
    id: 'invoice-request', why: 'An invoice request got a "within hours" reply instead of an invoice, Nov 2',
    deal: { brand: 'Zeely AI', creator: 'Duncan', stage: 'Posted', threadId: 't-zeely' },
    email: { from: 'Victoria Ev <victoria@mediacube.io>', subject: 'Re: ZEELY AI campaign & Duncan Rogoff | Learn Claude Code', threadId: 't-zeely',
      text: 'Hello,\n\nCould you please provide the invoice for the remaining payment? Our finance team needs it this week.\n\nBest,\nVictoria' },
    expect: { flags: ['asks_for_invoice'] },
  },
  {
    id: 'kylon-rate-question', why: 'A pricing question must come to Harsh as a reply, not change the deal',
    deal: { brand: 'Kylon', creator: 'Lindsay', stage: 'Invoiced', threadId: 't-kylon' },
    email: { from: 'Alyssa Salazar <alyssa@withwidely.com>', subject: 'Re: Kylon Paid Collaboration', threadId: 't-kylon',
      text: "Hi,\n\nWe've reviewed your rate of $1,000 for the community share. Unfortunately, that's above what we're able to budget for this part of the campaign. Could you let us know the lowest rate you'd be comfortable accepting?\n\nBest,\nAlyssa" },
    expect: { event: 'brand_reply', flags: ['needs_reply'] },
  },
  {
    id: 'polar-gusto-update', why: 'A plain update with a payment platform invite is not a payment',
    deal: { brand: 'Polar', creator: 'Valeri', stage: 'Posted', threadId: 't-polar' },
    email: { from: 'Ushni Gupta <ushni@thebreadwinners.club>', subject: 'Re: Exciting Partnership Opportunity with Polar x @valeridoesai', threadId: 't-polar',
      text: "Hi team!\n\nThanks so much for following up, and excited to hear the second video will be ready by Thursday!\n\nYou should have received an invitation to Gusto, which we'll be using to process your payment. Could you please confirm if you've received it?\n\nThanks!\nUshni" },
    expect: { not_event: 'payment_confirmed', not_stage: 'Paid' },
  },
  {
    id: 'kylon-publish-chase', why: 'Second reader false alarm Nov 4: called Invoiced wrong because the video was not posted yet',
    deal: { brand: 'Kylon', creator: 'Lindsay', stage: 'Invoiced', threadId: 't-kylon2' },
    email: { from: 'Evan <evan@withwidely.com>', subject: 'Re: Kylon Paid Collaboration', threadId: 't-kylon2',
      text: "Hi team,\n\nThe video was approved last week but it still hasn't gone live. Could you publish it this week, ideally Monday to Wednesday? Please confirm.\n\nThanks,\nEvan" },
    expect: { not_event: 'payment_confirmed', not_stage: 'Paid', flags: ['needs_reply'] },
  },
];
