---
type: hub
---
# 08 — Brand Deal Email Triage

Notion page under [[NOOCAP Systems — SOP Library]], last edited 2026-11-08.

Loom video: [ADD Loom link]
In one line: AI reads the brand emails coming in for our creators, sorts out the real opportunities and sends us an alert in Discord so nobody misses a deal.

### What this system does
Our creators get a lot of emails from brands, and many of them are spam or not worth replying to. This system reads those emails automatically, uses AI to figure out which ones are real brand deals, and posts the important ones in Discord so the team can reply quickly.

### Who is involved
- Owner: The Ops Manager
- Users: whoever handles brand deals for each creator

### When it runs
Automatically, all day, whenever a new email arrives.

### Tools used

### Step by step
- A brand emails a creator and the automation picks it up.
- AI reads it and decides if it's worth our time.
- Real opportunities show up as an alert in Discord [ADD channel name].
- The person handling that creator opens the email and replies.
- If the deal moves forward, add it to the Brand Deals Pipeline in Notion.

### Rules
- Reply to good brand alerts within 24 hours, since brands move on fast.
- Every deal that moves forward goes into the Brand Deals Pipeline, because the invoice system (SOP 09) runs from there.
- If AI flags something wrongly, tell the Ops Manager so it can be tuned.

### If something breaks

### Every piece of this system

### Backup plan

### 🎙️ Loom script (about 2 minutes)
  [SHOW: a creator's inbox full of brand emails]
  This video explains how we handle brand emails for our creators. They get a huge number of them and most aren't worth anyone's time, so we built a system that reads them first. Every new email that comes into a creator's brand inbox gets picked up by an n8n automation, which sends it to Claude through the Anthropic API, and Claude decides whether it's a real brand opportunity or just noise.
  [SHOW: a Discord brand alert]
  When it's a real opportunity, an alert like this gets posted in Discord, so whoever handles that creator only spends time on emails that actually matter. The target is to reply to good alerts within a day, because brands move on quickly.
  [SHOW: Brand Deals Pipeline in Notion]
  Once a deal starts moving forward, it gets added to the Brand Deals Pipeline in Notion. That step matters because our invoice system runs from this pipeline later on.
  If the alerts ever stop, the fallback is checking each creator's inbox by hand in the morning and evening until the automation is fixed, and if spam starts getting through, the AI's rules get tightened.

## Links
- [[NOOCAP Systems — SOP Library]]
