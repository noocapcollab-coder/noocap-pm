# Valeri — Graphics (tweaks on top of the house catalogue)

Uses every graphic in `house/GRAPHICS.md`. Valeri-specific changes:

| # | Change |
|---|---|
| G1 | Tool intro: real logo zooms slowly, then becomes the transition into the next scene (white → black, i02). |
| G2 / G4 | Several models named: show each **real model logo**; they appear on their word, then are cleared as narration moves on (i02 Claude → Qwen). |
| G5 | Stat card on white (i02): real source card, number counts up, key words highlighted. |
| G6 | Real UI in a rounded frame (6 px `#979797` outline) on the dot grid; **slow premium zoom** to the key element; red highlight box in `accent`. When a prompt is typed (Claude etc.): realistic cursor click, then typing (i01). |
| G7 | GitHub repos: **real screen recording** of the repo, clean (no bookmarks bar), slow zoom onto the repo name (i06, i01). |
| G15 | CTA: "Comment *“KEYWORD”*" in white sans + red serif italic (o01/o02). |
| G21 (new) | **Emphasis pop-up**: key phrase ("completely free", "$0") on a card or red stamp that springs in over the scene (i01, i06). |
| G22 (new) | **Pixel tile**: pixel-art icon in a chunky dark frame with a label above (m01), for process steps or "build" moments. Selective use only. |
| G23 (new) | **Real product visual**: when a model/product is named (e.g. Claude Opus), show its real launch visual or wordmark (i05 "Opus 5.5"). |
| — | **Favourites:** G6, G7, G1, G5, G21, G22. |
| — | **Switched off:** none yet. |

## Approved in production (ThinkingOrbs, 2026-10-02) — reuse first
Reference build: `videos/valeri/2026-10-02-thinking-orbs/build/gen_clips.py`.

| Move | Clip there | How |
|---|---|---|
| Real footage in a still grey frame, footage zooms inside (clip-path inset) | H1 | 6 px `#979797` frame on the dot grid, footage scale 1 → 1.12 over ~5 s |
| Cross-out → swap | H1 | Label crossed out in red on "anymore"; GitHub logo + red serif-italic "*open-sourced*" with drawn underline in the same spot |
| Zoom-through, white → black | 01 | Phone demo flies into camera (scale 3.2, blur) while page fades to black; next real UI resolves from blur |
| Real states, one per word | 02 | Cropped real UI pills on black, each on its word |
| Repo reveal | 03 | Real GitHub page, slow zoom to the repo name; GitHub logo + name decode; ★ count-up to the real number (finish ≥ 0.2 s before the cut) |
| Real UI + list of real options | 04 | Phone recording left; real option names pop in on the beat |
| Minecraft moment: drop it in (G22) | 05 | Real install command types; pixel block drops (steps ease, thud, pixel dust) into a chunky pixel tile; becomes the real live product |
| Red highlight box + FREE stamp | 06, 07 | Slow zoom onto the exact line of a real page, red rounded box; red FREE stamp springs in tilted |
| Confirmations as type, not boxes | 04, 05 | "already *built*", "it *works*": bold sans + red serif italic, no box, no icon |
| CTA | 08 | "Comment" white sans over the real product blurred ~30 %; “*KEYWORD*” huge red serif italic; "GitHub link" on its word |

Rhythm that worked: 9 graphics / 33 s, 4 FULL (44 %), never 2 splits in a row, hook = one split graphic with 4 steps.

## Added in production (5 GitHub repos, 2026-10-12) — reusable
Reference build: `videos/valeri/2026-10-12-five-github-repos/build/gen_clips.py` (`repo_reveal()` and `fan()` are parametric). Templates copied to `library/fgr-*.html`.

| Move | Clip there | How |
|---|---|---|
| Repo reveal with ordinal | 01, 04, 06, 08, 10 | Grey serif-italic ordinal ("*1st*" … "*the last one*"); 2x capture of the repo header in the grey frame, zoom ends cropped exactly to title row + branch row (no half rows); one centred column below: name decodes, URL, real description, ★ real count (lands ≥ 0.2 s before the cut) |
| Five-repo panel | H1, H2, 12 | One dark panel in the grey frame holding the 5 real GitHub title rows (avatar + name + Public, 2x captures), one row per beat; rows dim to 40 % on a "but…" line |
| Prompt cross-out → terminal | 05 | Real Claude prompt box in the grey frame, red cut on "prompt"; real CLI output (`task-master list`, the repo's own tasks) types in line by line |
| Real list + red box | 03 | Real skills folder in a 3-row frame, red box on the named row; box fades out, list slides, box returns on the next row |
| Count + real grid | 07 | Big number counts up from frame 0 ("500+"), then real example images from the repo pop into a 5×2 grid on "every …" |
| Pixel build → cross-out → real list (G22) | 09 | Pixel agent built bottom-up block by block on "building … from scratch", red slash, then the real README list scrolls; GitHub logo + "*open-sourced*" with drawn underline |
| Before / after cut | 11 | Real README "Before" card, red line on "cut", card collapses; real "After" card rises; "just the *steps*" |
| CTA with "plus more" | 12 | "Comment" + huge red “*KEYWORD*” over the real page blurred at 30 % (no fade from black); real repo thumbnails + dashed empty slots on "plus N more" |

Layout rules (from client review 2026-10-12, "bad alignments, not proper UI"): everything centred on x = 540 (never a left/right inset that shifts the centre); headlines are two-tone (whole line on screen dim grey, each word lights up on its beat) so a line never sits off-centre mid-reveal; no stretched captures (use the image's natural width); crop zoomed UI on row boundaries; no drawn chips standing in for real UI; dimmed elements go solid grey, not see-through.

QA lessons: counts must land ≥ 0.2 s before the cut; all scrolling/drift stops before the 0.5 s hold; never start a clip on black; a capture smaller than its frame needs the frame background set to the page colour.
