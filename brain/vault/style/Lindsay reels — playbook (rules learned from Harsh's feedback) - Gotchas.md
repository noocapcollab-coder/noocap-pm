---
type: style
---
- Always re-run `assemble.py` before `captions_wd.py` and `mix.py`, otherwise the music doubles.
- Root-level videos (`rw(...)`) must run to the clip end (slot + 0.5 s) with tpad-padded sources, or you get a black flash.
- Body clips use `exit=False` so there's no empty gap between clips.
- Pinterest videos: the mp4 lives at `https://v1.pinimg.com/videos/mc/720p/<hash path>.mp4` (hash from the pin's poster `i.pinimg.com/videos/thumbnails/originals/<hash>.0000000.jpg`). Chrome can block repeated downloads; allow "automatic downloads" for pinterest.com / pinimg.com, or add v1.pinimg.com to allowed domains.

## Links
- [[Lindsay reels — playbook (rules learned from Harsh's feedback)]]
