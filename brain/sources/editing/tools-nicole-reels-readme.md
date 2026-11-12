# tools/nicole-reels: the Nicole reel pipeline

Read **PLAYBOOK.md** first (the rules and lessons). This README is the commands.

## Start a new video
```bash
cd videos/nicole && mkdir -p 2026-MM-DD-topic && cd 2026-MM-DD-topic
cp -r ../../../tools/nicole-reels/build . && mkdir -p source out/final out/audio qa
cp ../inbox/<audio>.mp3 source/voice.mp3
python3 ../../../tools/nicole-reels/txs.py source/voice.mp3 source/voice.json   # or mlx_whisper on Mac
```
Print the words with times, write plan.md (copy a table from `examples/plan-*.md`), and wait for "approved".

## Build
1. Edit `build/job.py`:
   - `SLUG`
   - `START` (clip start = first word of its sentence)
   - `BODY`, `BODY_SEG`, `VERSIONS`
   - `AVATAR_IV`, which is every TOP clip's raw interval
2. Write `build/clips_job.py`. The shipped file is the full Animations job, so keep its helpers block (`AN_CSS`, `stepbar`, `ladder`, `bframe`, `comp`) and replace the `clip(...)` calls. `examples/` has three more complete jobs to borrow scenes from.
   - `clip(num, slug, "top"|"full", dur, "peach", False, css, body_html, js, media=vid2(...))`
   - TOP is 1080x960 (Nicole goes under it) and FULL is 1080x1920.
   - Helpers include `SETTLE` (settle/pop/enter0/out/hook0/swap/xin/xout), `screen`, `cbar`, `typeon`, `retype`, `vid2` and `CLAUDE_MARK`.
3. Run `bash build/gen.sh`, then `bash build/render_all.sh`.
4. QA every clip with `python3 ../../../tools/nicole-reels/sheet.py '03-*' 0.3,2.0,4.5,6.8` and look at `qa/sheet-*.png`. Fix and re-render.

## Preview → avatar audio
```bash
python3 build/assemble.py preview && python3 build/assemble.py audio && python3 build/avatar_audio.py
python3 build/tighten.py --preview main
ffmpeg -i out/final/Nicole-<SLUG>-main-PREVIEW-TIGHT.mp4 -filter_complex "[0:v]setpts=PTS/1.2,fps=30[v];[0:a]atempo=1.2[a]" -map "[v]" -map "[a]" out/final/Nicole-<SLUG>-main-PREVIEW-TIGHT-1.2x.mp4
```
Send the preview and `out/audio/Nicole-<SLUG>-AVATAR-ALL.mp3`.

## Avatar → finals
```bash
cp <avatar>.mp4 source/avatar.mp4
python3 build/avatar_check.py        # tells you which audio it was made from; set AVATAR_SRC/AVATAR_BODY in job.py
python3 build/avatar_final.py main   # voice comes from the preview, NEVER from the avatar file
python3 build/tighten.py main        # micro-pauses out
python3 build/sfx.py                 # -> -TIGHT-SFX.mp4 and -TIGHT-SFX-1.2x.mp4 (events in job.py SFX())
```
Also make `-TIGHT-1.2x.mp4` with the ffmpeg line above. Deliver all four.

## Render environment
HyperFrames 0.8.92 (`npx --yes hyperframes@0.8.92 render . -c clips/X.html -o ../out/X.mp4 --quiet`). On a Linux box, point `PRODUCER_HEADLESS_SHELL_PATH` / `HYPERFRAMES_BROWSER_PATH` at Chromium (render_all.sh has defaults). On the Mac, the installed Chrome works.

## Assets
`assets-library/` holds real prompt-motion clips (credit table in CREDITS.md) and GitHub crops. Copy what you need into `build/assets/rec` or `build/assets/shots`. `grab.js` + `stitch.py` capture more clips when downloads are blocked (see PLAYBOOK).
