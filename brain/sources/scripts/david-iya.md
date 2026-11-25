# David Iya - posted scripts

The final scripts of videos posted in the last 60 days, as filmed.

## 2026-11-23 REANIMATE - CLAUDE SKILL
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
There's a free Claude Code skill that takes any animation you've seen and works out how it was built, and then it rebuilds it in your own code.
    Hook 2:
Someone just dropped a Claude Code skill that lets you reverse engineer pretty much any animation and rebuild it in your own code.
    Body:
So you point it at a live site or a screen recording, and it goes through the animation frame by frame and writes down every element on screen, including when it starts and how it eases. Then it rebuilds it in whatever your project already uses, like CSS or GSAP, and records its own version next to the original so it can check the timing actually matches. It's open source with no API keys, and it's called Reanimate, so you just give Claude Code the GitHub link and type slash reanimate.
    CTA:
So comment "REBUILD" and I'll get you the GitHub link plus a couple of animations worth testing it on.

## 2026-11-24 CLAUDE 2.0 IN 90 SEC
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
Claude 2.0 just came out, and here are the four major changes Anthropic made in under a minute.
    Hook 2:
Anthropic just dropped Claude 2.0, and here are the four major changes they made in under a minute.
    Body:
So number one is split view, which puts two sessions side by side so you're not flipping between windows. Number two is mods, small pieces of code that sit in front of Claude, so you could set one up with your brand rules and every prompt runs through it first. Then the session panel shows what each session is doing and how much context you've used, so you see the limit coming. Next is projects, still in beta for some accounts, where you talk to one Claude session and it hands the work out to its own agents and pulls back what they send.
    CTA:
So comment "DESKTOP" and I'll get you a quick rundown of all six features.

## 2026-11-25 SAVED REELS
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
If you've got like 200 saved reels you're probably never going to open again, Claude can sort through the whole pile for you with one prompt.
    Hook 2:
When did you last open your saved reels folder, because if it's been more than 30 days, there's a much better place for those reels to go.
    Body:
So typically when you see a reel worth keeping you hit save, and it just sits in a folder you never open again. Instead, you share it over to an app called Recall, which pulls out what's actually said in it. Then like a month later you can search for it by what the person actually explained, rather than scrolling through 200 saves trying to remember who posted it.
    CTA:
So comment "SORT" and I'll get you the exact setup.

## 2026-11-18 OPEN JARVIS - 2
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
Stanford just made Siri look like a toy, because they put out an open source Jarvis that runs on your own laptop and you never pay a subscription for it.
    Hook 2:
Everyone’s posting Jarvis clips while Stanford quietly open sourced a version that lives on your laptop and can read your Gmail back to you out loud.
    Body:
So you hand the GitHub link to Claude Code and ask it to do the install, and it typically sets the whole thing up for you. And then you choose a voice so you're speaking to it out loud, and once it's hooked into your Gmail and calendar it can tell you what's on your day and which clients are still waiting on a reply. The part I like most is that it all stays on your own machine, so your inbox isn't being sent anywhere and there's no monthly bill. It's called OpenJarvis, and it's open source on GitHub.
    CTA:
So comment "LOCAL" and I'll get you the repo along with the prompt I'd give Claude Code to install it.
    - Sub-page: [[OpenJarvis: Stanford's Local AI Assistant on Your Laptop (Repo + Claude Code Install Prompt)]]

## 2026-11-19 MCP IS DEAD
Type: PERSONAL. Creator: [[David Iya]].
ONSCREEN HOOK:
Cloudflare and Anthropic quietly changed how agents use MCP
    Hook 1:
Cloudflare basically killed the way most of us have been using MCP, because they fit 2,500 endpoints into about 1,000 tokens.
    Hook 2:
Forget MCP as you know it, because companies like Cloudflare and Anthropic are moving to a setup where the model writes code to call tools instead of calling them one by one.
    Body:
So the problem is really two-fold, because every MCP call has to go out and return to the model before the next one starts, and once you've connected hundreds of tools the list by itself eats most of your context. Cloudflare's fix is called Code Mode, where tools get rewritten as a TypeScript API so the model can write one small script that chains the calls in a sandbox, and only the final answer comes back. It makes sense because these models have seen way more real code than tool calls. Anthropic's version is called programmatic tool calling, which is why I think the one-call-at-a-time way of using MCP is probably on its way out.
    CTA:
So comment "CODEMODE" and I'll get you Cloudflare's write-up and how I'd think about it in Claude Code.

## 2026-11-20 FASTEST GROWING CLAUDE SKILLS
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
These are the nine fastest growing Claude skills on GitHub in the last 30 days, and one of them is Cloudflare’s own security audit process.
    Hook 2:
These are nine of the fastest growing Claude skills on GitHub right now, and most people using Claude Code haven’t installed a single one of them.
    Body:
So Everything Claude Code installs a whole setup in one line, and Ponytail keeps Claude coding efficiently so you’re saving tokens. Impeccable catches the spacing and alignment issues I usually end up fixing on client sites, and Hallmark flags that typical AI-generated look before your page ships. Google’s Stitch Skills let Claude turn a design into React code and back again, and Claude Trading Skills runs a daily market check and keeps a journal of your trades. Matt Pocock’s skills cover the whole engineering workflow, and Anatomy breaks any idea down part by part. But the one I’d install first is Cloudflare’s security audit, because it’s their own internal process and it goes through your codebase and tells you what to fix.
    CTA:
So comment "SKILLS" and I'll get you every link with the install commands.
    - Sub-page: [[9 Fastest Growing Claude Skills on GitHub (All Links + Install Commands)]]

## 2026-11-19 HYPIT
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
Somebody just dropped a repo that lets Claude Code take a video that already went viral and turn it into a template you fill with your own stuff.
    Hook 2:
This repo hit number one on GitHub, and it can turn Claude Code into a content machine that rebuilds videos that already went viral.
    Body:
So there are really two repos here, and number one is the template one, where you give Claude Code a video that's already doing well and it breaks it down into a structure you fill with your own stuff. Then the second is HyperFrames, which builds the video, so you hand it your audio, either a voice clone or your own recording, and if you've got a mascot it can use Rhubarb to sync the mouth to your words. And then you give it your brand assets and talk through how it should play out with voice-to-text, which honestly feels a lot like briefing an editor.
    CTA:
So comment "TEMPLATE" and I'll get you both repos and the order I'd run them in.

## 2026-11-17 TOP 5 PLUGINS FOR CLAUDE
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
These are the top 5 AI plugins that you need to install in Claude Code right now.
    Hook 2:
Did you hit a Claude Code usage limit more than twice last week, because there's a free plugin that just moves you onto another model when that happens?
    Body:
Number one is Ponytail, which trims what Claude Code outputs so you typically use around half the tokens, and number two is FreeLLM API, which moves you onto one of like 600 free models when you hit a limit. Number three, AgentReach, pulls data off sites like LinkedIn and Reddit for you, and number four gives Claude Code like 60 animation styles for explainer videos. But number five is the one I’d honestly install first, because NVIDIA’s SkillSpectre checks a skill for hidden malware before you add it, a bit like a security check at the door.
    CTA:
Comment "SEND" and I'll get you all five links and the order I'd install them in.
    - Sub-page: [[The Top 5 Claude Code Plugins (All 5 Links + The Order I'd Install Them)]]
