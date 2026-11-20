---
type: lesson
---
When: Both Claude and the Gemini fallback fail and the error text is cut before it is logged or checked for alerts
Do: Put the first provider's reason (Claude's spend limit, no credit) at the start of the combined error, so every slice still shows it and the spend-limit alert to Harsh fires once
Never: Never append the root cause after a long provider body; api/inbox.js and api/leads.js cut errors to 300 characters and the alert then never fires
Seen 1 time(s). Source: System check.

## Links
- [[PM lessons  Other]]
