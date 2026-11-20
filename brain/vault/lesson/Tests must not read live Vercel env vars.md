---
type: lesson
---
When: Adding code that reads a Vercel env var (AI_PAUSED_UNTIL, PM_AI_PROVIDER, GEMINI_API_KEY and the like) on a path the tests exercise
Do: Clear or pin that env var in both the npm test and vercel-build scripts, and run the tests once with the live value set before pushing
Never: Never let a test pass locally but depend on an env var that is set differently on Vercel, because a failed build leaves production on the old commit silently
Seen 1 time(s). Source: System check.

## Links
- [[PM lessons  Other]]
