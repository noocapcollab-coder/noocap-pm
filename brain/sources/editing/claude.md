# Motion Studio — house rules

This folder produces motion graphics (B-roll) for NOOCAP clients' short-form videos, built as code with HyperFrames and rendered locally.

## Layout
- house/STYLE.md and house/GRAPHICS.md — the shared system (delivery format, pacing, motion moves, graphics catalogue). Read these first for every client.
- clients/<client>/STYLE.md and GRAPHICS.md — only that client's differences (colours, fonts, favourites). Read them second; they win where they disagree with house.
- clients/<client>/library/ — reusable HyperFrames templates for that client.
- clients/<client>/BRIEF.md and references/ (frames/, videos/, NOTES.md) — the raw input STYLE.md and GRAPHICS.md are built from.
- clients/_template/ — copy this for every new client.
- shared/ui/<app>/ — real app screenshots and screen recordings (GitHub, Claude, ChatGPT, YouTube…), shared by all clients. Use these whenever a script names a tool; never mock up a fake UI.
- videos/<client>/inbox/ — where the team drops new audio/video + script on this computer.
- videos/<client>/<YYYY-MM-DD-topic>/ — one folder per video: source (audio or talking-head video), script.md, words.json, plan.md, out/, qa/. These folders are local to each computer and git ignores them; only four reference builds (nicole 2026-10-02-five-repos, valeri 2026-10-02-thinking-orbs and 2026-10-12-five-github-repos, lindsay 2026-10-08-ai-humanizer) are tracked, because the client style files cite them.

## Sharing this folder (git)
This folder is a clone of the private GitHub repo noocapcollab-coder/motion-studio, shared by every editor. Everything except raw footage, audio and renders is in it.
- At the start of every session run `git pull --rebase`. If it stops because of local changes, tell the editor what it found and do not discard anything.
- When you save a correction or a new rule into a style, playbook, house, tools or CLAUDE.md file, finish by committing and pushing just those files: `git add <the files>`, `git commit -m "<client or area>: <what changed>"`, `git push`. If the push is rejected, run `git pull --rebase` and push again. Never force-push, and never add anything under `videos/` or any video, audio or image-sequence file.
- Footage, finished videos and the clients' reference videos live in Drive and Notion, not in git. Download what a video needs into `videos/<client>/<job>/` on this computer.

## Client design files (Notion = source of truth)
The team edits each client's design file in Notion. At the start of every video, fetch the client's Notion design file with the Notion MCP. If it differs from clients/<client>/STYLE.md or GRAPHICS.md, update the local files to match (Notion wins) and mention what changed. When the user corrects something for a client, write it into the Notion page too and add a Change log row.
- Lindsay: https://app.notion.com/p/3ed508e99dda81b3b633e5297e0f3a33 (under Client Portals / LINDSAY GONZALES)
- Valeri: https://app.notion.com/p/3ed508e99dda8159b454fc50ca1f9cfe (under Client Portals / VALERI - DASHBOARD)
- Nicole: no Notion page yet — clients/nicole/STYLE.md (v1.0) and clients/nicole/PLAYBOOK.md are the source of truth until one is written.

## Rules
- **Confirm the computer first.** At the start of every video, say which computer this chat is linked to and which motion-studio folder is connected, and ask the editor to confirm before editing. If it's not the one they want, they open the chat in the Claude desktop app on the right computer and choose "Link to this computer".
- Never change a locked script. Flag issues, don't edit.
- Always show plan.md as a table and wait for "approved" before building.
- Format is 9:16 vertical unless told otherwise.
- Every frame must read in about one second on a phone. Respect the safe zone in house/STYLE.md (map: house/safe-zone-9x16.png): important graphics in the white area, red zone only if needed. Run the safe-zone check before delivering.
- Anything named out loud (a tool, a site, a number) appears on screen. Use real logos, never redraw them.
- Numbers count up, never just appear.
- Anything spoken in under half a second is a step on the current graphic, not a new one.
- The hook has no cuts until the first sentence ends.
- QA every render with a fresh subagent before handing it over.
- Mode A: render one clip per moment into out/, numbered in order, with 0.5s hold at the end, plus out/EDIT-NOTES.md.
- Mode B: render one full-length track timed to words.json.
- When a script needs a graphic the library lacks, build a new template, save it to the client's library and add it to GRAPHICS.md.
- When the user corrects something, ask whether it's for this client only (client file) or for everyone (house file), then add it there so it sticks.

## Pipeline (how a video is built — works on any PC)
- Start a job by copying the `build/` of the most recent video for that client (e.g. `videos/nicole/2026-10-02-five-repos/build/`, `videos/valeri/2026-10-02-thinking-orbs/build/`). Only four reference builds ship with the repo, so when a client's latest job folder is not on this computer, start from that client's kit in `tools/` instead (`nicole-reels/build`, `lindsay-reels/template/build`, `valeri-template/build`). A build holds: `gen_head.py` + `gen_clips.py` + `gen_tail.py` (concatenate to `gen.py`, run it to write `clips/*.html`), `lib/` (gsap, house.js moves, client CSS), `assemble.py`, `cut_*.py`, `safezone-check.html`, `sheet.html`.
- Inputs: Notion page (script, Raw Footage / Assets / Edited Video Drive links) → download voice/raw from Drive → transcribe with word timestamps into `source/voice.json`.
- Render each clip: `npx --yes hyperframes@0.8.92 render . -c clips/<clip>.html -o ../out/<clip>.mp4 -w 2 --quiet` (run inside `build/`).
- Safe-zone check: serve `build/` (`python3 -m http.server 8765`), open `http://localhost:8765/safezone-check.html?clips=a.html,b.html` in the browser, read `window.__report`. Fix everything it flags.
- Assemble: `python3 assemble.py preview|final|overlay|audio <version>` → `out/final`, `out/overlay` (transparent cutout), `out/audio` (VOICE, CLONE with silences removed, ON-SCREEN cues). Write `out/EDIT-NOTES.md`.
- Real assets: capture live pages with headless Chrome (`--screenshot`, light/dark via `--blink-settings=preferredColorScheme=1/0`); GitHub file/blob pages may return an error page headless — use the repo page or another real source.
- Drive limits: the Drive connector downloads/uploads only ≤10 MB per file; bigger files the user downloads/drags manually.
- AI-generated images (Higgsfield) only for illustrative props, never for logos or UIs.

## Platform notes
- Mac (Apple Silicon): transcription `mlx_whisper <audio> --model mlx-community/whisper-large-v3-turbo --word-timestamps True --output-format json`; overlays HEVC with alpha via `hevc_videotoolbox`; alpha verified with `avconvert`.
- Windows: use `faster-whisper` (or `whisper`) for word timestamps; overlays as ProRes 4444 (`-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le`, .mov); skip the avconvert check and verify alpha with `ffmpeg -vf alphaextract`.
- zsh (Mac): quote `"0:a:0?"`; `set -- $var` does not split words; screenshot file names contain a special space, so use globs.

## Nicole reels (talking-head + motion graphics)
- For every Nicole video, read `clients/nicole/PLAYBOOK.md` first (rules learned from Harsh's feedback: TOP hook with Nicole from frame 0, never two TOP clips in a row, Nicole on screen ~11–13 s max, big centred visuals, real assets, no empty first frames, credit creators).
- Build with `tools/nicole-reels/` (README.md = commands): copy its `build/` into the new video folder, fill `build/job.py` + `build/clips_job.py`, then gen → render → contact-sheet QA → preview + AVATAR-ALL.mp3 → avatar → tighten → sfx → finals (normal + 1.2x, with and without SFX).
- Never use the avatar video's own audio; the voice always comes from source/voice.mp3.
- Finished example jobs (clip generators and plans) are in `tools/nicole-reels/examples/`.

## Lindsay reels (hooks + full-screen body + CTA)
- For every Lindsay short, read `tools/lindsay-reels/PLAYBOOK.md` first, then `tools/lindsay-reels/README.md` for commands. Start from `tools/lindsay-reels/template/build`; copy patterns from `tools/lindsay-reels/example-aidropshipping`.
- The finished example is `tools/lindsay-reels/example-aidropshipping/` (plan and full build).

## Hook Multiplier (hook A/B versions for Instagram trial reels)
- Tool and editor guide: `tools/hook-multiplier/README.md`. One command on every computer: `npm run hooks -- --video <final.mp4> --creator <name> --count 20` (`npm run hooks:doctor` checks the computer).
- Flow: the first run probes the video, finds the hook end and writes `videos/<creator>/hooks/.work_<creator>_<video>/hooks.json`, then stops. Fill in `angle` and `text` (max 8 words, one `*emphasis*` word, at least 10 different angles across 20) for every variant, re-run to get the table and copy checks, show the table and wait for "approved", then re-run with `--approved`.
- Hooks must stay true to what the video delivers, never promise numbers or results the body doesn't back up, and never overstate a sponsor's product. Words the spell checker doesn't know (tool names) go in `allow_words` in hooks.json.
- Footage tier (a different opening B-roll per hook): save the clips into one folder (for Lindsay, animated websites from Pinterest; the mp4 for a pin is under v1.pinimg.com, see tools/lindsay-reels/PLAYBOOK.md) and add `--tier footage --broll <folder>`. Check `broll-picks.jpg` and `preview-sheet.jpg`; prefer windows that open on the site's hero, and use `crop` in hooks.json to drop mockup borders. Show both sheets with the table before rendering.
- Use the version of the cut that gets posted (with captions). Send the contact sheet and 2–3 sample files after QA; `qa-report.md` must show no problems before hand-over.
