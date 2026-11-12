# House style (all clients)

The shared system every client starts from. A client's `clients/<client>/STYLE.md` only lists what's **different**.
**Rule: read this file first, then the client's STYLE.md. Where they disagree, the client file wins.**

## What we deliver
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

## The idea
Every few words, a clean, literal, *real* visual of exactly what's being said, so the video can be followed on mute.

## Pacing
- New graphic every **~1.8 s** (range 1.7–2.4 s). Nothing holds longer than ~4 s without a step inside it.
- Inside a graphic, something changes every **0.5–1 s**: a card lands, a number ticks, a cursor clicks, a line draws.
- About 60–70 % of script lines get a graphic. Lines with nothing concrete to show stay on the speaker.

## Colour (structure; values live in the client file)
Each client defines these tokens: `dark`, `ink` (deeper dark for code), `light` backgrounds (1–3), `accent` (client brand), `positive` (money / success), `negative` (cross-outs, default `#E5484D`), `text-on-light`, `text-on-dark`.
- One background per clip.
- The covered tool's own brand colour may replace the accent for that tool's moment.

## Typography (structure; fonts live in the client file)
- A **sans** for headlines and labels (bold, tight tracking, sentence case).
- An **emphasis face** for the one word that matters (house default: a serif italic, lowercase), often mixed into the same line: "I built a *system*".
- Sizes on a 1080 px canvas: hero word 150–180 px · headline 96–120 px · label 44–56 px.
- One headline per graphic, max 3–4 words, never more than 2 lines.

## Motion (house moves)
- **Signature entry "rise + focus":** from +40 px below, blur 16 → 0 px, opacity 0 → 1, scale 0.96 → 1, 0.45 s `power3.out`. Groups stagger 0.08–0.12 s.
- **Exits:** fast (0.2 s) fade + blur, or a hard cut. Most clips end on the hold frame.
- **Name decode:** tool name resolves left to right, each letter flicking through 2–3 glyphs, over ~0.5 s.
- **Cross-out:** icon enters grey at 40 % opacity → full colour (0.25 s) → a red line draws corner to corner (0.25 s).
- **Numbers always count up.** Big money or counts may use the **flip counter** (dark tiles, rolling from the right).
- **Cursor:** real macOS cursor on a slight curve; click = 0.95 scale bounce plus a ripple.
- **Camera:** slow push-in on UIs (scale 1 → 1.06); punch-in zoom onto the relevant part of a real screen.
- **No:** spins, bouncy text, wipes, glitch transitions, emoji, shaky cam.

## Real assets rule
- Logos, app icons and interfaces are **always real**: `shared/ui/`, the tool's website, or a live capture of public pages. Never redraw a logo or fake a UI.
- App icons: rounded-square tiles, radius 22 %, soft shadow.
- Screenshots: window frame, 16–24 px radius, 1 px border, soft shadow; optional accent outline or glow.

- **Screen recordings show only the app being talked about** (e.g. only the Claude UI). Cut out every frame where another window, app or desktop appears (Discord, Mission Control, screenshot toolbars), and never swap in a different recording. Hide the recording person's own name and account details (sidebars, recent chats, personal menus); OCR-check every second before using a recording. Raw recordings go in `shared/ui/<app>/_raw-do-not-use/`, clean cuts beside them with a NOTES.md. (Added 2026-10-08, Harsh.)

## Never do
- Captions or subtitles (unless the client file asks for them).
- Fake or approximate UIs and logos.
- Hold a static frame longer than ~4 s.
- Stock footage that doesn't literally match the line.
