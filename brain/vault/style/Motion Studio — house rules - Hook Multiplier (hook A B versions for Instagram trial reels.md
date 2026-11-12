---
type: style
---
- Tool and editor guide: `tools/hook-multiplier/README.md`. One command on every computer: `npm run hooks -- --video <final.mp4> --creator <name> --count 20` (`npm run hooks:doctor` checks the computer).
- Flow: the first run probes the video, finds the hook end and writes `videos/<creator>/hooks/.work_<creator>_<video>/hooks.json`, then stops. Fill in `angle` and `text` (max 8 words, one `*emphasis*` word, at least 10 different angles across 20) for every variant, re-run to get the table and copy checks, show the table and wait for "approved", then re-run with `--approved`.
- Hooks must stay true to what the video delivers, never promise numbers or results the body doesn't back up, and never overstate a sponsor's product. Words the spell checker doesn't know (tool names) go in `allow_words` in hooks.json.
- Footage tier (a different opening B-roll per hook): save the clips into one folder (for Lindsay, animated websites from Pinterest; the mp4 for a pin is under v1.pinimg.com, see tools/lindsay-reels/PLAYBOOK.md) and add `--tier footage --broll <folder>`. Check `broll-picks.jpg` and `preview-sheet.jpg`; prefer windows that open on the site's hero, and use `crop` in hooks.json to drop mockup borders. Show both sheets with the table before rendering.
- Use the version of the cut that gets posted (with captions). Send the contact sheet and 2–3 sample files after QA; `qa-report.md` must show no problems before hand-over.

## Links
- [[Motion Studio — house rules]]
