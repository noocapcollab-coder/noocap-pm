# NOOCAP second brain (built 13 Nov 2026)

The agency's knowledge in one place, rebuilt every Sunday. **No money is stored in it** (amounts are replaced with [amount]); live stages, rates and payments stay in the PM's tools and the revenue dashboard.

## Where it lives
- Team page (search + map): https://claude.ai/artifact/LxWHkkkrQtdCYAnEJ1kHFn
- Source files and graph: noocap-pm repo, `brain/` (`sources/` markdown, `graphify-out/graph.json`, `GRAPH_REPORT.md`)
- PM on WhatsApp / HQ chat: the `search_brain` tool answers "how do we…", brand history, creator styles, SOPs, rules and lessons

## What is in it
- brands/: one page per brand (430+): brand wiki compiled from every email (who, contacts, how they work, watch outs, open items), each deal's running memory, inbound leads
- creators/: each creator and the brands they worked with
- editing/: house style, graphics, and Chris, Lindsay, Nicole, Valeri style files and playbooks (motion-studio)
- rules/ and lessons/: PM memory (what Harsh and Pratham taught it) and the PM's lessons from mistakes
- pages/: Lindsay and Valeri design files; the SOP Library joins once it is shared with the PM's Notion integration
- systems/: the n8n automations

## How it is rebuilt
1. `GET https://noocap-pm.vercel.app/api/brain?export=1` with header `x-brain-key` (BRAIN_KEY in Vercel) returns every source file.
2. Files go into `brain/sources/`, motion-studio style files are copied in, then `python3 brain/build_graph.py` (Graphify, Gemini free tier, only changed files).
3. Commit to noocap-pm, which redeploys the PM with the fresh brain; republish the team page.

## Hyperedges (group relationships)
- **Agency Managed Collaborations** — house_of_marketers, faved, brands_kylon_widely, jeevmedia, partnerly [EXTRACTED 0.90]
- **WhatsApp Communication Protocol** — lessons_whatsapp_one_card_per_draft, lessons_whatsapp_add_n_videos_rule, lessons_whatsapp_creator_context_rule, lessons_whatsapp_file_handling_rule, lessons_whatsapp_meta_templates_rule, lessons_whatsapp_one_message_per_thing [EXTRACTED 0.90]
- **Creator-Brand Partnerships** — creators_chris, creators_lindsay, creators_duncan, brands_zeely, brands_zenbusiness, brands_yesoulfitness [EXTRACTED 1.00]
- **ElevenLabs Creator Campaigns** — brands_elevenlabs, creators_valeri, creators_chris, creators_duncan [EXTRACTED 1.00]
- **Luma AI Creator Campaigns** — brands_luma, creators_chris, creators_duncan, creators_brad, creators_lindsay [EXTRACTED 1.00]
- **Motion Graphics Production Flow** — editing_claude, editing_house_style, editing_house_graphics, editing_lindsay_style, editing_valeri_style [EXTRACTED 1.00]
- **Standard Motion Graphics Rules** — pages_lindsay-design-file-motion-graphics, pages_valeri-design-file-motion-graphics [EXTRACTED 1.00]
- **Project Management Rules & Lessons** — lessons_briefs-scripts, lessons_deals-data, lessons_emails, lessons_payments, lessons_video-editors [EXTRACTED 1.00]
- **Agency-Brand Representation** — brands_elevenlabs_kudos_narratives, brands_hyper3d_noxinfluencer, brands_kylon_widely, brands_luma_nj_agency [INFERRED 0.80]
- **Creator Editing Style System** — editing_chris_style, editing_lindsay_graphics, editing_nicole_style, editing_valeri_graphics [INFERRED 0.80]
- **Tripo Brand Entities** — brands_tripo, brands_tripo3d, brands_tripoapi, brands_tripostudio [INFERRED 0.85]
- **Flova Brand Variations** — brands_flova [INFERRED 0.90]
- **Fotor Brand Variations** — brands_fotor, brands_fotoragent [INFERRED 0.90]

## Communities (53 total, 43 thin omitted)

### Community 0 - "Chris brand deals"
Cohesion: 0.01
Nodes (207): AI 3D Creation Platform, Abacus AI, ACASIS, Accio Work, AIKONIC, AIQORA AI, AIsa, AistLabs (+199 more)

### Community 1 - "Lindsay brand deals"
Cohesion: 0.01
Nodes (191): Accomplishr, Agency Autopilot, AiBoosting, AICOO Office, AigoPilot, AINOTE, Alibaba.com, Anijam AI (+183 more)

### Community 2 - "Duncan brand deals"
Cohesion: 0.12
Nodes (16): GlobeInflu, GrowMaxValue, Mediacube, Viral Nation Inc., CapCut, ChatGPT, Fish Audio, Flova AI (+8 more)

### Community 3 - "Valeri brand deals"
