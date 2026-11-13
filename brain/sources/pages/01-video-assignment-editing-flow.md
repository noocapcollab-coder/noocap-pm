# 01 — Video Assignment & Editing Flow

Notion page under [[NOOCAP Systems — SOP Library]], last edited 2026-11-08.

Loom video: [ADD Loom link]
In one line: The Ops Manager tags an editor on a video in the client's Notion dashboard and sets its status to In Edit, the editor gets a Discord message with the video and its posting date, edits it, and then submits the Frame.io link from the script page using the Done editing button.

### What this system does
This is how a video goes from "we need this edited" to "the editor is working on it." Every client has their own dashboard in Notion where their videos and scripts live, and the Ops Manager assigns work from there. When an editor is tagged on a video in a client's dashboard and its status is changed to In Edit, they get a notification in their channel telling them which video to edit and when it's going to be posted, so they know which videos to prioritise. Editors don't need Notion access, because the script is shown to them on a simple web page, and that same page is where they hand the video back once it's done.

### How the script page works
All scripts are written and stored in Notion, inside each client's dashboard. Editors never open Notion though, because we have our own web page hosted on Vercel that reads the scripts from Notion and shows them in a clean, simple view. Think of Notion as the kitchen where scripts are made and the Vercel page as the window where editors pick them up.
- When a script is added or changed in Notion, the Vercel page shows the latest version automatically, so editors always see the newest one after a refresh.
- Editors only need the page link, with no Notion login or invite.
- Editors can read the script but can't change it, so if something in a script looks wrong, they tell the Ops Manager and it gets fixed in Notion.
- If a script is missing on the page, it usually means it hasn't been added to the client's dashboard in Notion yet.
- Each video on the page has a Done editing button. When the editor finishes, they click it and submit the Frame.io link and their name, and that sends the finished video into the review system (SOP 02).

### Who is involved
- Owner: The Ops Manager, who assigns the videos from the client dashboards
- Users: every NOOCAP editor

### When it runs
Every working day. The Ops Manager assigns about 4 to 6 videos a day, which is roughly 2 per client, and every assigned video should be finished the same day.

### Tools used

### Step by step
For the Ops Manager
- Open the client's dashboard in Notion.
- Find the video and check its script is final.
- Tag the editor on that video.
- Make sure the posting date is filled in, so the editor knows the priority.
- Change the status to In Edit. The editor is only notified once both the tag and the In Edit status are set.
For the editor
- Open the notification in your channel and note the client, the video and its posting date.
- If you have more than one video, work on the one with the earliest posting date first.
- Open the script page and find that video's script.
- Download the raw footage from the link on the task.
- Open the Claude chat named after that client (or Motion Studio if it's a motion client) and edit the video following the script.
- Upload the finished video to Frame.io and copy its link.
- Go back to the script page, click Done editing on that video, and submit the Frame.io link and your name. This is the start of SOP 02.

### Types of videos

### Rules
- Always use the Claude chat named after the client, so the client's style and history stay in one place.
- Never start a video you haven't been tagged on in a client's dashboard.
- Always work in order of posting date, earliest first.
- Finish assigned videos the same day, and if you can't, tell the Ops Manager before the end of the day so it can be moved.

### If something breaks

### Every piece of this system

### Access you need before your first day
- [ ] Added to the NOOCAP Discord server with your own channel
- [ ] Script page link saved in your bookmarks
- [ ] Shared Claude login from the Ops Manager
- [ ] Access to the footage storage
- [ ] Access to the Frame.io project
- [ ] Motion Studio set up if you edit motion clients (SOP 03)

### Backup plan

### 🎙️ Loom script (about 3 minutes)
  [SHOW: a client's dashboard in Notion]
  Let me walk you through how videos get assigned to our editors and how an editor goes from getting a task to actually editing it. Every client we work with has their own dashboard in Notion like this one, and that's where all of their scripts and videos live, so it's always the starting point.
  [SHOW: a video inside the client's dashboard]
  When a video is ready to be edited, the Ops Manager opens it inside that client's dashboard, tags an editor on it and changes its status to In Edit. Those two things together are what kick everything off, because the moment an editor is tagged and the status is In Edit, our Discord bot sends a message into that editor's own channel. We tie it to the status so editors only get pinged when a video is actually ready to be worked on.
  [SHOW: Discord notification]
  This is the message the editor receives. It names the client and the video, so the editor never has to guess what they're working on, and it also shows when the video is going to be posted. That posting date is how editors decide what to do first, because the video going live soonest always gets priority.
  [SHOW: script page on Vercel]
  Now here's an important part. All the scripts are written and stored in Notion, but our editors don't have Notion access at all. Instead we built this page on Vercel, which pulls the scripts straight from the client dashboards and shows them in a simple read-only view, so editors only ever need this one link.
  [SHOW: refreshing the page and opening one script]
  Whenever a script is added or changed in Notion, it shows up here after a refresh. The editor finds their video by name, reads the script and grabs the raw footage from the link on the task. Editors can't change anything on this page, so if a script looks wrong they flag it, it gets fixed in Notion, and the page updates on its own.
  [SHOW: Claude chats list]
  For the actual edit, client personal videos are done inside Claude, and each client has their own chat named after them, because that chat already holds the client's style and past edits. Motion-graphics clients go through Motion Studio instead, which has its own SOP. Sponsor videos are the exception, since our sponsor editor edits those manually to keep the quality tight for paying brands.
  [SHOW: the Done editing button on the script page]
  We assign around four to six videos a day, which works out to about two per client, and the goal is for every one to be finished the same day. When the editor is done, they upload the video to Frame.io, come back to this same script page and click Done editing, then submit the Frame.io link along with their name. So the script page is where the editor picks up the work and also where they hand it back, and that submission is where the review system takes over, which is the next SOP.
