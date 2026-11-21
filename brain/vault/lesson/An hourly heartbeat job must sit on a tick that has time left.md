---
type: lesson
---
When: Adding or moving a once-an-hour or once-a-day job in lib/heartbeat.js
Do: Gate jobs that run after the Invoices step with hourlyTailTick(tickMin), where tickMin is the minute the tick STARTED (read once from T0), and check PM RUNS steps show the job actually running
Never: Gate a job at the end of the tick on minute < 10 (the :04 tick, always out of time), and never read new Date().getUTCMinutes() when the step is reached: the :14 tick reaches its tail at minute 16
Seen 2 time(s). Source: System check.

## Links
- [[PM lessons  Other]]
