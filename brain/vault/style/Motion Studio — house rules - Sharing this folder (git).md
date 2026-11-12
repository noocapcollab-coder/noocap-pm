---
type: style
---
This folder is a clone of the private GitHub repo noocapcollab-coder/motion-studio, shared by every editor. Everything except raw footage, audio and renders is in it.
- At the start of every session run `git pull --rebase`. If it stops because of local changes, tell the editor what it found and do not discard anything.
- When you save a correction or a new rule into a style, playbook, house, tools or CLAUDE.md file, finish by committing and pushing just those files: `git add <the files>`, `git commit -m "<client or area>: <what changed>"`, `git push`. If the push is rejected, run `git pull --rebase` and push again. Never force-push, and never add anything under `videos/` or any video, audio or image-sequence file.
- Footage, finished videos and the clients' reference videos live in Drive and Notion, not in git. Download what a video needs into `videos/<client>/<job>/` on this computer.

## Links
- [[Motion Studio — house rules]]
