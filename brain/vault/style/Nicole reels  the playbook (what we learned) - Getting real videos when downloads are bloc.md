---
type: style
---
prompt-motion.com preview files are 722x406 and 4 s long. When direct download is blocked, open the `.mp4` URL in Chrome and paste the `__grab` helper (`tools/nicole-reels/grab.js`) into the page. It draws 6 frames at a time onto a canvas grid (480x270 cells, with a 150 px gap so the mouse cursor lands in the gap). Zoom-screenshot the region [0,0,1440,690] at scale 1 for t = 0, 6, 12 … 36 (10 fps), then `python3 stitch.py <screenshot-dir> <name>` rebuilds a 30 fps mp4 in `build/assets/rec/`. Show these clips inside a player frame or tile, not full screen, because they're small.

## Links
- [[Nicole reels  the playbook (what we learned)]]
