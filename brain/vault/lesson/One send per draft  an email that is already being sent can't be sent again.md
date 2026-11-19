---
type: lesson
---
When: Any send of a PM OUTBOX draft (Send in Approvals, WhatsApp send, sendoutbox hook, auto-send)
Do: Each send writes its own claim into Error, waits 2 seconds and reads it back; only the send whose claim is still there goes ahead, and a fresh claim (under 3 minutes) blocks any other send
Never: Never send a draft that another send has already claimed, and Claude never calls sendoutbox on a draft sitting in Approvals without first checking Harsh hasn't already pressed Send
Seen 1 time(s). Source: Harsh correction.

## Links
- [[PM lessons  Emails]]
