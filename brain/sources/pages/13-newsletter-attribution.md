# 13 — Newsletter & Attribution

Notion page under [[NOOCAP Systems — SOP Library]], last edited 2026-11-08.

Loom video: [ADD Loom link]
In one line: Leads from Instagram and Facebook join a creator's newsletter, the emails guide them towards paying for the Skool community, and we track which piece of content each paying member came from.

### What this system does
Not everyone who gets a lead magnet buys straight away. This system adds those leads to an email newsletter that keeps giving value and nudges them towards the creator's paid Skool community. It also tracks the whole journey, so we can say "this reel brought in this many paying members," which tells us what content actually makes money.

### Who is involved
- Owner: The Ops Manager
- Users: the content team, who use the results to plan content

### When it runs
Automatically, every time a new lead comes in.

### Tools used

### The journey
- A lead comes in from an Instagram or Facebook post.
- They're added to the creator's newsletter, along with which post they came from.
- The newsletter keeps sending useful emails that point to the Skool community.
- When they join Skool and pay, the system connects that payment back to the original post.

### How to use the results
- Look at which posts brought in the most paying members.
- Make more content like the winners.
- Share the results with the Ops Manager and the strategist when planning the next batch of scripts.

### Rules
- Never remove the tracking parts of a link, because that breaks attribution.
- Use the creator's own newsletter, never a shared one.

### If something breaks

### Every piece of this system

### Backup plan

### 🎙️ Loom script (about 2 minutes)
  [SHOW: a lead coming in from a post]
  This video explains what happens to a lead after they grab a free guide. Most people don't buy straight away, so we add them to the creator's newsletter, which runs on Kit or beehiiv and keeps sending useful emails that point them towards the creator's paid Skool community over time.
  [SHOW: the newsletter in Kit or beehiiv]
  Behind the scenes, n8n moves the lead data around and stores it in a Postgres database on Railway, including which post each lead originally came from. That's the clever part, because when someone finally pays for Skool, we can trace them back to the exact reel or carousel that brought them in.
  [SHOW: the attribution results]
  It tells us which content actually makes money, and we use that to decide what to make more of. The one thing that breaks it is someone changing or stripping a tracking link, so those always stay as they are.
