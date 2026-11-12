---
type: style
---
- Mac (Apple Silicon): transcription `mlx_whisper <audio> --model mlx-community/whisper-large-v3-turbo --word-timestamps True --output-format json`; overlays HEVC with alpha via `hevc_videotoolbox`; alpha verified with `avconvert`.
- Windows: use `faster-whisper` (or `whisper`) for word timestamps; overlays as ProRes 4444 (`-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le`, .mov); skip the avconvert check and verify alpha with `ffmpeg -vf alphaextract`.
- zsh (Mac): quote `"0:a:0?"`; `set -- $var` does not split words; screenshot file names contain a special space, so use globs.

## Links
- [[Motion Studio — house rules]]
