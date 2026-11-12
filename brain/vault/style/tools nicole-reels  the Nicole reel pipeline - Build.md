---
type: style
---
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

## Links
- [[tools nicole-reels  the Nicole reel pipeline]]
