---
type: style
---
```bash
python3 build/assemble.py preview && python3 build/assemble.py audio && python3 build/avatar_audio.py
python3 build/tighten.py --preview main
ffmpeg -i out/final/Nicole-<SLUG>-main-PREVIEW-TIGHT.mp4 -filter_complex "[0:v]setpts=PTS/1.2,fps=30[v];[0:a]atempo=1.2[a]" -map "[v]" -map "[a]" out/final/Nicole-<SLUG>-main-PREVIEW-TIGHT-1.2x.mp4
```
Send the preview and `out/audio/Nicole-<SLUG>-AVATAR-ALL.mp3`.

## Links
- [[tools nicole-reels  the Nicole reel pipeline]]
