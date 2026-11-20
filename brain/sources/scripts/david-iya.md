# David Iya - posted scripts

The final scripts of videos posted in the last 60 days, as filmed.

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

## 2026-11-18 ASK CLAUDE YOUR SECRET
Type: PERSONAL. Creator: [[David Iya]].
On-screen text:
    Claude knows you better than you do 👀
    Hook 1:
There’s a test going around right now where you ask Claude what it’s figured out about you, and people who try it say it brings up things they never actually told it.
    Hook 2:
Claude can show you where your life is headed in five years if nothing changes, and it does it using only what you’ve told it in your chats.
    Body:
So the one everyone’s sharing is where Claude maps out your next five years assuming nothing changes, and then a second version where you fix the thing that’s held you back the longest, with both laid out side by side. But that one typically lands harder after two warm-up prompts, so the first asks Claude to name five things it’s worked out about you that you never actually said, and to be blunt about it, and the second asks how you make decisions and what you keep putting off. You need memory switched on in Claude, and it works in ChatGPT too, but it’s only reading your chats, so it’ll probably get some of it wrong.
    CTA:
Comment “SECRET” and I’ll get you all three prompts written out so you can paste them in.
    - Sub-page: [[Ask Claude What It Knows About You: The 3 Prompts (Copy + Paste)]]

## 2026-11-17 CLAUDE KILLED INSTAGRAM
Type: PERSONAL. Creator: [[David Iya]].
On-Screen Hook:
    Claude just killed Instagram 💀
    Hook 1:
Claude just killed Instagram, because it can now basically run your entire Instagram content for you.
    Hook 2:
Someone just dropped a free Claude skill that runs your entire Instagram for you.
    Body:
So it’s really like 11 smaller skills in one pack, and each one handles its own piece, so one drafts posts from a library of hook formats and another goes through your profile and suggests what to fix. But the one I’d actually start with is virality, because it goes through the reels doing best in your niche and works out why their hooks landed, and then it writes you an original script built on that, in your voice. Then the planning skill maps out your week around that script, which typically saves the most time, and setup is just giving Claude the link.
    CTA:
Comment “REELS” and I’ll get you the skill pack.
    SKILL NAME: Instagram Agent Skill 
    - Sub-page: [[The Instagram Agent Skill Pack: Let Claude Run Your Content (Repo + Setup + Order to Use)]]

## 2026-11-17 CLAUDE KILLED DAY TRADERS
Type: PERSONAL. Creator: [[David Iya]].
On-Screen Hook 1:
    Claude just killed day trading 📉
    Hook 1:
Claude just killed day trading, because you can now run full-on market research right inside Claude.
    Hook 2:
Someone built a set of Claude skills that scans thousands of charts for setups and then backtests your strategy against years of past market data.
    Body:
So there are really two parts to this, and the first is the daily research, where one skill goes through thousands of charts looking for setups while another keeps an eye on the news as it breaks, and the others fill in the rest of the prep. The second part is backtesting, which takes your strategy and tests it against years of past market data, so you get a sense of how it would have held up before any real money goes in. It won’t place any trades for you and nothing like this can guarantee a result, so it’s really the prep work you do before making your own call, and setup is just giving Claude the link and asking it to install the skills.
    CTA:
Comment “CHARTS” and I’ll get you the link plus the setup I’d run in Claude.
    - Sub-page: [[The Day Trader Skill Pack: Market Research and Trade Prep in Claude (Repo + Setup)]]

## 2026-11-14 Astryx, Meta's own internal design library
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    The part of vibe coding I typically spend the most time fixing is the UI, and Meta open-sourced the component library behind over 13,000 of their own internal apps.
    Hook 2:
    Meta open-sourced the design system they've been building internally for like eight years, and it's honestly the first thing I'd hand Claude Code before building any UI.
    Body:
    So it’s over 150 React components that Meta organized into families to make really good UI and UX, and it comes with themes, dark mode and page templates on top of that. It also ships with its own CLI, so Claude Code can actually look up the right component instead of guessing at spacing and layout. What I’d do is start with one page of your app, or one client dashboard at the agency, see how far it gets you, and then roll it out from there. It’s called Astryx, it’s MIT licensed, and it’s sitting at over 20,000 stars on GitHub.
    CTA:
    So comment “DESIGN” and I’ll send you the repo and how I’d set it up in Claude Code.
    - Sub-page: [[Astryx: Meta's Open Source Design System for Claude Code (Repo + Setup)]]

## 2026-11-18 Claude model router
Type: PERSONAL. Creator: [[David Iya]].
Hook (Zack D Films-style 3D animation):
reference: https://www.instagram.com/p/DfhdW3cMmOD/
    You wouldn’t hire a surgeon to put on band-aids, so why is your top AI model renaming variables? Here’s which model should handle what.
    Edit note: Show a 3D operating room. A surgeon in full scrubs, with a “TOP MODEL” badge on the cap, leans over a tiny paper cut and carefully puts on a band-aid while a usage meter on the wall drains with every move. On “renaming variables”, the band-aid wrapper flips to show rename_var. On “here’s which model should handle what”, hard cut to David.
    Body (David talking to camera):
    So renames, boilerplate and searching the codebase go to the smallest model, and the actual building can usually drop to the middle one. Auth, payments, and a bug you’ve chased for an hour stay on the stronger model with the effort turned up, and planning gets the top model, because a bad plan costs you the most later. Then I have a different model review the code. You can pin a model and effort level on each subagent, so you really set this up once.
    CTA:
    So comment “MODELS” and I’ll send you the full routing sheet.
    Sources
    - https://code.claude.com/docs/en/sub-agents
    - https://tech-insider.org/ie/claude-opus-vs-sonnet-vs-haiku-5-5-pricing-2026/
    - https://www.developersdigest.tech/models/claude-opus-5-5
    - Sub-page: [[The Claude Code Model Routing Sheet: Which Model Handles What (+ Ready-Made Subagents)]]

## 2026-11-13 Claude minimalistic graphics
Type: PERSONAL. Creator: [[David Iya]].
Hook:
    If you type slash breakdown into Claude Code, it takes your product and pulls it apart into an animation like this, labelling every piece without you ever opening an editor.
    Body:
    And if you type slash graph and add your numbers, it draws the line while the big number counts up, and slash map route draws a 3D route between any two places you give it. There’s also slash minimalistic graphics, which turns one line of text into a clean dot-and-steps animation and slash Zack D Films, which turns a what-if question into a 3D animated explainer. It’s called Claude Animation Skills and it’s free on GitHub.
    CTA:
    So comment “EXPLAIN” and I’ll send you the repo and my setup.
    Sources
    - claude-video-effects (GitHub)
    - SKILL.md
    - Sub-page: [[Claude Animation Skills: 6 Slash Commands That Make Reel Animations (Repo + Setup)]]

## 2026-11-12 100 fake customers
Creator: [[David Iya]].
Hook 1:
    Someone built a free set of Claude skills that acts like your CFO and a room full of 100 customers, so you find out your idea won’t sell before you build it.
    Hook 2:
    There’s a free pack of 11 Claude skills that tests your business idea on like 100 buyers before you spend a dollar.
    Body:
    So three skills do most of the work.
    First is the CFO, which finds your real margin and how much cash you need before it pays for itself.
    Second is the board, which scores your idea through Hormozi, Thiel, and Jobs frameworks and votes on it.
    And third, I think this is the best one, the consumer panel, like 100 buyers, each with their own income and reason to say no, telling you who’d pay and why the rest walked.
    They’re simulated, so test the winner on real people. It’s called Founder.
    CTA:
    Comment “BUYERS” and I’ll send you all 11 and the order to run them.
    Resources:
    - https://github.com/Jakeschincariol/founder-skill
    - Sub-page: [[Founder: 11 Claude Skills That Test Your Idea on 100 Buyers Before You Build (Repo + Order to Run)]]

## 2026-11-13 ASD-STE-100
Type: PERSONAL. Creator: [[David Iya]].
Hook 1:
    There’s a writing trick from aircraft maintenance manuals that makes Claude way easier to read, and it’s one of four that Karpathy shared.
    Hook 3:
    Andrej Karpathy, who co-founded OpenAI and now works at Anthropic, shared four ways he gets AI to explain things better, and the first one comes from aerospace manuals.
    Body:
    So the first one is asking for the answer in HTML, so a question about loan payments comes back as an actual calculator with sliders.
    Then you ask for a diagram instead of more text, and the one he’s most excited about is a fully custom explainer video, like a 3Blue1Brown style video with ElevenLabs doing the narration.
    And the writing one is asking it to explain in ASD-STE100, the simplified English aerospace uses so a repair step can’t be misread, and I’d typically say follow it about 80% of the way so it doesn’t sound robotic.
    His point is code is cheap now, so it makes sense to ask for throwaway stuff you’d never have built before, and your job becomes checking that it’s right.
    CTA:
    Comment “MANUAL” and I’ll send you all four prompts.
    SOURCES
    - Karpathy’s post (four formats, video prompt, 80%): https://x.com/karpathy/status/2105819303471976479
    - Breakdown + fact-check of the post: https://max.nardit.com/articles/karpathy-understanding-llm-outputs
    - Karpathy joins Anthropic pre-training: https://techcrunch.com/2026/05/19/openai-co-founder-andrej-karpathy-joins-anthropics-pre-training-team/
    - ASD-STE100 official site: https://www.asd-ste100.org/STE_faq.html
    - Claude Code: https://claude.com/product/claude-code
    - Sub-page: [[Karpathy's 4 Ways to Make AI Explain Things Better (All 4 Prompts + Setup)]]
