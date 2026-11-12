---
type: style
---
```bash
cd videos/nicole && mkdir -p 2026-MM-DD-topic && cd 2026-MM-DD-topic
cp -r ../../../tools/nicole-reels/build . && mkdir -p source out/final out/audio qa
cp ../inbox/<audio>.mp3 source/voice.mp3
python3 ../../../tools/nicole-reels/txs.py source/voice.mp3 source/voice.json   # or mlx_whisper on Mac
```
Print the words with times, write plan.md (copy a table from `examples/plan-*.md`), and wait for "approved".

## Links
- [[tools nicole-reels  the Nicole reel pipeline]]
