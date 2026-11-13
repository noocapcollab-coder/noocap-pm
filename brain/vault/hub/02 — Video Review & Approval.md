---
type: hub
---
# 02 — Video Review & Approval

Notion page under [[NOOCAP Systems — SOP Library]], last edited 2026-11-08.

Loom video: [ADD Loom link]
In one line: When an editor finishes a video they click Done editing on the script page and submit the Frame.io link and their name, it lands in EDIT TRACKER, and all feedback and approval for that video happens in its own Discord thread.

### What this system does
This system makes sure finished videos never get lost and feedback stays in one place. When an editor is done, they click the Done editing button on the Vercel script page and submit the Frame.io link and their name. That submission lands in EDIT TRACKER, which is the final collection point for every finished video. An automation then opens a Discord thread for that video and pings the Ops Manager on Telegram, so every change request and the final approval sit together in one thread.

### Who is involved
- Owner: The Ops Manager, the final approver
- Users: editors, and anyone on the team who reviews videos

### When it runs
Automatically, every time an editor submits through the Done editing button.

### Tools used

### Video statuses

### Step by step
- The editor finishes the video and uploads it to Frame.io.
- On the script page, they click Done editing on that video and submit the Frame.io link and their name.
- The submission lands in EDIT TRACKER, and a Discord thread opens automatically for that video.
- The Ops Manager gets a Telegram ping and reviews the video.
- Any changes are posted as replies in that thread, and the editor fixes them and posts the new link in the same thread.
- When the Ops Manager approves, the video moves to Green Light.
- Once the video is live, it's moved to Posted.

### Rules
- Always submit through the Done editing button, so every finished video lands in EDIT TRACKER.
- Keep everything about a video inside its own thread, and never send feedback in DMs or the main channel.
- Post a new link for each new version, so it's clear which one is the latest.
- Make sure the Frame.io link opens for someone else before you submit it.

### If something breaks
The technical runbook for this system is here: Video Review System Runbook. Some parts of it mention the older Frame.io and Video Intake setup, so use it mainly for fixing the n8n and Discord side.

### Every piece of this system

### Backup plan

### 🎙️ Loom script (about 3 minutes)
  [SHOW: the Done editing button on the script page]
  This video explains what happens after an editor finishes a video, which is how it gets reviewed and approved. When an editor is done, they upload the video to Frame.io, then go back to the same Vercel script page they read the script on and click Done editing. They paste the Frame.io link and their name, and submit it.
  [SHOW: EDIT TRACKER in Notion]
  Every submission lands here in EDIT TRACKER. Think of it as the final collection point, because every finished video from every editor ends up here with its links, which gives us one place to see everything that's been delivered.
  [SHOW: Discord #review-area thread opening]
  As soon as a new row lands in EDIT TRACKER, an n8n automation running on Railway opens a thread in our #review-area channel on Discord named after that video, and at the same time it sends the Ops Manager a ping on Telegram so they know something is waiting.
  [SHOW: an example thread with feedback]
  All the review happens inside that one thread. The Ops Manager watches the video and posts any changes as replies, the editor fixes them and posts the new link in the same thread, and it goes back and forth until it's approved. We keep it all in the thread so the full history of every video sits in one place and nothing gets lost in DMs. On the Notion side, the video moves from Awaiting Review to Revisions Requested if changes are needed, then to Green Light once it's approved, and finally to Posted when it's live on the client's account.
  If threads ever stop opening, the first thing to check is whether the n8n workflow is still switched on, and the second is whether the Notion integration is still connected to EDIT TRACKER, because those two cause almost every problem with this system.

## Links
- [[NOOCAP Systems — SOP Library]]
