---
type: style
---
- Two alternative hooks (H1, H2), each a TOP clip (graphic in the top half, Lindsay in the bottom half), then FULL body clips 01..N (no face), then a TOP CTA clip with Lindsay.
- Lindsay's face appears only in the hooks and the CTA. Never use the avatar video's own audio.
- Face-only mp3 for the avatar = hook1 | 0.3 s | hook2 | 0.3 s | CTA. `assemble.py audio` writes it plus `AVATAR-map.md`; check the map matches `FACE_MAP`.
- Avatars lead the voice by ~2 frames: check by envelope cross-correlation, then `tpad=start_duration=0.08:start_mode=clone` (+ stop pad).

## Links
- [[Lindsay reels — playbook (rules learned from Harsh's feedback)]]
