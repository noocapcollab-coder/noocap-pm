---
type: style
---
- Start a job by copying the `build/` of the most recent video for that client (e.g. `videos/nicole/2026-10-02-five-repos/build/`, `videos/valeri/2026-10-02-thinking-orbs/build/`). Only four reference builds ship with the repo, so when a client's latest job folder is not on this computer, start from that client's kit in `tools/` instead (`nicole-reels/build`, `lindsay-reels/template/build`, `valeri-template/build`). A build holds: `gen_head.py` + `gen_clips.py` + `gen_tail.py` (concatenate to `gen.py`, run it to write `clips/*.html`), `lib/` (gsap, house.js moves, client CSS), `assemble.py`, `cut_*.py`, `safezone-check.html`, `sheet.html`.
- Inputs: Notion page (script, Raw Footage / Assets / Edited Video Drive links) → download voice/raw from Drive → transcribe with word timestamps into `source/voice.json`.
- Render each clip: `npx --yes hyperframes@0.8.92 render . -c clips/<clip>.html -o ../out/<clip>.mp4 -w 2 --quiet` (run inside `build/`).
- Safe-zone check: serve `build/` (`python3 -m http.server 8765`), open `http://localhost:8765/safezone-check.html?clips=a.html,b.html` in the browser, read `window.__report`. Fix everything it flags.
- Assemble: `python3 assemble.py preview|final|overlay|audio <version>` → `out/final`, `out/overlay` (transparent cutout), `out/audio` (VOICE, CLONE with silences removed, ON-SCREEN cues). Write `out/EDIT-NOTES.md`.
- Real assets: capture live pages with headless Chrome (`--screenshot`, light/dark via `--blink-settings=preferredColorScheme=1/0`); GitHub file/blob pages may return an error page headless — use the repo page or another real source.
- Drive limits: the Drive connector downloads/uploads only ≤10 MB per file; bigger files the user downloads/drags manually.
- AI-generated images (Higgsfield) only for illustrative props, never for logos or UIs.

## Links
- [[Motion Studio — house rules]]
