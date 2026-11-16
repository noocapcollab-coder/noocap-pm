# PM lessons: Payments

Mistakes the PM made once and the rule that came out of each.

## Greet the person the email is going to
When: Writing any email, above all a payment chase that goes to a finance or payments address rather than the usual contact
Do: Greet whoever is in To by the name they signed with (the payments team's Pavinder, not the campaign contact), and keep the usual contact on Cc
Never: Never open with the campaign contact's name while the email goes to a different person or team address
Seen 1 time(s). Source: System check.
## A due date in a brand email comes from the brand's terms
When: Writing a payment chase or reminder that names a due date
Do: Quote a due date only when the thread or the deal's Payment Terms give it (Net 30 agreed, the brand's own 'paid on 13/11'). When no terms were agreed, ask when we can expect the payment instead. Match the count: two invoices sent = 'the two invoices'.
Never: Quote a due date that was filled in as a Net 30 guess, or call two invoices 'the invoice'.
Seen 2 time(s). Source: System check.
## One invoice email per Stripe invoice
When: Drafting an invoice email for a Stripe invoice, from WhatsApp or from the heartbeat
Do: Before drafting, look for an Approvals row with the same Stripe invoice id that is waiting or already sent; if there is one, draft nothing.
Never: Draft a second invoice or payment-chase email for an invoice that already has one, or put two cards for one invoice in front of Harsh.
Seen 2 time(s). Source: System check.
## Chase payment where the brand said invoices go
When: A brand names a finance or accounts address for invoices, or asks for reminders in the invoice thread
Do: Send invoices and every payment chase to that address, in the thread where the invoice went, with the usual contact on Cc.
Never: Never chase payment in the contact's deal thread once the brand named a finance address, and never put an estimated date in a brand email.
Seen 1 time(s). Source: Harsh correction.
## Answer the brand's question before chasing money
When: A payment chase is due but the brand's latest email to us is a question we have not answered
Do: Hold the chase. Get the answer (ask Harsh on WhatsApp if only he knows) and send that first; the payment ask can ride in the same email.
Never: Draft a payment chase that skips or guesses the answer to the brand's open question.
Seen 1 time(s). Source: System check.
## Chase where the brand told us to chase
When: Writing a payment chase or reminder on a deal where the brand said how invoices or reminders must be sent (which thread, which finance address, which portal)
Do: Read the thread for the brand's own instructions first and follow them: reply in the thread the invoice went out in and copy the finance address they named. If the deal's Thread ID points at the old collab thread, switch it to the invoice thread before drafting.
Never: Chase in the collab thread without finance when the brand asked for the invoice thread with finance in copy, or send a second chase the same day as one already sent by hand.
Seen 1 time(s). Source: System check.
## Invoiced only when an invoice really went out
When: Reading an email that mentions an invoice, or creating a deal from an old thread
Do: Move a deal to Invoiced only when our invoice was actually sent (Approvals, Stripe, or the creator's own invoice to the brand) and record its date. When the brand sends billing details, raise the invoice; asking for details is not invoicing.
Never: Never set Invoiced or Paid from the AI's reading of an email, and never leave a deal at Invoiced with no invoice date, number or Stripe invoice.
Seen 2 time(s). Source: Harsh correction.
## Stop chasing billing details after 3 reminders or when the brand pays through a platform
When: The video is posted and the invoice needs the brand's company details
Do: Count Billing Reminders Sent. At 3, stop and tell Harsh once. If the brand pays through Gusto, Faved, creator.co or a similar portal, use that portal and don't ask for invoice details. Never nudge while our own latest email in the thread is still unanswered.
Never: Draft a 4th billing reminder, or a reminder hours after our last email.
Seen 1 time(s). Source: System check.
## A claimed payment needs proof
When: A brand says 'we've already paid' with nothing attached
Do: Check Stripe, then earlier proof in the deal that is dated on or after THIS invoice; if neither, ask for the transfer receipt or reference.
Never: Mark it paid, use proof of an earlier payment (a first half, an old invoice) for a later invoice, or ask again for proof they already sent for this invoice.
Seen 5 time(s). Source: Rulebook.
## Upfront money does not close the deal
When: A payment arrives before the video is posted
Do: Record it as an upfront part payment and keep the deal open.
Never: Mark the whole deal Paid.
Seen 1 time(s). Source: Rulebook.
## Brand asked for the invoice = raise it
When: A brand asks for the invoice
Do: Draft the invoice right away (Brad is invoiced by hand, never flag his Stripe).
Never: Reply that it will come later.
Seen 1 time(s). Source: Rulebook.
## Retire a before-due reminder after the due date
When: A payment chase is waiting and the due date passes
Do: Replace it with a real past-due chase.
Never: Send 'is it on track for the due date' after the date.
Seen 1 time(s). Source: Rulebook.
## Scheduled is not paid
When: A brand writes about paying
Do: Only Stripe showing it paid, or a receipt / transfer reference, counts as paid. 'In our payment queue', 'scheduled', 'will be paid on' = note the date and keep it Invoiced.
Never: Mark Paid from a promise, ask for proof of a payment that hasn't happened, or send an 'is it on track' check-in before the date the brand already gave.
Seen 4 time(s). Source: Rulebook.
## Invoice emails are one line plus payment details
When: Writing an invoice email
Do: One sentence and the payment details.
Never: Add extra paragraphs or filler.
Seen 1 time(s). Source: Rulebook.

## The invoice guard: nothing wrong goes to a brand (Harsh, Nov 16)
After INV-001 (bank details that weren't Chris's), "Pavinder" for Natalia, and TikTok on Readdy, every invoice is checked against what the brand and creator wrote before it is raised or sent (lib/invoiceguard.js):
- Payment details come only from the **Creator Payment Details** table in Notion (NOOCAP MASTER SYSTEM), and only from a row Harsh ticked **Verified** with a Source. Details typed in chat or WhatsApp are saved there unverified and never printed. The AI never writes the verified fields. Any bank or PayPal line in an invoice email that isn't the verified one stops it.
- Money emails greet only a name that signed one of the brand's emails, else "Hi there,".
- Platforms on the deal must be ones the brand's emails mention.
- The amount must match the agreed fee (and the part's %), the revenue sheet must agree, and the fee should appear in the emails (a warning to tick if it was agreed on a call).
- The billed-to company must be one the brand wrote.
- Posted links must be single posts on the right platform, not used on another deal; YouTube ones must be on the creator's channel and posted after the deal began.
A contradiction stops the invoice; something that can't be checked shows as ⚠️ on the Invoices page for Harsh to tick.
