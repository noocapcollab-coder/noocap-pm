---
type: style
---
1. **Get the audio.** It lands in `videos/nicole/inbox/` or a Drive folder Harsh links. Make `videos/nicole/<YYYY-MM-DD-topic>/`, copy it to `source/voice.mp3`, and transcribe with word timestamps into `source/voice.json` (`python3 ~/txs.py source/voice.mp3 source/voice.json` with faster-whisper small, or mlx_whisper on the Mac).
2. **Research first.** Look up every product, repo, price or claim she names. Note anything that's off (beta only, plan limits, "up to" pricing, the transcript mishearing a CTA word) in a "Fact check" or "Things to confirm" section.
3. **Write `plan.md` as a table** (`# | Time | Type | Line | Graphic`) and wait for **"approved"**. Below the table, cover:
   - how many versions you're making
   - Nicole's screen time
   - "carried over from last time"
   - the fact check
   - copies in `toolkit/examples/plan-*.md`
4. **Gather real assets.**
   - GitHub repo pages: take zoomed screenshots and crop the logo, tagline and stats so they read big. Never use a full-page strip.
   - Real app UIs.
   - Real videos, captured with the frame-grab method below.
5. **Build the clips** (`build/clips_job.py`), render, and QA every clip on a contact sheet (`python3 sheet.py '<glob>' t1,t2,...`). Fix, then re-render.
6. **Assemble the preview.** It has placeholder panels where Nicole goes. Tighten it, make a 1.2x copy, and send both.
7. **Send the avatar audio** (`Nicole-<slug>-AVATAR-ALL.mp3`): only the parts where she's on screen, joined back to back. Harsh trains or generates the avatar from it.
8. **When the avatar arrives:**
   - Run `avatar_check.py` to see whether it was made from AVATAR-ALL or the full voice, and set `AVATAR_SRC`/`AVATAR_BODY`.
   - Run `avatar_final.py` and `tighten.py`, then `sfx.py` for sound effects and music plus 1.2x.
   - **Never use the avatar video's own audio.** The voice always comes from `source/voice.mp3`.
9. **Deliver all four** (TIGHT, TIGHT-1.2x, TIGHT-SFX, TIGHT-SFX-1.2x) into `out/final/` and send the SFX ones. If he asks for "normal speed", send the non-1.2x version.

## Links
- [[Nicole reels  the playbook (what we learned)]]
