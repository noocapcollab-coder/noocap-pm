---
type: lesson
---
When: Running the test bank (/api/daily) after a commit, a new lesson or at night
Do: Stop starting cases at 170 s and give up on any single case after 55 s, counting it as not run, so the last batch and the write-back always fit.
Never: Start cases right up to the limit with no cap per case, so a slow model call gets the whole run killed and its results lost.
Seen 1 time(s). Source: System check.

## Links
- [[PM lessons  Other]]
