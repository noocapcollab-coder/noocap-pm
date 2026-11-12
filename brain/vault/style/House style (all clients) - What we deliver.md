---
type: style
---
We make **motion-graphic clips only**. The client's editor assembles the final video (footage, captions, cuts, sound).

| Clip type | When | Canvas | File name |
|---|---|---|---|
| **TOP** | Split-screen moments: the editor puts the speaker in the bottom part | **1080 × 960** by default (client may override the split height) | `NN-top-<slug>.mp4` |
| **FULL** | The graphic covers the whole frame | **1080 × 1920** | `NN-full-<slug>.mp4` |

- **No captions** unless the client file says otherwise. Headline typography only: the word or phrase that should hit on screen.
- 30 fps, H.264, opaque background, plus a **0.5 s hold** on the last frame for handles.
- Numbered in script order. `out/EDIT-NOTES.md` lists every clip: number, TOP/FULL, the script line, the **start timecode in the voiceover**, and the length.
- Clip timing comes from the voiceover's word timestamps (`words.json`), so each clip starts on the word it illustrates.
- **Safe zone (all clients, map: `house/safe-zone-9x16.png`).** Important graphics and text go in the white area; the red zone only if really needed.
  - FULL (1080×1920): **y 211–1464**. Above y 938: **x 55–1025**. Below y 938: **x 55–915** (right side is under the Instagram buttons).
  - TOP (1080×960, top half): **y 211–938, x 55–1025**.
  - Full-bleed backgrounds and footage may fill the red zone; titles, numbers, logos, labels and key UI may not.

## Links
- [[House style (all clients)]]
