# 04 — Daily Script Generation

Notion page under [[NOOCAP Systems — SOP Library]], last edited 2026-11-08.

Loom video: [ADD Loom link]
In one line: Every morning, Claude writes new scripts in each creator's own voice and puts them in their Notion dashboard, and Discord tells us they're ready to review.

### What this system does
We write a lot of scripts for a lot of creators, and every creator sounds different. Each creator has a "Voice DNA," which is a saved profile of how they talk, the words they use and how they structure their videos. Every morning, automated Claude routines use that Voice DNA to write fresh scripts, save them into the creator's Notion dashboard, and n8n sends a Discord message so the team knows drafts are waiting.

### Who is involved
- Owner: The Ops Manager
- Users: the content strategist (Rudraksh) and anyone reviewing scripts

### When it runs
Automatically every morning, India time (IST).

### Tools used

### Step by step
- The routine runs on its own every morning, so nobody needs to start it.
- When you see the Discord message, open the creator's Notion dashboard.
- Read each new script and check it sounds like the creator, the hook is strong, and the facts are correct.
- Fix anything that's off, or ask for a rewrite in that creator's Claude Project.
- Mark the script as approved so it can go to editing (SOP 01).

### What a good script checklist looks like
- [ ] It sounds like the creator would actually say it out loud
- [ ] The hook grabs attention in the first line
- [ ] Any tool, price or feature mentioned is correct and current
- [ ] It has a clear call to action (usually the comment keyword for a lead magnet)

### Rules
- Never send a script to editing without a human reading it first.
- When you rewrite a script by hand, use that creator's own Claude Project, never a general chat.
- If a creator's voice starts feeling off, tell the Ops Manager so the Voice DNA can be updated.

### If something breaks

### Every piece of this system

### Backup plan

### 🎙️ Loom script (about 3 minutes)
  [SHOW: a creator's Notion dashboard with new scripts]
  This video explains how our scripts get written every day. We never start from a blank page, because every morning automated Claude routines write fresh scripts for our creators and save them straight into each creator's Notion dashboard. Those routines run in the cloud on Claude Code, India time, and they're connected to Notion so the scripts land in the right dashboard without anyone touching them.
  [SHOW: a creator's Claude Project with Voice DNA]
  The reason those scripts actually sound like the creator is something we call Voice DNA. Each creator has their own Claude Project holding a profile of how they talk and how they build their videos, and the routines write every script using that profile. We also keep a master archive of past scripts pulled from our client dashboards, which is useful for seeing what's worked before or writing something by hand.
  [SHOW: Discord script-ready message]
  When the scripts are ready, an n8n automation posts a message like this in Discord, which tells the content team there are drafts waiting for review.
  [SHOW: reviewing a script against the checklist]
  Every script still gets read by a person before it goes to editing. The reviewer checks that it sounds like the creator and that the hook and any facts like tool names or prices hold up, and if a creator's voice ever starts drifting, their Voice DNA gets updated.
  The one rule this system depends on is that no script reaches an editor until a human has read it.
