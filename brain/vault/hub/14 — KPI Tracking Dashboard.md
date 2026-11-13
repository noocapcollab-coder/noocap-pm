---
type: hub
---
# 14 — KPI Tracking Dashboard

Notion page under [[NOOCAP Systems — SOP Library]], last edited 2026-11-08.

Loom video: [ADD Loom link]
In one line: The KPI dashboard pulls video tasks from Notion and shows how many videos each editor finishes and how long each one takes.

### What this system does
This dashboard gives us a clear picture of how video production is going. It reads the video cards from Notion and shows which editor is working on what, how many videos get done each day and how long each video takes. We use it to check whether editing with Claude is actually saving us time.

### Who is involved
- Owner: The Ops Manager
- Viewed by: The Ops Manager and Pratham, and editors can see their own numbers

### When it runs
It updates automatically from Notion, and the Ops Manager reviews it every week [ADD review day].

### Tools used

### What it tracks

### How editors keep the numbers accurate
- Only start a video once you've been tagged on it in the client's dashboard.
- Click Done editing on the script page as soon as you finish, so the finish time is right.
- Tell the Ops Manager if a card's status is wrong.

### Rules
- The dashboard is only as good as the Notion cards, so keep statuses up to date.
- Numbers are used to spot problems early, and they're never used to blame anyone.

### If something breaks

### Every piece of this system

### Backup plan

### 🎙️ Loom script (about 2 minutes)
  [SHOW: the KPI dashboard]
  This video explains our KPI dashboard, which shows how video production is going across the whole team. It's a React app hosted on Vercel that syncs with Notion, so nobody has to enter numbers by hand. It reads from two places, with the client dashboards telling it which editor is assigned to which video and EDIT TRACKER telling it when each video was actually finished.
  [SHOW: videos per day and per editor]
  From that, it shows how many videos get finished each day and how long each one took from assignment to handoff, broken down by editor.
  [SHOW: time per video]
  We're also adding how long Claude spends on each edit, which helps us judge whether editing with Claude is really saving time. The numbers are only as accurate as Notion, so editors clicking Done editing as soon as they finish matters a lot, because that's when EDIT TRACKER records the finish time.
  The point of all this is spotting where things get stuck so they can be fixed early, and it's never used to blame anyone.

## Links
- [[NOOCAP Systems — SOP Library]]
