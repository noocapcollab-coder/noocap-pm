# Graph Report - sources  (2026-11-27)

## Corpus Check
- Large corpus: 632 files · ~142,805 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 722 nodes · 804 edges · 68 communities (14 shown, 54 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Lindsay brand deals
- Chris brand deals
- Duncan brand deals
- Valeri brand deals
- Brad brand deals
- NOOCAP Systems — SOP Library / 02 — Video Review & Approval
- Emtech / Emtech - what performs
- House Graphics Catalogue / Chris Graphics Tweaks
- House Style / Chris Style Tweaks
- Newsletter Attribution System / n8n Attribution Workflow
- AI Outage Error Handling / api/inbox.js
- OneUp / David - what performs
- Readdy AI / Lindsay x Readdy Deal
- Claude / LINDSAY — DESIGN FILE (Motion Graphics)
- Bluehost 2 / Creator.co
- PhotoGenerator / KOL Connect Hub
- Pollo.AI / MarGrowth
- Hyper3D / NoxInfluencer
- Asana / The Shelf
- Velanir / Botero Labs, Inc.
- AI Learns / AI Learns - posted scripts
- David Iya / David Iya - posted scripts
- Nicole reels: the playbook / tools/nicole-reels: the Nicole reel pipeline
- Persistent Brand Chasing / Follow-up Timing Calculation
- Email Data Integrity / Posting Time Communication
- Nudge Retirement / Tool Access Email Logic
- Heartbeat Time Budgeting / lib/heartbeat.js
- PM lessons: Payments / PM lessons: WhatsApp
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
- PM lessons: Briefs & scripts
- PM lessons: Deals & data
- PM lessons: Emails
- Attachment Verification
- Brand Email Unread Policy
- Contact Splitting Policy
- Correct Recipient Threading
- Creator Signature Consistency
- Duplicate Draft Prevention
- Fixed Reply Automation
- Held Email Recording
- Official Inbox Addresses
- Loop-in Take-over Reply
- Thread CC Management
- PM lessons: Other
- Alert Deduplication
- Vercel Env Var Testing
- Test Bank Heartbeat Gates
- PM lessons: Video & editors
- PM memory: rules and facts Harsh and Pratham taught the PM
- PM memory
- Instantly
- Loom
- ManyChat
- Metricool

## God Nodes (most connected - your core abstractions)
1. `Chris` - 326 edges
2. `Lindsay` - 310 edges
3. `Duncan` - 22 edges
4. `NOOCAP Systems — SOP Library` - 14 edges
5. `Brad` - 12 edges
6. `Valeri` - 12 edges
7. `CapCut` - 10 edges
8. `Luma AI` - 7 edges
9. `Chris - brand feedback on our cuts` - 7 edges
10. `Dreamina` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Lindsay` --links to--> `AgentHelp.ai`  [EXTRACTED]
  creators/lindsay.md → brands/agenthelp.md
- `Lindsay` --links to--> `Asana`  [EXTRACTED]
  creators/lindsay.md → brands/asana.md
- `Lindsay` --links to--> `Avori`  [EXTRACTED]
  creators/lindsay.md → brands/avori.md
- `Lindsay` --links to--> `Bison`  [EXTRACTED]
  creators/lindsay.md → brands/bison.md
- `Lindsay` --links to--> `Creatify`  [EXTRACTED]
  creators/lindsay.md → brands/creatify.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Agency-Creator-Brand Collaboration** — agencies_quilmedia, creators_brad, brands_promocut [EXTRACTED 0.90]
- **Email Communication Standards** — lessons_emails_brand_email_unread, lessons_emails_posting_time, lessons_emails_contact_splitting, lessons_emails_creator_signature, lessons_emails_thread_cc [EXTRACTED 0.90]
- **Sparkols Brand Ecosystem** — brands_sparkols, brands_sparkolsagency [EXTRACTED 0.90]
- **System Reliability and Testing** — lessons_other_test_bank_gates, lessons_other_ai_outage_handling, lessons_other_heartbeat_budget, lessons_other_alert_deduplication [EXTRACTED 0.90]
- **Tencent Brand Ecosystem** — brands_tencent, brands_tencentdesignmiora [EXTRACTED 0.90]
- **Attribution Technology Stack** — pages_13_newsletter_attribution_n8n, pages_13_newsletter_attribution_railway_postgres, external_kit_beehiiv [EXTRACTED 0.95]
- **Automated Follow-up Logic** — lessons_emails_chase_interested_brand, lessons_emails_follow_up_timing, lessons_emails_nudge_retirement, lessons_emails_duplicate_draft_prevention [EXTRACTED 0.95]
- **Content & Strategy Flow** — pages_04-daily-script-generation, pages_05-lead-magnet-production, pages_06-manychat-dm-funnels, pages_07-carousel-automation, pages_12-creator-account-access-posting [EXTRACTED 1.00]
- **Lindsay's Brand Partnerships** — brands_100kauctionshq, brands_accomplishr, brands_asana [EXTRACTED 1.00]
- **Creator Performance Tracking** — performance_brad, performance_chris, performance_david, performance_duncan, performance_emtech, performance_lindsay, performance_nicole, performance_valeri [EXTRACTED 1.00]
- **Motion Studio Design System** — editing_claude, editing_house_style, editing_house_graphics [EXTRACTED 1.00]
- **Project Management Guidelines** — lessons_briefs-scripts, lessons_deals-data, lessons_emails [EXTRACTED 1.00]
- **PM Operational Rules** — lessons_payments, lessons_whatsapp [EXTRACTED 1.00]
- **Posted Scripts Archive** — scripts_ai-learns, scripts_chris, scripts_david-iya, scripts_duncan, scripts_lindsay, scripts_valeri [EXTRACTED 1.00]
- **Video Production Flow** — pages_01-video-assignment-editing-flow, pages_02-video-review-approval, pages_03-motion-studio-setup, pages_14-kpi-tracking-dashboard [EXTRACTED 1.00]
- **Creator Editing Playbooks** — editing_nicole_playbook, editing_tools_lindsay_reels_playbook, editing_lindsay-brief [INFERRED 0.80]
- **NOOCAP Automation Stack** — systems_n8n-workflows, noocap_pm, scripts_chris, scripts_duncan, scripts_lindsay [INFERRED 0.85]
- **Agency Managed Brand Partnerships** — brands_asana [INFERRED 0.90]
- **Creator-Brand Collaboration Network** — creators_lindsay, creators_chris, creators_valeri, creators_brad, creators_duncan, brands_capcut, brands_luma, brands_elevenlabs [INFERRED 0.90]

## Communities (68 total, 54 thin omitted)

### Community 0 - "Lindsay brand deals"
Cohesion: 0.01
Nodes (260): 100k Auctions HQ, AI 3D Platform, Aakash (representing an unnamed brand), Aakash, Abacus, Accomplishr, Aderra, AdsPower (+252 more)

### Community 1 - "Chris brand deals"
Cohesion: 0.01
Nodes (256): AI 3D Creation Platform, ACASIS, Accio Work, Aeocky, Agency 313, AgentHelp.ai, AIFY Media, AIKONIC (+248 more)

### Community 2 - "Duncan brand deals"
Cohesion: 0.07
Nodes (35): GlobeInflu, GrowMaxValue, Katlas Media, Mediacube, Redthread, Viral Nation, Viral Vibe, Avori (+27 more)

### Community 3 - "Valeri brand deals"
Cohesion: 0.07
Nodes (29): Arch Agency, House of Marketers, Jeevmedia, Kudos Narratives, Lua Group, The Breadwinners Club, ElevenLabs, Fish Audio (+21 more)

### Community 4 - "Brad brand deals"
Cohesion: 0.10
Nodes (24): Faved, NJ Agency, Quil Media, Aries, Bison, Buzzy AI, Kylon, Luma AI (+16 more)

### Community 5 - "NOOCAP Systems — SOP Library / 02 — Video Review & Approval"
Cohesion: 0.17
Nodes (18): Brand Deals Pipeline, EDIT TRACKER, 01 — Video Assignment & Editing Flow, 02 — Video Review & Approval, 03 — Motion Studio Setup, 04 — Daily Script Generation, 05 — Lead Magnet Production, 06 — ManyChat DM Funnels (+10 more)

### Community 6 - "Emtech / Emtech - what performs"
Cohesion: 0.40
Nodes (5): Instantly.ai, Microsoft, Polsia, Emtech, Emtech - what performs

### Community 7 - "House Graphics Catalogue / Chris Graphics Tweaks"
Cohesion: 0.40
Nodes (5): Chris Graphics Tweaks, House Graphics Catalogue, Lindsay Graphics Tweaks, Nicole Graphics Tweaks, Valeri Graphics Tweaks

### Community 8 - "House Style / Chris Style Tweaks"
Cohesion: 0.40
Nodes (5): Chris Style Tweaks, House Style, Lindsay Style Tweaks, Nicole Style Tweaks, Valeri Style Tweaks

### Community 9 - "Newsletter Attribution System / n8n Attribution Workflow"
Cohesion: 0.40
Nodes (5): Kit/beehiiv Newsletter, Skool Community, n8n Attribution Workflow, Railway Postgres Database, Newsletter Attribution System

### Community 10 - "AI Outage Error Handling / api/inbox.js"
Cohesion: 0.67
Nodes (3): api/inbox.js, api/leads.js, AI Outage Error Handling

### Community 11 - "OneUp / David - what performs"
Cohesion: 0.67
Nodes (3): OneUp, David, David - what performs

### Community 12 - "Readdy AI / Lindsay x Readdy Deal"
Cohesion: 0.67
Nodes (3): Readdy AI, Harper Collins, Lindsay x Readdy Deal

### Community 13 - "Claude / LINDSAY — DESIGN FILE (Motion Graphics)"
Cohesion: 0.67
Nodes (3): LINDSAY — DESIGN FILE (Motion Graphics), VALERI — DESIGN FILE (Motion Graphics), Claude

## Knowledge Gaps
- **579 isolated node(s):** `David Iya`, `AI Learns`, `Dmytro`, `Nicole`, `AdsPower` (+574 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 579 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **54 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Chris` connect `Chris brand deals` to `Lindsay brand deals`, `Duncan brand deals`, `Valeri brand deals`, `Brad brand deals`, `Emtech / Emtech - what performs`, `Bluehost 2 / Creator.co`, `PhotoGenerator / KOL Connect Hub`, `Pollo.AI / MarGrowth`, `Hyper3D / NoxInfluencer`?**
  _High betweenness centrality (0.510) - this node is a cross-community bridge._
- **What connects `David Iya`, `AI Learns`, `Dmytro` to the rest of the system?**
  _579 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Lindsay brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.007692307692307693 - nodes in this community are weakly interconnected._
- **Why does `Lindsay` connect `Lindsay brand deals` to `Chris brand deals`, `Duncan brand deals`, `Valeri brand deals`, `Brad brand deals`, `Emtech / Emtech - what performs`, `OneUp / David - what performs`, `Readdy AI / Lindsay x Readdy Deal`, `Bluehost 2 / Creator.co`, `PhotoGenerator / KOL Connect Hub`, `Pollo.AI / MarGrowth`, `Hyper3D / NoxInfluencer`, `Asana / The Shelf`, `Velanir / Botero Labs, Inc.`?**
  _High betweenness centrality (0.486) - this node is a cross-community bridge._
- **Should `Chris brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.0078125 - nodes in this community are weakly interconnected._
- **Why does `Duncan` connect `Duncan brand deals` to `Valeri brand deals`, `Brad brand deals`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Should `Duncan brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.06554621848739496 - nodes in this community are weakly interconnected._