# n8n automations (NOOCAP)

n8n runs on Railway and connects Notion, Gmail, Discord and the [[NOOCAP PM]]. Inactive old ones are left out.

## Outreach · Gmail
Active. Sends outreach emails from harshkoli201@gmail.com and reads its inbox for replies, called by the NOOCAP PM.

## PM · Heartbeat
Off. Old trigger for the PM heartbeat; used manually to fire PM jobs.

## PM · Send Email
Active. Sends the PM's approved emails from the creators' inboxes.

## NOOCAP Pipeline Editor Ping Version 2
Active. Pings editors on Discord when a video is assigned.

## NOOCAP — EDIT TRACKER watcher (Review / Changes / To Post)
Active. Watches EDIT TRACKER: fires the Review, Changes and To Post editor alerts once each, and asks the PM to email the cut when a row is set to Send to Brand.

## NOOCAP — Done in thread → In Review
Active. When an editor says done in the video's Discord thread, moves the video to In Review.

## NOOCAP — Done in post thread → Posted + board 10- To Post
Active. Marks videos posted from the Discord post thread and moves the board card.

## Discord Script Pings
Active. Posts new scripts to Discord.

## NOOCAP — Changes → Editor Channel Thread
Active. Sends change requests to the editor's Discord thread.

## NOOCAP — Automation failed alerts
Active. Sends a Discord alert whenever any NOOCAP n8n workflow fails, with the step, error and a link to the run.

## NOOCAP — Edit progress in video thread
Active. Posts the editor's progress (started, Claude render done, sent for review, revisions) from the brief page into the video's Discord thread.

## NOOCAP — Leave Requests to Discord / Leave Decision to Discord
Active. Team leave requests and decisions posted to Discord.

## NOOCAP Discord new video needed
Active. Alerts when a creator needs a new video.

## PM · Chris inbox
Active. Every 3 minutes sends new emails from Chris's brand inbox to the PM (/api/leads).

## PM · Inbox / PM · Inbox v2 (sweep)
Active. Every 3 minutes sends new brand emails from the noocapcollab inbox to the PM (/api/inbox).

## PM · Drive
Active. Moves files between Google Drive and the PM.

## NOOCAP — Check-up report to Discord
Active. Receives the scheduled Claude check-up summary and posts it into the NOOCAP alerts Discord channel.

## NOOCAP — To Post → Editor Channel Thread (fixed)
Active. Tells the editor thread a video is ready to post.

## Final Review System
Active. Final review step before a video goes to the brand or creator.

## Lead magnet link lookup
Active. ManyChat calls this webhook to get the latest lead magnet link for a client (?client=lindsay).

## Content OS · YouTube sync / Instagram + Facebook + TikTok sync
Active. Pulls creators' social video stats into Content OS.
