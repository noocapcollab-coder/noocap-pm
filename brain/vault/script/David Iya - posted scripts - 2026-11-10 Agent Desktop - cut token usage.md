---
type: script
---
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    Vercel just open-sourced a tool that cuts the tokens your agent burns on desktop apps by like 80%, and it does that by skipping screenshots completely.
    Hook 2:
    So every time an agent screenshots your screen it probably costs you like a thousand tokens or more, and this new repo from Vercel gets around that.
    Body:
    So instead of looking at pictures of your apps, it reads the accessibility tree your operating system already exposes, and the agent gets back a structured list of every button and field it can actually click. In their own numbers, a simulated 52-step task went from around 198,000 tokens down to like 31,000. It’s called Agent Desktop, and it’s open source under Apache 2.0, so you can install it with one npm command and point Claude Code at it.
    CTA:
    So comment "DESKTOP" and I'll get you the repo and how I'd hook it into Claude Code.
    NOTES FOR REVIEW: Fact fix: the transcript says it reads the apps' source code, but Agent Desktop reads the OS accessibility tree (macOS AX, Windows UI Automation, Linux AT-SPI). 198k to 31k is about 84%, so the hook says "like 80%". The benchmark is Vercel's own simulated test. Please confirm the GitHub link before filming. CTA keyword changed from the reference's "Vercel" to "DESKTOP". Voice modeled on the 7-day posted set (6 scripts).
    - Sub-page: [[Agent Desktop: Let Claude Code Use Your Desktop Apps Without Screenshots (Repo + Setup)]]

## Links
- [[Agent Desktop  Let Claude Code Use Your Desktop Apps Without Screenshots (Repo + Setup)]]
- [[David Iya]]
- [[David Iya - posted scripts]]
