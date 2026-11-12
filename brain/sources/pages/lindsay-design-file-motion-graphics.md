# LINDSAY — DESIGN FILE (Motion Graphics)

Notion page, last edited 2026-10-02.

This page is the single source of truth for Lindsay's motion graphics. Claude reads it at the start of every Lindsay video, so whatever you change here is used in the next build.
  - To change something: edit it directly, then add a line to the Change log at the bottom (date, your name, what changed).
  - Not sure? Leave a Notion comment on the line instead of editing.
  - Status: v0.3 (draft). Built from Lindsay's own videos, reference videos v01–v08, frames f01–f04 and typography t01–t04.

## 1. What we deliver
- We make motion-graphic clips only. The editor assembles the final video (footage, captions, cuts, sound).
- No captions. Headline typography only: the word or phrase that should hit on screen.
- Every graphic is either:
- For every video we hand over: a preview (full video with graphics), a transparent overlay (HEVC with alpha, so the editor can place Lindsay in split or full screen), EDIT-NOTES with timecodes, and a CLONE.mp3 (only her on-screen lines, silences removed).

## 2. Pacing and retention
- New graphic every ~1.8 s (1.7–2.4 s). Nothing holds longer than ~4 s without something moving inside it.
- Inside a graphic, something changes every 0.5–1 s (a card lands, a number ticks, a cursor clicks).
- Never more than 2 TOP (split) graphics in a row; the next one goes FULL.
- At least 40 % of graphics are FULL. Big reveals (the tool's name, the key screen, lists, the output file) are always FULL.
- Hook: open on Lindsay (TOP) for the first line, then go FULL on the payoff visual. No cuts until the first sentence ends.
- About 60–70 % of lines get a graphic. Lines with nothing concrete to show stay on Lindsay.

## 3. Safe zone (Instagram / TikTok UI)
Important graphics and text go in the white area. The red area only if really needed. Backgrounds and footage may fill the red area; titles, numbers, logos, labels and key UI may not.

## 4. Colours
Sampled from Lindsay's own videos (colour only — don't copy her old edits).
- One background per clip. A tool's own brand colour may replace gold for that tool's moment.

## 5. Typography
- Sans: Inter Display 700–800, tight tracking (−0.03em), sentence case. Headlines and labels.
- Emphasis: Playfair Display Italic, lowercase, for the one word that matters.
  - Regular weight next to the sans: "I built a system" (t04).
  - Black weight in green or coral when it's the word (t01).
  - Keywords in curly quotes: “cloud” (t03).
- Sizes (1080 px canvas): hero word 150–180 px · headline 96–120 px · label 44–56 px.
- One headline per graphic, max 3–4 words, never more than 2 lines.
- Open question: keep these free fonts, or switch to Lindsay's licensed brand fonts?

## 6. Motion
- Signature entry "rise + focus": every element rises from +40 px below while blurred (16 → 0 px), fades in and scales 0.96 → 1 over 0.45 s. Groups stagger 0.08–0.12 s.
- Exits: fast (0.2 s) fade + blur, or a hard cut. Most clips end on a 0.5 s hold.
- Tool name: decodes left to right, letters flicking through 2–3 glyphs (~0.5 s).
- Cross-out: icon greys in → full colour → red line draws corner to corner.
- Numbers always count up. Big money or counts use the flip counter.
- Cursor: real macOS cursor on a slight curve; click = small bounce + ripple.
- Camera: slow push-in on UIs, punch-in on the exact element. No zoom on Claude chat typing frames.
- Never: spins, bouncy text, wipes, glitch transitions, emoji, shaky cam.

## 7. Real assets only
- Logos, app icons and interfaces are always real (screenshots, screen recordings, official launch footage). Never redraw a logo or fake a UI.
- When Lindsay talks about Claude chat, show the real Claude chat UI with the prompt typed in.
- When she shows a tool or extension, use a real screen recording of it. Blur bookmarks bars and anything private.
- App icons: rounded squares (22 % radius), soft shadow. Screenshots: window frame, 16–24 px radius, 1 px border, soft shadow.
- Never invent numbers or claims. If a number in the script can't be sourced, flag it.

## 8. Which graphic for which line
Lindsay's favourites — reach for these first: G16, G17, G18, G19, G20, G15.
Rule of thumb: if she names something, show that exact thing. If she names a number, count it up. If she names several things, each gets its own card on its own word.

## 9. Reference frames (what we like)

#### Reference videos (stored with Claude, motion only)

## 10. Don't do (Lindsay)
- Captions or subtitles.
- Fake or approximate UIs, logos or loading screens (e.g. no extension "loading" frames — show the clean real page).
- Zoom on Claude chat typing frames.
- Copying the look of her old edits (her videos are a colour reference only).
- Add more here as feedback comes in.

## 11. Open questions
- [ ] Free fonts (Inter Display + Playfair) or Lindsay's licensed brand fonts?
- [ ] Confirm gold #E4B23C as her accent.

## 12. Change log
