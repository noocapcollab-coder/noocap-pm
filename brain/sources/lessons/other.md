# PM lessons: Other

Mistakes the PM made once and the rule that came out of each.

## Never repeat an action that posts or sends
When: Testing or triggering a hook that posts to Discord, WhatsApp or email
Do: Wait until the new deployment is READY, dry-run first, then call it once.
Never: Never call a sending hook in a retry or polling loop.
Seen 1 time(s). Source: Claude.
## When the AI can't run, Harsh hears it once, straight away
When: Claude calls fail with a spend limit or no credit ("You have reached your specified API usage limits", "credit balance")
Do: Send one ⚠️ alert that brand emails are not being read and that the spend limit needs raising at console.anthropic.com, then keep the emails unread so they are processed once it is raised
Never: Never keep retrying emails for hours without telling anyone; never mark them as handled
Seen 2 time(s). Source: System check.
