# Nicole reels: the playbook (what we learned)

Everything here comes from real feedback on Nicole's reels (Paper Cutout, Hiring Panel, Haiku Router, Claude Motion, Animations). Read it before every Nicole job. If a rule here and a newer correction from Harsh disagree, the newer correction wins, so add it here.

## The brief Harsh gives every time
"Create an eye-catching hook people will definitely get hooked on. Show proper visuals for what she's saying, simple enough that even a small kid understands, but eye-catching. Smooth visuals with good transitions. Use GitHub assets, screenshots or real video. Remove micro-pauses. Don't make the same mistakes as last time." Sometimes he adds a source of real videos (for example prompt-motion.com).

## Workflow (do not skip steps)
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

## Layout rules (hard rules, each one came from a correction)
- **The hook is a TOP clip** (graphic in the top half, Nicole in the bottom half) **with Nicole on screen from frame 0**. Never a full face and never a full-screen Nicole.
- **Never two TOP clips in a row.** Alternate TOP and FULL.
- **Keep Nicole's screen time low**, about 11–13 s of a 40–55 s reel. She's usually in the hook plus one TOP clip in the middle. ("We are showing Nicole on screen too much.")
- **Avatar card:** a near full-width rounded card under the graphic (x18 y978 w1044 h924, radius 28) with a 6 px black border, cropped tight on head and shoulders (`CROP` in avatar_final.py).
- **Visuals must be BIG and centred.** Nothing under 36 px on screen except creator credits, and headlines are 76–96 px. Check alignment strictly on every contact sheet. ("The visuals are too small… strictly check and fix the alignment.")
- **Fill the frame.** No big empty bottom halves. If a scene leaves 600 px empty, scale it up or add the next beat there. (The step-1 GitHub frame was rejected for tiny screenshot strips and an empty bottom.)
- **No empty first frames.** Every clip opens with content already on screen (`hook0`/`enter0`), never a blank peach screen.
- **Realistic content, no grey placeholder lines.** Write real-looking resumes, invoices, chat boxes, terminals, code and files. ("Make the visuals more realistic rather than showing lines.")
- **Real assets over mockups.** Use GitHub pages, real repo stats, real UIs and real creator videos. Logos are never redrawn.
- **Anything she names appears on screen**, and numbers count up.
- **One clear idea per scene**, kid-simple metaphors: a battery for limits, a sorting machine for routing, a 1-2-3-4 ladder for steps, a "#1" medal, an invoice with a red ✕.
- **Mascot:** use Harsh's supplied Claude mascot image (`assets/imgs/mascot.png`), never a copyrighted character. Our own drawn mascot is OK.
- **Real people:** only use a real person's photo when Harsh supplies it and asks. Keep captions generic ("Anthropic right now (probably)") and never put words in a real person's mouth.
- **Credit creators.** Any third-party video (prompt-motion.com and similar) shows "made with Claude · @handle" or a handle label. The site says the videos belong to their creators.
- **Transitions:** soft zoom-through in (`xin`) and a quick blur out (`xout`) on every clip, with swaps between headlines (`swap`). Pops and back-out eases, no hard cuts mid-sentence.

## Timing rules
- A clip's start is the first word of its sentence (raw time from voice.json). Clips end where the next one starts.
- Cue animations to word start times (`// word .52 · word 1.10` comments at the top of each clip's JS).
- **Micro-pauses:** `tighten.py` cuts every silence ≥0.15 s at −38 dB down to 0.10 s, with video and audio cut together so lip sync holds.
- **Speed:** finals at 1.2x (`setpts=PTS/1.2, atempo=1.2`) plus a normal-speed copy.
- **Sound:** `sfx.py` computes the same cut map as tighten, so effects land on the tight timeline. Write events per clip in `job.py → SFX()` and match every visible action (pop on a card, stamp on a ✕, ticks on typing, whoosh on transitions, ding on a tick). There's a 120 bpm pluck music bed, sidechain-ducked under the voice.
- **ACE-Step** (AI music) needs a GPU and Hugging Face access, which this setup doesn't have. Keep the procedural SFX and music unless Harsh provides tracks.

## Writing style for any on-screen text, captions or messages to Harsh
- No lists of three for rhythm.
- No "it's not X, it's Y".
- No staccato fragments.
- Short, plain, kid-simple.

## Getting real videos when downloads are blocked
prompt-motion.com preview files are 722x406 and 4 s long. When direct download is blocked, open the `.mp4` URL in Chrome and paste the `__grab` helper (`tools/nicole-reels/grab.js`) into the page. It draws 6 frames at a time onto a canvas grid (480x270 cells, with a 150 px gap so the mouse cursor lands in the gap). Zoom-screenshot the region [0,0,1440,690] at scale 1 for t = 0, 6, 12 … 36 (10 fps), then `python3 stitch.py <screenshot-dir> <name>` rebuilds a 30 fps mp4 in `build/assets/rec/`. Show these clips inside a player frame or tile, not full screen, because they're small.

## Files in a job folder
`source/` (voice.mp3, voice.json, avatar.mp4) · `plan.md` · `build/` (job.py, clips_job.py, scripts, assets) · `out/` (clip mp4s, `final/`, `audio/`) · `qa/` (contact sheets).
