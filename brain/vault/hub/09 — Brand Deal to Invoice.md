---
type: hub
---
# 09 — Brand Deal to Invoice

Notion page under [[NOOCAP Systems — SOP Library]], last edited 2026-11-08.

Loom video: [ADD Loom link]
In one line: When a brand video is posted, the system emails the brand for their billing details and prepares the invoice, and after the Ops Manager approves it the invoice goes out from the creator's own Stripe.

### What this system does
Getting paid for brand deals used to mean chasing details and making invoices by hand. Now, as soon as a deal is marked "Posted" in the Brand Deals Pipeline, the system emails the brand asking for their company details, then creates the invoice in the creator's own Stripe account so the brand pays the creator directly. Nothing goes out until the Ops Manager approves it.

### Who is involved
- Owner and approver: The Ops Manager
- Creators: each one sets up a Stripe key once

### When it runs
Every time a deal's stage changes to "Posted" in the Brand Deals Pipeline.

### Tools used

### Step by step
- The brand video goes live, and the deal is moved to Posted in the Brand Deals Pipeline.
- The system emails the brand asking for their company and billing details.
- Once the brand replies, the invoice is prepared in the creator's Stripe with the next invoice number for that creator.
- The Ops Manager reviews and approves it.
- The invoice PDF goes to the brand, and they pay the creator directly.

### How invoice numbers work
Each creator has their own count, starting at INV-001, then INV-002 and so on. The number is saved on the deal in the Brand Deals Pipeline so we can always find it.

### Setting up a new creator
- Ask the creator to create a restricted Stripe key that can only make invoices [ADD how-to link].
- Save the key securely where the Ops Manager tells you to, never in a Notion page or chat.
- Start their invoice count at INV-001.

### Rules
- Only move a deal to Posted when the video is actually live.
- Deals that came through WhatsApp are skipped by the system and send an alert instead, so those need to be handled by hand.
- No invoice goes out without the Ops Manager's approval.

### If something breaks

### Every piece of this system

### Backup plan

### 🎙️ Loom script (about 3 minutes)
  [SHOW: Brand Deals Pipeline with a deal at "Posted"]
  This video explains how our creators get paid for brand deals without anyone chasing details by hand. It all runs from the Brand Deals Pipeline in Notion, and the trigger is this stage called Posted.
  [SHOW: the billing-details email sent to a brand]
  Once a brand's video is live and the deal is moved to Posted, the system automatically emails the brand from the creator's Gmail asking for their company and billing details.
  [SHOW: the invoice in Stripe, with the INV number]
  When the brand replies, an invoice is prepared inside the creator's own Stripe account, which means the brand pays the creator directly and the money never passes through us. Each creator gives us a restricted Stripe key that can only create invoices, and each creator has their own invoice numbers starting at INV-001, which get saved on the deal.
  [SHOW: approval step]
  Nothing goes out until the Ops Manager approves it, and only then does the brand receive the invoice PDF. The one exception to all of this is deals that came in through WhatsApp, because the system skips those and sends an alert instead, so those invoices are handled by hand.

## Links
- [[NOOCAP Systems — SOP Library]]
