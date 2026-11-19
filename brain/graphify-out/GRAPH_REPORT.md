# Graph Report - sources  (2026-11-19)

## Corpus Check
- Large corpus: 568 files · ~122,904 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 685 nodes · 735 edges · 79 communities (15 shown, 64 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Lindsay brand deals
- Chris brand deals
- Duncan brand deals
- Valeri brand deals
- NOOCAP Systems — SOP Library / 02 — Video Review & Approval
- Brad brand deals
- NOOCAP PM / NOOCAP · Contract sweep (weekly)
- House Graphics Catalogue / Chris Graphics Tweaks
- House Style / Chris Style Tweaks
- Newsletter Attribution System / n8n Attribution Workflow
- Emtech / Instantly.ai
- Harsh / PM lessons: Briefs & scripts
- Readdy AI / Lindsay x Readdy Deal
- Softr / Kat Simonova
- Claude / LINDSAY — DESIGN FILE (Motion Graphics)
- Bluehost / Creator.co
- Asana / The Shelf
- Hyper3D / NoxInfluencer
- Kylon / Widely
- OneUp / David - what performs
- Velanir / Botero Labs, Inc.
- Vmake AI / SSGMCN
- David Iya / David Iya - posted scripts
- Nicole reels: the playbook / tools/nicole-reels: the Nicole reel pipeline
- Framia Pro x Duncan Deal
- Higgsfield x Chris (Drama Greenscreen)
- Higgsfield x Lindsay (Brief Received)
- Holo AI x Chris Deal
- AI Inspo x Duncan Deal
- Luma AI x Chris Deal
- Luma AI x Duncan Deal
- Manyfast x Chris Deal
- Manyfast x Duncan Deal
- Migoo x Brad (In-person Session)
- Panda Security x Chris Deal
- Dmytro
- [CLIENT] — Graphics (tweaks on top of the house catalogue)
- [CLIENT] — Style (tweaks on top of the house style)
- Motion Studio House Rules
- House graphics catalogue (all clients)
- House style (all clients)
- Lindsay — Motion graphics brief
- Lindsay — Graphics (tweaks on top of the house catalogue)
- Lindsay — Style (tweaks on top of the house style)
- Nicole — Graphics
- Nicole reels: the playbook (what we learned)
- Nicole — Style (tweaks on top of the house style)
- Lindsay reels — playbook (rules learned from Harsh's feedback)
- Valeri — Graphics (tweaks on top of the house catalogue)
- Valeri — Style (tweaks on top of the house style)
- PM lessons: Other
- PM Lessons: Payments
- PM memory: rules and facts Harsh and Pratham taught the PM
- PM memory
- Cal.diy
- Numbat (Fake Leak)
- Open Generative AI
- OpenWhispr
- n8n automations (NOOCAP)
- NOOCAP — Automation failed alerts
- NOOCAP — Changes → Editor Channel Thread
- NOOCAP — Check-up report to Discord
- Content OS · Social Sync
- Discord Script Pings
- NOOCAP — Done in post thread → Posted
- NOOCAP — Done in thread → In Review
- NOOCAP — Edit progress in video thread
- Final Review System
- Lead magnet link lookup
- NOOCAP — Leave Requests to Discord
- NOOCAP Discord new video needed
- NOOCAP Pipeline Editor Ping Version 2
- PM · Heartbeat
- PM · Send Email
- NOOCAP — To Post → Editor Channel Thread
- Instantly
- Loom
- ManyChat
- Metricool

## God Nodes (most connected - your core abstractions)
1. `Chris` - 302 edges
2. `Lindsay` - 261 edges
3. `Valeri` - 21 edges
4. `Duncan` - 20 edges
5. `Brad` - 14 edges
6. `NOOCAP Systems — SOP Library` - 14 edges
7. `CapCut` - 7 edges
8. `Luma AI` - 6 edges
9. `Chris - brand feedback on our cuts` - 6 edges
10. `Tripo 3D` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Lindsay` --links to--> `Asana`  [EXTRACTED]
  creators/lindsay.md → brands/asana.md
- `Lindsay` --links to--> `Instantly.ai`  [EXTRACTED]
  creators/lindsay.md → brands/instantly.md
- `Lindsay` --links to--> `OneUp`  [EXTRACTED]
  creators/lindsay.md → brands/oneup.md
- `Lindsay x Readdy Deal` --references--> `Lindsay`  [EXTRACTED]
  brands/readdy.md → creators/lindsay.md
- `Lindsay x Tripo 3D Deal` --references--> `Lindsay`  [EXTRACTED]
  brands/tripo3d.md → creators/lindsay.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **NOOCAP Automation Ecosystem** — systems_n8n-workflows, noocap_pm, systems_n8n_workflows_automation_failed_alerts [EXTRACTED 0.90]
- **Open Source Subscription Replacements** — scripts_valeri_openwhispr, scripts_valeri_cal_diy, scripts_valeri_open_generative_ai [EXTRACTED 0.90]
- **Tencent Brand Ecosystem** — brands_tencent, brands_tencentcloud, brands_tencentdesignmiora [EXTRACTED 0.90]
- **Attribution Technology Stack** — pages_13_newsletter_attribution_n8n, pages_13_newsletter_attribution_railway_postgres, external_kit_beehiiv [EXTRACTED 0.95]
- **Agency-Brand Partnerships** — brands_runway_house_of_marketers, brands_tripo3d_jeevmedia, brands_virash_metelink, brands_vmake_ssgmcn, brands_zeely_mediacube [EXTRACTED 1.00]
- **Content & Strategy Flow** — pages_04-daily-script-generation, pages_05-lead-magnet-production, pages_06-manychat-dm-funnels, pages_07-carousel-automation, pages_12-creator-account-access-posting [EXTRACTED 1.00]
- **Lindsay's Brand Partnerships** — brands_100kauctionshq, brands_accomplishr [EXTRACTED 1.00]
- **Motion Studio Design System** — editing_claude, editing_house_style, editing_house_graphics [EXTRACTED 1.00]
- **Higgsfield Multi-Creator Campaign** — brands_higgsfield_lindsay_brief, brands_higgsfield_chris_drama, creators_chris [EXTRACTED 1.00]
- **Luma AI Multi-Creator Campaign** — brands_luma_chris, brands_luma_duncan, creators_lindsay, creators_brad [EXTRACTED 1.00]
- **NOOCAP PM Knowledge Base** — lessons_briefs-scripts, lessons_deals-data, lessons_emails, lessons_payments, lessons_video-editors, lessons_whatsapp [EXTRACTED 1.00]
- **Video Production Flow** — pages_01-video-assignment-editing-flow, pages_02-video-review-approval, pages_03-motion-studio-setup, pages_14-kpi-tracking-dashboard [EXTRACTED 1.00]
- **Creator Editing Playbooks** — editing_nicole_playbook, editing_tools_lindsay_reels_playbook, editing_lindsay-brief [INFERRED 0.80]
- **Script to Video Production** — scripts_ai-learns, scripts_chris, scripts_david-iya, scripts_duncan, scripts_lindsay, milo [INFERRED 0.80]
- **Low-Resource Large Model Inference** — scripts_valeri_airllm, scripts_valeri_mesh_llm [INFERRED 0.85]
- **Creator-Brand Collaboration Network** — creators_chris, creators_lindsay, creators_valeri, creators_brad [INFERRED 0.90]
- **Creator Collaboration Network** — creators_lindsay, creators_chris, creators_duncan, creators_brad, creators_valeri [INFERRED 0.90]
- **Creator Performance Tracking** — performance_brad, performance_chris, performance_david, performance_duncan, performance_emtech, performance_lindsay, performance_nicole, performance_valeri [INFERRED 0.90]

## Communities (79 total, 64 thin omitted)

### Community 0 - "Lindsay brand deals"
Cohesion: 0.01
Nodes (232): 100k Auctions HQ, AI 3D Platform, Aakash (representing an unnamed brand), Aakash, Accomplishr, Aderra, Agency Autopilot, AhaCreator (+224 more)

### Community 1 - "Chris brand deals"
Cohesion: 0.01
Nodes (230): AI 3D Creation Platform, Abacus AI, ACASIS, Accio Work, Aeocky, AIFY Media, AIKONIC, AIQORA AI (+222 more)

### Community 2 - "Duncan brand deals"
Cohesion: 0.06
Nodes (40): GrowMaxValue, Kudos Narratives, Luminary SM, Slate Media Co., Ltd., Viral Nation, CapCut, ChatGPT, Dreamina (+32 more)

### Community 3 - "Valeri brand deals"
Cohesion: 0.06
Nodes (36): Arch Agency, Lua Group, Aries, Higgsfield, Holo AI, Kimi, Lovart, Panda Security (+28 more)

### Community 4 - "NOOCAP Systems — SOP Library / 02 — Video Review & Approval"
Cohesion: 0.17
Nodes (18): Brand Deals Pipeline, EDIT TRACKER, 01 — Video Assignment & Editing Flow, 02 — Video Review & Approval, 03 — Motion Studio Setup, 04 — Daily Script Generation, 05 — Lead Magnet Production, 06 — ManyChat DM Funnels (+10 more)

### Community 5 - "Brad brand deals"
Cohesion: 0.15
Nodes (17): Faved, Buzzy AI, Luma AI, Migoo (in-person session), PromoCut, PromoCut x Brad Deal, Teamily, Topview AI (+9 more)

### Community 6 - "NOOCAP PM / NOOCAP · Contract sweep (weekly)"
Cohesion: 0.29
Nodes (7): NOOCAP PM, NOOCAP · Contract sweep (weekly), NOOCAP — EDIT TRACKER watcher, Outreach · Gmail, PM · Chris inbox, PM · Drive, PM · Inbox / PM · Inbox v2 (sweep)

### Community 7 - "House Graphics Catalogue / Chris Graphics Tweaks"
Cohesion: 0.40
Nodes (5): Chris Graphics Tweaks, House Graphics Catalogue, Lindsay Graphics Tweaks, Nicole Graphics Tweaks, Valeri Graphics Tweaks

### Community 8 - "House Style / Chris Style Tweaks"
Cohesion: 0.40
Nodes (5): Chris Style Tweaks, House Style, Lindsay Style Tweaks, Nicole Style Tweaks, Valeri Style Tweaks

### Community 9 - "Newsletter Attribution System / n8n Attribution Workflow"
Cohesion: 0.40
Nodes (5): Kit/beehiiv Newsletter, Skool Community, n8n Attribution Workflow, Railway Postgres Database, Newsletter Attribution System

### Community 10 - "Emtech / Instantly.ai"
Cohesion: 0.50
Nodes (4): Instantly.ai, Polsia, Emtech, Emtech - what performs

### Community 11 - "Harsh / PM lessons: Briefs & scripts"
Cohesion: 0.50
Nodes (4): Harsh, PM lessons: Briefs & scripts, PM lessons: Video & editors, PM Lessons: WhatsApp

### Community 12 - "Readdy AI / Lindsay x Readdy Deal"
Cohesion: 0.67
Nodes (3): Readdy AI, Harper Collins, Lindsay x Readdy Deal

### Community 13 - "Softr / Kat Simonova"
Cohesion: 0.67
Nodes (3): Softr, Kat Simonova, Tim Fisher

### Community 14 - "Claude / LINDSAY — DESIGN FILE (Motion Graphics)"
Cohesion: 0.67
Nodes (3): LINDSAY — DESIGN FILE (Motion Graphics), VALERI — DESIGN FILE (Motion Graphics), Claude

## Knowledge Gaps
- **556 isolated node(s):** `David Iya`, `AI Learns`, `Dmytro`, `Nicole`, `Chatava` (+551 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 556 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **64 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Chris` connect `Chris brand deals` to `Lindsay brand deals`, `Duncan brand deals`, `Valeri brand deals`, `Brad brand deals`, `Emtech / Instantly.ai`, `Bluehost / Creator.co`, `Hyper3D / NoxInfluencer`, `Kylon / Widely`?**
  _High betweenness centrality (0.495) - this node is a cross-community bridge._
- **What connects `David Iya`, `AI Learns`, `Dmytro` to the rest of the system?**
  _556 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Lindsay brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.008620689655172414 - nodes in this community are weakly interconnected._
- **Why does `Lindsay` connect `Lindsay brand deals` to `Duncan brand deals`, `Valeri brand deals`, `Brad brand deals`, `Emtech / Instantly.ai`, `Readdy AI / Lindsay x Readdy Deal`, `Softr / Kat Simonova`, `Bluehost / Creator.co`, `Asana / The Shelf`, `Hyper3D / NoxInfluencer`, `Kylon / Widely`, `OneUp / David - what performs`, `Velanir / Botero Labs, Inc.`, `Vmake AI / SSGMCN`?**
  _High betweenness centrality (0.440) - this node is a cross-community bridge._
- **Should `Chris brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.008695652173913044 - nodes in this community are weakly interconnected._
- **Why does `Duncan` connect `Duncan brand deals` to `Brad brand deals`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Should `Duncan brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.05512820512820513 - nodes in this community are weakly interconnected._