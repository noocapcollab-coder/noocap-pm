# PM lessons: Other

Mistakes the PM made once and the rule that came out of each.

## An hourly heartbeat job must sit on a tick that has time left
When: Adding or moving a once-an-hour or once-a-day job in lib/heartbeat.js
Do: Gate jobs that run after the Invoices step with hourlyTailTick(tickMin), where tickMin is the minute the tick STARTED (read once from T0), and check PM RUNS steps show the job actually running
Never: Gate a job at the end of the tick on minute < 10 (the :04 tick, always out of time), and never read new Date().getUTCMinutes() when the step is reached: the :14 tick reaches its tail at minute 16
Seen 2 time(s). Source: System check.
## Tests must not read live Vercel env vars
When: Adding code that reads a Vercel env var (AI_PAUSED_UNTIL, PM_AI_PROVIDER, GEMINI_API_KEY and the like) on a path the tests exercise
Do: Clear or pin that env var in both the npm test and vercel-build scripts, and run the tests once with the live value set before pushing
Never: Never let a test pass locally but depend on an env var that is set differently on Vercel, because a failed build leaves production on the old commit silently
Seen 1 time(s). Source: System check.
## One alert, one post, however many PM copies are running
When: Any alert to #pm-alerts or WhatsApp, including the Claude-down notice
Do: Write a claim row first, wait a few seconds, re-read the claims and post only if ours is the earliest (ties go to the smallest page id)
Never: Never post an alert just because the log showed nothing a moment ago, since several Vercel copies check at the same second and all post
Seen 1 time(s). Source: Harsh correction.
## A system alert goes out once, not once per copy of the PM
When: The PM wants to tell Harsh about a lasting condition (Claude out, Gemini in use, a key failing)
Do: Check the AGENT LOG for the same alert in the last hours before posting, and log it when posting, so every Vercel instance shares the one record
Never: Never rely on an in-memory 'already sent' flag: each Vercel instance starts fresh, so the alert repeats on every cold start
Seen 1 time(s). Source: Harsh correction.
## An AI outage error keeps its root cause at the front, so cut error text still raises the right alert
When: Both Claude and the Gemini fallback fail and the error text is cut before it is logged or checked for alerts
Do: Put the first provider's reason (Claude's spend limit, no credit) at the start of the combined error, so every slice still shows it and the spend-limit alert to Harsh fires once
Never: Never append the root cause after a long provider body; api/inbox.js and api/leads.js cut errors to 300 characters and the alert then never fires
Seen 1 time(s). Source: System check.
## When every AI provider fails, the error must say why each one failed
When: An AI call falls back from Claude to Gemini and Gemini fails too
Do: Keep Claude's own error next to Gemini's in the thrown message, so PM RUNS shows the real cause and the spend-limit alert can fire
Never: Throw only the last provider's error and hide why Claude was out
Seen 1 time(s). Source: System check.
## A test bank run must finish inside Vercel's 300 s limit
When: Running the test bank (/api/daily) after a commit, a new lesson or at night
Do: Stop starting cases at 170 s and give up on any single case after 55 s, counting it as not run, so the last batch and the write-back always fit.
Never: Start cases right up to the limit with no cap per case, so a slow model call gets the whole run killed and its results lost.
Seen 1 time(s). Source: System check.
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
