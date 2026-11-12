---
type: style
---
```bash
cp <avatar>.mp4 source/avatar.mp4
python3 build/avatar_check.py        # tells you which audio it was made from; set AVATAR_SRC/AVATAR_BODY in job.py
python3 build/avatar_final.py main   # voice comes from the preview, NEVER from the avatar file
python3 build/tighten.py main        # micro-pauses out
python3 build/sfx.py                 # -> -TIGHT-SFX.mp4 and -TIGHT-SFX-1.2x.mp4 (events in job.py SFX())
```
Also make `-TIGHT-1.2x.mp4` with the ffmpeg line above. Deliver all four.

## Links
- [[tools nicole-reels  the Nicole reel pipeline]]
