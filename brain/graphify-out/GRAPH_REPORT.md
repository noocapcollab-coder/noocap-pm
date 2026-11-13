# Graph Report - sources  (2026-11-13)

## Corpus Check
- Large corpus: 502 files · ~106,077 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 587 nodes · 638 edges · 57 communities (11 shown, 46 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Chris brand deals
- Lindsay brand deals
- Valeri brand deals
- NOOCAP Systems — SOP Library / 01 — Video Assignment & Editing Flow
- Duncan brand deals
- Brad brand deals
- Harsh / Only use WhatsApp templates Meta has approved
- Nicole / Lindsay - what performs
- Motion Studio House Rules / House Style
- Emtech / Instantly.ai
- Claude / LINDSAY — DESIGN FILE (Motion Graphics)
- Joylo / Closedune
- Halliday / KOL Summit
- OiiOii / Luminary SM
- Pollo.AI / MarGrowth
- Hyper3D / NoxInfluencer
- Kylon / Widely
- Emergent / Gautam Mahajan
- GetRamped / Celina Otero
- OneUp / David - what performs
- SpeakOn AI / NOTTA PTE. LTD.
- AI Learns / AI Learns - posted scripts
- David Iya / David Iya - posted scripts
- PM lessons: Briefs & scripts / PM lessons: Deals & data
- PM lessons: WhatsApp / PM memory: rules and facts
- Templify
- The Crazy Entrepreneur
- AI tool campaign
- AI tool campaigns
- AI Video Collaboration
- David
- Dmytro
- [CLIENT] — Graphics (tweaks on top of the house catalogue)
- [CLIENT] — Style (tweaks on top of the house style)
- Chris Graphics Tweaks
- Chris Style Tweaks
- House graphics catalogue (all clients)
- House style (all clients)
- Lindsay — Motion graphics brief
- Lindsay — Graphics (tweaks on top of the house catalogue)
- Lindsay — Style (tweaks on top of the house style)
- Lindsay Graphics Tweaks
- Nicole reels: the playbook (what we learned)
- Nicole — Style (tweaks on top of the house style)
- Nicole Playbook
- Lindsay reels — playbook (rules learned from Harsh's feedback)
- tools/nicole-reels: the Nicole reel pipeline
- Lindsay Reels Playbook
- Valeri — Graphics (tweaks on top of the house catalogue)
- Valeri — Style (tweaks on top of the house style)
- PM lessons: Emails
- PM Lessons: Other
- PM Lessons: Payments
- PM lessons: Video & editors
- Brand requests at night are kept
- PM memory: rules and facts Harsh and Pratham taught the PM
- n8n automations (NOOCAP)

## God Nodes (most connected - your core abstractions)
1. `Chris` - 271 edges
2. `Lindsay` - 210 edges
3. `Valeri` - 21 edges
4. `Duncan` - 15 edges
5. `NOOCAP Systems — SOP Library` - 14 edges
6. `Brad` - 13 edges
7. `Harsh` - 9 edges
8. `Luma AI` - 8 edges
9. `CapCut` - 7 edges
10. `Chris - what performs` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Lindsay` --links to--> `Instantly.ai`  [EXTRACTED]
  creators/lindsay.md → brands/instantly.md
- `Lindsay` --links to--> `OneUp`  [EXTRACTED]
  creators/lindsay.md → brands/oneup.md
- `Lindsay - posted scripts` --links to--> `Lindsay`  [EXTRACTED]
  scripts/lindsay.md → creators/lindsay.md
- `Brad` --references--> `Brad - Brand Feedback`  [INFERRED]
  creators/brad.md → feedback/brad.md
- `Valeri` --references--> `Valeri - Brand Feedback`  [INFERRED]
  creators/valeri.md → feedback/valeri.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Brands Managed by Agencies** — brands_promocut, brands_riverflow, brands_runway, brands_sourceful [EXTRACTED 0.90]
- **Video Production Pipeline** — pages_01-video-assignment-editing-flow, pages_02-video-review-approval, pages_14-kpi-tracking-dashboard [EXTRACTED 0.90]
- **WhatsApp Communication Protocol** — lessons_whatsapp_one_card_per_draft, lessons_whatsapp_add_n_videos_rule, lessons_whatsapp_creator_context_rule, lessons_whatsapp_file_handling_rule, lessons_whatsapp_meta_templates_rule, lessons_whatsapp_one_message_per_thing [EXTRACTED 0.90]
- **Brand Deal Management** — pages_08-brand-deal-email-triage, pages_09-brand-deal-to-invoice [EXTRACTED 0.95]
- **LeadsRun (IntentRat) Promotion** — scripts_duncan, scripts_lindsay, leadsrun [EXTRACTED 0.95]
- **Creator Performance Tracking** — performance_brad, performance_chris, performance_duncan, performance_lindsay, performance_valeri [EXTRACTED 1.00]
- **Creator Script Repository** — scripts_brad, scripts_chris, scripts_duncan, scripts_lindsay [EXTRACTED 1.00]
- **ElevenLabs Creator Campaigns** — brands_elevenlabs, creators_valeri, creators_chris, creators_duncan [EXTRACTED 1.00]
- **Motion Graphics Production Flow** — editing_claude, editing_house_style, editing_house_graphics, editing_lindsay_style, editing_valeri_style [EXTRACTED 1.00]
- **Standard Motion Graphics Rules** — pages_lindsay-design-file-motion-graphics, pages_valeri-design-file-motion-graphics [EXTRACTED 1.00]
- **NOOCAP Creators** — creators_brad, creators_chris, creators_duncan, creators_lindsay, creators_valeri [EXTRACTED 1.00]
- **Project Management Rules & Lessons** — lessons_briefs-scripts, lessons_deals-data, lessons_emails, lessons_payments, lessons_video-editors [EXTRACTED 1.00]
- **AI Video Tools Cluster** — brands_topview, brands_vidagent, brands_vidmuse, brands_videogenerationtool [INFERRED 0.70]
- **Agency-Brand Representation** — brands_elevenlabs_kudos_narratives [INFERRED 0.80]
- **AI Tool Brand Collaborations** — brands_readdy, brands_runway, brands_softr, brands_speakon [INFERRED 0.80]
- **AI Video Generation Tools** — brands_luma, brands_pollo, brands_pixverse, brands_pippit [INFERRED 0.80]
- **Brand Feedback and Revision Flow** — feedback_brad_brad_feedback [INFERRED 0.80]
- **Creator Editing Style System** — editing_chris_style, editing_lindsay_graphics, editing_nicole_style, editing_valeri_graphics [INFERRED 0.80]
- **Valeri's Voice Agent Tech Stack** — scripts_valeri_xtool, scripts_valeri_timesfm, scripts_valeri_obscura, scripts_valeri_mesh_llm [INFERRED 0.80]
- **Content Monetization Funnel** — pages_05-lead-magnet-production, pages_06-manychat-dm-funnels, pages_13-newsletter-attribution [INFERRED 0.85]
- **AI 3D Creation Platforms** — brands_hyper3d, brands_hi3d, brands_hi3d30 [INFERRED 0.90]
- **Tencent Brand Group** — brands_tencent, brands_tencentcloud, brands_tencentdesignmiora [INFERRED 0.90]
- **Tripo Brand Ecosystem** — brands_tripo, brands_tripo3d, brands_tripoapi, brands_tripostudio [INFERRED 0.90]

## Communities (57 total, 46 thin omitted)

### Community 0 - "Chris brand deals"
Cohesion: 0.01
Nodes (205): AI 3D Creation Platform, Abacus AI, ACASIS, Accio Work, AIKONIC, AIQORA AI, AIsa, AistLabs (+197 more)

### Community 1 - "Lindsay brand deals"
Cohesion: 0.01
Nodes (189): Accomplishr, Agency Autopilot, AiBoosting, AICOO Office, AigoPilot, AINOTE, Alibaba.com, Anijam AI (+181 more)

### Community 2 - "Valeri brand deals"
Cohesion: 0.07
Nodes (32): Lua Group, The Breadwinners, AIFY Media, Fish Audio, Higgsfield, Holo, Kimi, Lovart (+24 more)

### Community 3 - "NOOCAP Systems — SOP Library / 01 — Video Assignment & Editing Flow"
Cohesion: 0.09
Nodes (26): Claude Code, Motion Studio GitHub Repo, Instantly Outreach, Metricool Scheduler, n8n Automation, Notion Brand Deals Pipeline, Notion Client Dashboard, Notion Edit Tracker (+18 more)

### Community 4 - "Duncan brand deals"
Cohesion: 0.09
Nodes (23): CapCut, GlobeInflu, GrowMaxValue, Mediacube, ChatGPT, Viral Nation, ElevenLabs, Kudos Narratives (+15 more)

### Community 5 - "Brad brand deals"
Cohesion: 0.13
Nodes (18): AdsMarch, Faved, NJ Agency, Buzzy AI, Luma AI, Migoo (in-person session), Migoo, PromoCut (+10 more)

### Community 6 - "Harsh / Only use WhatsApp templates Meta has approved"
Cohesion: 0.17
Nodes (13): Harsh, "Add N videos" means new cards, not script notes, Ask Harsh for things only we have, A message about another creator never answers this creator's question, WhatsApp deals get WhatsApp alerts, A file Harsh sends is never dropped, Only use WhatsApp templates Meta has approved, One WhatsApp card per draft (+5 more)

### Community 7 - "Nicole / Lindsay - what performs"
Cohesion: 0.25
Nodes (8): Aries, AI tool (agents/workflow platform), Nicole, Nicole — Graphics, Nicole Style Tweaks, Nicole Reel Pipeline, Lindsay - what performs, Nicole - what performs

### Community 8 - "Motion Studio House Rules / House Style"
Cohesion: 0.33
Nodes (6): Motion Studio House Rules, House Graphics Catalogue, House Style, Lindsay Style Tweaks, Valeri Style Tweaks, n8n Automations

### Community 9 - "Emtech / Instantly.ai"
Cohesion: 0.50
Nodes (4): Instantly.ai, Polsia, Emtech, Emtech - what performs

### Community 10 - "Claude / LINDSAY — DESIGN FILE (Motion Graphics)"
Cohesion: 1.00
Nodes (3): Claude, LINDSAY — DESIGN FILE (Motion Graphics), VALERI — DESIGN FILE (Motion Graphics)

## Knowledge Gaps
- **468 isolated node(s):** `David Iya`, `AI Learns`, `Dmytro`, `The Crazy Entrepreneur (TCE) / AI-powered e-commerce application`, `Zeely AI` (+463 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 468 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **46 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Chris` connect `Chris brand deals` to `Lindsay brand deals`, `Valeri brand deals`, `Duncan brand deals`, `Brad brand deals`, `Nicole / Lindsay - what performs`, `Emtech / Instantly.ai`, `Joylo / Closedune`, `Halliday / KOL Summit`, `OiiOii / Luminary SM`, `Pollo.AI / MarGrowth`, `Hyper3D / NoxInfluencer`, `Kylon / Widely`, `Emergent / Gautam Mahajan`, `GetRamped / Celina Otero`, `SpeakOn AI / NOTTA PTE. LTD.`?**
  _High betweenness centrality (0.566) - this node is a cross-community bridge._
- **What connects `David Iya`, `AI Learns`, `Dmytro` to the rest of the system?**
  _468 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Chris brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.00975609756097561 - nodes in this community are weakly interconnected._
- **Why does `Lindsay` connect `Lindsay brand deals` to `Valeri brand deals`, `Duncan brand deals`, `Brad brand deals`, `Nicole / Lindsay - what performs`, `Emtech / Instantly.ai`, `OiiOii / Luminary SM`, `Pollo.AI / MarGrowth`, `Hyper3D / NoxInfluencer`, `Kylon / Widely`, `OneUp / David - what performs`, `SpeakOn AI / NOTTA PTE. LTD.`?**
  _High betweenness centrality (0.431) - this node is a cross-community bridge._
- **Should `Lindsay brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.010582010582010581 - nodes in this community are weakly interconnected._
- **Why does `Valeri` connect `Valeri brand deals` to `NOOCAP Systems — SOP Library / 01 — Video Assignment & Editing Flow`, `Duncan brand deals`, `Brad brand deals`?**
  _High betweenness centrality (0.114) - this node is a cross-community bridge._
- **Should `Valeri brand deals` be split into smaller, more focused modules?**
  _Cohesion score 0.06854838709677419 - nodes in this community are weakly interconnected._