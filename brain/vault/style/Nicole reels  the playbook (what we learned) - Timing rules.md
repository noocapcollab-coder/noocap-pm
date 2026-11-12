---
type: style
---
- A clip's start is the first word of its sentence (raw time from voice.json). Clips end where the next one starts.
- Cue animations to word start times (`// word .52 · word 1.10` comments at the top of each clip's JS).
- **Micro-pauses:** `tighten.py` cuts every silence ≥0.15 s at −38 dB down to 0.10 s, with video and audio cut together so lip sync holds.
- **Speed:** finals at 1.2x (`setpts=PTS/1.2, atempo=1.2`) plus a normal-speed copy.
- **Sound:** `sfx.py` computes the same cut map as tighten, so effects land on the tight timeline. Write events per clip in `job.py → SFX()` and match every visible action (pop on a card, stamp on a ✕, ticks on typing, whoosh on transitions, ding on a tick). There's a 120 bpm pluck music bed, sidechain-ducked under the voice.
- **ACE-Step** (AI music) needs a GPU and Hugging Face access, which this setup doesn't have. Keep the procedural SFX and music unless Harsh provides tracks.

## Links
- [[Nicole reels  the playbook (what we learned)]]
