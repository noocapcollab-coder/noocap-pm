# NOOCAP second brain

What the agency knows, as markdown (`sources/`) and a knowledge graph built by Graphify (`graphify-out/`).
No money anywhere in here: amounts are removed at export, and money lives in the PM's live tools.

- `sources/brands/` one file per brand: the brand wiki (from every email), each deal's running memory, inbound leads
- `sources/creators/` one file per creator and the brands they worked with
- `sources/editing/` house and per-client editing style, graphics and playbooks (from motion-studio)
- `sources/rules/`, `sources/lessons/` what Harsh and Pratham taught the PM, and the PM's lessons from mistakes
- `sources/pages/` Notion pages: SOP Library (when shared with the PM integration) and client design files
- `sources/systems/` the n8n automations
- `graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html` the graph

Rebuilt every week by a scheduled Claude session: export (`/api/brain?export=1`), Graphify update, commit.
The PM searches it with the `search_brain` tool (lib/brainsearch.js) in WhatsApp and the HQ chat.
