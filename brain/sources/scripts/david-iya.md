# David Iya - posted scripts

The final scripts of videos posted in the last 60 days, as filmed.

## 2026-11-12 Zero Dollar Jarvis on Laptop
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    Someone built a Jarvis-style voice assistant that runs off your existing Claude subscription, so you just talk to your laptop and it handles the browser for you.
    Hook 2:
    Everyone’s posting a Jarvis clip right now, and it’s really just one repo and Claude Code.
    Body:
    So you don’t need to know any code for this, because Claude Code does the installing for you once you paste in the GitHub link. Then you open Chrome, click initialize and say “hey Jarvis,” and it comes online and starts listening. You can ask it to look things up or put on lo-fi while you work, and it’ll even pull screenshots over from your phone. If you connect Gmail it’ll read your inbox to you, though it always asks before it sends or deletes anything. The code is on GitHub and it runs on the Claude plan you’re already paying for, so you don’t need an API key and there’s no extra bill.
    CTA:
    Comment "JARVIS" and I'll get you the GitHub repo along with the exact prompt I'd paste into Claude Code.
    NOTES FOR REVIEW: Dropped the reference's Tony Stark lines and "last one still typing" close to avoid copying. CTA keyword changed from the reference's "hey" to "JARVIS". Please confirm the repo link, that it runs on a standard Claude plan with no API key, and the phone screenshot feature before filming. Voice modeled on the 7-day posted set (6 scripts).
    SOURCES
    - Jarvis (repo, features, read-only gate, requirements): https://github.com/adewaskar/jarvis
    - Claude Code: https://claude.com/product/claude-code
    - Sub-page: [[Build Your Own Jarvis Voice Assistant With Claude Code (Repo + Paste-In Prompt)]]

## 2026-11-11 Claude Cartoon
Type: PERSONAL. Creator: [[David Iya]].
Hook 2:
    These animated cartoon pages are some of the fastest-growing pages on Instagram and YouTube right now, and you can make one yourself inside Claude Code.
    Hook 3:
    Someone broke down the formula behind those trending animated cartoon pages and packed it into a free Claude skill.
    Body:
    These pages are blowing up because of a formula, and this skill decoded it from four of those channels: a quick cold open, the premise, the fun part, and then a twist built on one real fact, at around twenty-seven cuts a minute.
    You type the idea, and Claude writes the script and voices it, then shows you a storyboard before anything gets animated. Since every frame is drawn in code, the character never changes between shots.
    It’s called What If Animation, and Claude Animated Shorts does the longer story version, both free on GitHub.
    CTA:
    Comment “CARTOON” and I’ll send you both repos and the setup.
    SOURCES
    - Claude Animated Shorts: https://github.com/mromidev/claude-animated-shorts
    - What If Animation: https://github.com/kelano86/what-if-animation
    - Claude Code: https://claude.com/product/claude-code
    - Sub-page: [[Make Viral Animated Cartoon Shorts in Claude Code: 2 Repos + Full Setup]]

## 2026-11-11 Mac inside terminal
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    Someone just put a whole Mac inside a terminal, and they built it for Claude, not for you.
    Hook 2:
    This GitHub repo can literally give Claude its own Mac, running right inside yours
    Body:
    [DEMO: Claude drawing a diagram in Freeform inside the guest Mac while the real cursor stays still]
    This is Claude drawing a diagram in Freeform, clicking and typing away, and my actual cursor isn’t moving at all, because it’s working inside its own copy of macOS.
    Normally when Claude uses your computer, it takes over your real mouse, so you’re stuck waiting and every wrong click happens on your machine. Here it never touches your files or your clipboard, and it checks its own work as it goes.
    It’s still an early release, and the first run downloads several gigabytes of macOS, so give it some time to set up.
    The repo is called terminal-mac, it’s free, and it plugs into Claude Code with one command.
    CTA:
    Comment “MAC” and I’ll send you the repo and the exact install.
    resource:
    - Repo, tools, isolation, install, offline flag, RC status: https://github.com/govijr/terminal-mac
    - Claude Code plugin command (/plugin install terminal-mac --marketplace govijr/terminal-mac): https://github.com/govijr/terminal-mac#use-with-agents
    - Self-signed / not notarized, release date context: https://flaviocopes.com/run-macos-in-your-terminal/
    - Sub-page: [[terminal-mac: Give Claude Its Own Mac Inside Your Terminal (Repo + Exact Install)]]

## 2026-11-10 Agent Desktop - cut token usage
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

## 2026-11-09 200+ Motion Graphics repo
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    Someone just built a site with 200+ animations made entirely in Claude, and you can copy the prompt behind any of them.
    Hook 2:
    Everyone’s been posting motion graphics they made with Claude lately, and there’s a site that shows you the exact prompt behind like 200 of them.
    Body:
    So you can filter the whole gallery by style, like product UI or kinetic type, and you’re typically not scrolling for long before you find something close to what you need.
    And then you open the one you like and the prompt’s sitting right next to it, so you copy it and run it in Claude Code with your own project details swapped in to get the actual video file out. It’s called Prompt Motion, and I think it makes the most sense to grab one transition you’d actually use this week and build from that, because trying to save all 200 of them is probably where most people stall.
    CTA:
    So comment "PROMPTS" and I'll get you the gallery link.
    NOTES FOR REVIEW: Duncan's planner has the same reference video (Claude Motion Graphics library, also posting 2026-11-07). Hooks, angle and CTA here are kept separate from his, but it's worth deciding whether both should go out the same day. Count kept at "more than 200" (the site's own blog references around 230 examples). This sits close to last week's Orbit effects video, so I avoided its reusable-template framing. Voice modeled on the 7-day posted set (6 scripts).
    - Sub-page: [[Prompt Motion: 200+ Claude Motion Graphics With the Prompts Behind Them (Link + How to Use)]]

## 2026-11-06 Claude code auto-systemizer
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    Someone built a Claude Code skill that makes Claude get a bit better every time you use it.
    Hook 2:
    Claude Code keeps a copy of every session you run right on your own machine, and I think most people never actually look at what's sitting in there.
    Body:
    So every Claude Code session gets saved as a file locally, and that history is really a record of every time Claude got something wrong and how you actually like to work.
    [ON SCREEN: local session folder path, e.g. ~/.claude/projects]
    The skill I use is called Improve System, and it goes through those sessions and flags the mistakes I keep repeating along with the skills I should probably be writing.
    And the part I like most is that it spots the stuff I do by hand every day that typically takes a couple of hours, and then suggests an automation that would handle it in like a few minutes, so I'm not sitting there guessing what to build because it pulls that straight out of my sessions and writes the skill for me.
    CTA:
    So comment “SYSTEM” and I’ll send you the exact setup guide, which you can just paste into Claude Code and it’ll set the whole thing up for you.
    NOTES FOR REVIEW: I couldn't verify the Build Partner plugin or the Improve System skill online, so please confirm the plugin name, the exact command spelling and the install step before filming. CTA keyword changed from the reference's "improve" to "SYSTEM" so it doesn't copy the reference CTA. Voice modeled on the 7-day posted set (6 scripts).
    - Sub-page: [[The Self-Improving Claude Code Setup: Improve System (Paste-In Setup Guide)]]

## 2026-11-05 HARVEY
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    There’s a Claude Code agent whose only job is getting you clients, and it’s honestly the closest thing I’ve seen to replacing a lead gen agency.
    Hook 2:
    Lead gen agencies charge like a few thousand a month, and this one Claude Code agent basically does their whole job for you.
    Body:
    So you open it in Claude Code and describe your offer and the kind of client you want, and it goes out and finds companies that fit and reads through each one’s website to rank which are probably worth your time.
    It’s called Harvey, and the part I like is that every cold email it writes references something real from that company’s site, so it reads like you actually sat down and did the research yourself.
    And then when people reply it reads those too and keeps following up with the warm ones until there’s a call on your calendar, so since I run an agency on the side, this is probably the one I’d steal first.
    CTA:
So comment "LEADS" and I'll get you the GitHub link and how I'd set it up.
    - Sub-page: [[Harvey: The Claude Code Agent That Finds You Clients (GitHub Link + Setup)]]

## 2026-11-05 Claude killed Opus 5.5
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    Claude might’ve just killed Claude, because Opus 5.5 feels like a completely different model than it was at launch, and there’s a reason this keeps happening with every AI company.
    Hook 2:
If Opus 5.5 has felt worse lately, there’s usually a reason behind it, and once you understand it you’ll stop getting caught off guard every time a model changes.
    Body:
    So typically a new model launches and tops pretty much every benchmark, and a lot of people upgrade to the [amount]ax plan for it, and then a few weeks later the complaints start showing up on Reddit, which is exactly where Opus 5.5 is right now.
    And usually the model itself hasn’t been swapped out, but the things around it change, like the system prompt or how much it’s allowed to think by default, and a couple of times labs have actually had to admit that bugs on their end were making answers worse for weeks before anyone caught it.
    So what I do is keep a handful of tasks I ran in launch week and rerun them every so often, because then you’re comparing real outputs side by side, and if you’re paying like [amount]a month you should be the one who knows when something changed.
    CTA:
Comment 1 if Opus 5.5 still feels the same for you or 2 if you’ve noticed it slipping, and tell me which task you’d rerun first.
    - Sub-page: [[Is Your AI Model Getting Worse? The Drift Test Kit (Prompts + Setup)]]

## 2026-11-04 CLAUDE VIRAL REELS
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    Everyone posting daily seems to know exactly which hooks are working right now, and it’s really just one skill in Claude Code doing the research for them.
    Hook 2:
    The creators blowing up in your niche are pulling their hooks from reels that are already outperforming, and there’s a Claude skill that finds all of them for you.
    Body:
    So you give the skill one topic, say real estate or meal prep, and it goes through Instagram and finds the reels that are doing a lot better than what those accounts usually get.
    And then it grabs the opening line from every one of those reels and drops them into a Notion database, so you’ve got a running list of hooks that are working this week.
    From there you pick the ones that fit you, rewrite them in your own words, and your next few videos are basically planned before you even open the app.
    I run most of my research out of Claude Code anyway, so if you’re posting every day this is probably the first thing I’d set up.
    CTA:
    Comment "VIRAL" and I'll send you the skill and the full setup.
    - Sub-page: [[The Viral Hook Finder: Claude Code Skill + Full Setup]]
