---
type: style
---
0. **Confirm the computer first.** Before any editing, check which computer this chat is linked to (its name and the connected motion-studio folder) and ask: "I'll edit on <computer name> using <folder>. Use this computer?" Wait for a yes. If no computer is linked, or the editor wants a different one, tell them to open this chat in the Claude desktop app on that computer, choose "Link to this computer" and connect its motion-studio folder (Add folder). Then check the tools are installed there (node, ffmpeg, python, npx hyperframes); if not, run NEW-PC-SETUP.md section 3 first.
1. Fetch the locked script from Notion (Lindsay script pages). Never change a word of it; if it has a problem (e.g. "four ideas" but five are listed), flag it and follow the voice.
2. Voice comes from `videos/lindsay/inbox/<name>.mp3`. Remove micropauses with `scripts/tight.py` (cuts every silence over 0.12 s at -35 dB, keeps 30 ms each side) → `voice_tight.mp3`, `words_tight.json`, `cuts.json`.
3. Word timestamps: pocketsphinx forced alignment against the script (`scripts/align_template.py`, add any odd words to the `extra` pronunciation dict, it prints OOV words) or `mlx_whisper` on Mac.
4. Write `plan.md` as a table (Seg | Type | Tight time | Voice | Visual) and wait for "approved".
5. Build (see README.md), render, contact-sheet QA every clip yourself, fix, then a fresh-subagent QA on the assembled previews, then deliver.
6. Deliver the PREVIEW (with captions) plus the face-only mp3 for the avatar. When the avatar video comes back, build FINALS.

## Links
- [[Lindsay reels — playbook (rules learned from Harsh's feedback)]]
