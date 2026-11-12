# Lindsay reels — playbook (rules learned from Harsh's feedback)

Read this before every Lindsay short. It sits on top of `CLAUDE.md`, `house/STYLE.md` and `clients/lindsay/STYLE.md`.

## The standing brief (what Harsh sends with every new audio)
"Create a good eye-catching hook, show the proper visuals as per what I'm saying in a simple manner that even a small kid could understand, smooth, good transition effects, use screenshots and GitHub assets or videos, remove micropauses, download and use assets from the GitHub website and demos, and in the hook I need a good website downloaded from Pinterest."

## Workflow
0. **Confirm the computer first.** Before any editing, check which computer this chat is linked to (its name and the connected motion-studio folder) and ask: "I'll edit on <computer name> using <folder>. Use this computer?" Wait for a yes. If no computer is linked, or the editor wants a different one, tell them to open this chat in the Claude desktop app on that computer, choose "Link to this computer" and connect its motion-studio folder (Add folder). Then check the tools are installed there (node, ffmpeg, python, npx hyperframes); if not, run NEW-PC-SETUP.md section 3 first.
1. Fetch the locked script from Notion (Lindsay script pages). Never change a word of it; if it has a problem (e.g. "four ideas" but five are listed), flag it and follow the voice.
2. Voice comes from `videos/lindsay/inbox/<name>.mp3`. Remove micropauses with `scripts/tight.py` (cuts every silence over 0.12 s at -35 dB, keeps 30 ms each side) → `voice_tight.mp3`, `words_tight.json`, `cuts.json`.
3. Word timestamps: pocketsphinx forced alignment against the script (`scripts/align_template.py`, add any odd words to the `extra` pronunciation dict, it prints OOV words) or `mlx_whisper` on Mac.
4. Write `plan.md` as a table (Seg | Type | Tight time | Voice | Visual) and wait for "approved".
5. Build (see README.md), render, contact-sheet QA every clip yourself, fix, then a fresh-subagent QA on the assembled previews, then deliver.
6. Deliver the PREVIEW (with captions) plus the face-only mp3 for the avatar. When the avatar video comes back, build FINALS.

## Structure of every Lindsay short
- Two alternative hooks (H1, H2), each a TOP clip (graphic in the top half, Lindsay in the bottom half), then FULL body clips 01..N (no face), then a TOP CTA clip with Lindsay.
- Lindsay's face appears only in the hooks and the CTA. Never use the avatar video's own audio.
- Face-only mp3 for the avatar = hook1 | 0.3 s | hook2 | 0.3 s | CTA. `assemble.py audio` writes it plus `AVATAR-map.md`; check the map matches `FACE_MAP`.
- Avatars lead the voice by ~2 frames: check by envelope cross-correlation, then `tpad=start_duration=0.08:start_mode=clone` (+ stop pad).

## Visual rules
- Real assets only: real logos, real UIs, GitHub repo cards with the real star count counting up, README demo GIF frames, real screenshots (Meta Ad Library, Google Maps reviews, Gumroad, Cal.com…). Nothing fake, nothing AI-redrawn.
- The hook uses a real animated website video from Pinterest, and it MUST match what is being said (a museum site under "businesses are paying for AI" was rejected). Pick a site from the same world as the words (e.g. a local clinic / home-services site with "Book now" for "businesses pay for AI").
- Each spoken beat gets its own visual, timed to the word: name it → show it.
- The website in the hook stays BIG (full width of the top half). Never shrink it into a small card. Keep the frame clean, one idea on screen at a time, no clutter.
- Numbers always count up. Money tags, stamps (PAID ✓), check chips, red X on things being dismissed.
- Safe zone: FULL x 55–1025, y 211–1464. TOP y 211–938. Captions sit around y 1390 on FULL clips, so nothing important goes under them.
- Never show Harsh's name or email anywhere (screenshots of logged-in pages included).
- Captions: 1–3 words per group, white with shadow; merges in `captions/captions.py` MERGE (e.g. "AI-run", "$10,000"). The script constant in `captions/scripts.py` must match the voice exactly, with hyphens where MERGE joins words.
- Fonts: avoid the italic serif for keywords people must type (the T in "HUSTLE" rendered with a ball and read as "HUSTILE"); use the upright weight.
- Cream paper background (`paper2`), cards with soft brown shadows, gold accent `#e0a526`, orange tag `#d9663f`, green `#2f9e55`.

## Sound
- Music: an ACE-Step instrumental (`source/music/ace-take1.aac`), ducked under the voice.
- SFX synced to every motion beat (`sfx.py` EV table per clip: pop, whoosh, ding, tick, coin, stamp, chime, sparkle, click, spop, wdown, thud).
- Loudness -14 LUFS, peak ≤ -1.5 dBTP.

## Gotchas
- Always re-run `assemble.py` before `captions_wd.py` and `mix.py`, otherwise the music doubles.
- Root-level videos (`rw(...)`) must run to the clip end (slot + 0.5 s) with tpad-padded sources, or you get a black flash.
- Body clips use `exit=False` so there's no empty gap between clips.
- Pinterest videos: the mp4 lives at `https://v1.pinimg.com/videos/mc/720p/<hash path>.mp4` (hash from the pin's poster `i.pinimg.com/videos/thumbnails/originals/<hash>.0000000.jpg`). Chrome can block repeated downloads; allow "automatic downloads" for pinterest.com / pinimg.com, or add v1.pinimg.com to allowed domains.
