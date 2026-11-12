# Nicole — Style (tweaks on top of the house style)

**Status: v1.0 — signed off on the FIVE REPOS video (Oct 2026).** Reference build: `videos/nicole/2026-10-02-five-repos/build/` (copy `lib/nicole.css`, `gen_clips.py`, fonts from there).
Read `house/STYLE.md` first; this file wins where they disagree. A Notion design file for Nicole is still to be written; until then THIS file is the source of truth.

## Audience and feel
- Women running their own business (inbox, leads, bookkeeping, personal brand, AI tools). Mature, warm, editorial: **not girly**.
- Show the outcome in her viewer's life first, the real UI second.

## Delivery
- **Nicole is never rendered in the frame.** TOP clips (1080×960) leave the bottom half transparent for her (cutout); FULL clips cover the frame.
- Deliver: PREVIEW (striped "NICOLE GOES HERE" placeholder), HEVC overlay with cutout, CLONE.mp3, EDIT-NOTES.md.
- No captions (her editor adds them). Pacing/retention/safe zone: house rules (≥40 % FULL, never 2 TOP in a row).

## Colour
| Token | Hex | Use |
|---|---|---|
| peach (background) | `#F4EDE4` (radial to `#FBF5EE`, fine grain) | Every background. **No wood desk. No pink.** |
| espresso | `#2B211C` | Text |
| plum | `#5B2A4A` | Serif emphasis, tickets |
| clay | `#B86B55` | Second accent, underlines, rings |
| muted | `#8A7A6E` | Small labels |

## Type (approved — keep exactly)
- Sans: **Inter** 600, tight tracking (`5 tools just went`, `never turns on`).
- Serif: **Instrument Serif Italic** for names and key words (*viral*, *Invidious*, *the tap*).
- Script: **Mrs Saint Delafield** for handwritten words (*free*, *my favourite*, *repo*, “it's fixed!”).

## Layout rules (from feedback)
- **Centre-align every graphic on the frame's true centre (x = 540).** Anything below y 938 must stay narrow enough to end before x 915.
- **No polaroids. No paper cards. No washi tape.** Text, real logos and real pages sit directly on the peach background.
- Kept: plum/clay **"No. 1" ticket stubs** for list items; small paper **script labels** on top of busy real pages ("sources", "free models") for legibility; hand-drawn clay underlines and rings.
- **Hook = real images/video with lots of movement** (e.g. the real pages of each tool scrolling live in browser cards, dealt in one by one). Never a static hook.
- Explanations = **clean real UI** in a white card (26 px radius, hairline border, soft shadow) with a slow zoom to the exact element.
- Motion: soft "settle" (rise 50 px, blur 10 → 0, 0.7 s power3.out); slow zooms; no bouncy pops.
- CTA: "Comment" (sans) + keyword in large plum script + clay underline + 1–5 tickets.

## Don't
- Pink, wood desk, polaroids, paper cards, tape, tilted elements, left/right-shifted layouts, static hooks.
