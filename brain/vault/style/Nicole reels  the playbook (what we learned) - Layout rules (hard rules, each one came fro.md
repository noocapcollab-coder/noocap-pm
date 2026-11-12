---
type: style
---
- **The hook is a TOP clip** (graphic in the top half, Nicole in the bottom half) **with Nicole on screen from frame 0**. Never a full face and never a full-screen Nicole.
- **Never two TOP clips in a row.** Alternate TOP and FULL.
- **Keep Nicole's screen time low**, about 11–13 s of a 40–55 s reel. She's usually in the hook plus one TOP clip in the middle. ("We are showing Nicole on screen too much.")
- **Avatar card:** a near full-width rounded card under the graphic (x18 y978 w1044 h924, radius 28) with a 6 px black border, cropped tight on head and shoulders (`CROP` in avatar_final.py).
- **Visuals must be BIG and centred.** Nothing under 36 px on screen except creator credits, and headlines are 76–96 px. Check alignment strictly on every contact sheet. ("The visuals are too small… strictly check and fix the alignment.")
- **Fill the frame.** No big empty bottom halves. If a scene leaves 600 px empty, scale it up or add the next beat there. (The step-1 GitHub frame was rejected for tiny screenshot strips and an empty bottom.)
- **No empty first frames.** Every clip opens with content already on screen (`hook0`/`enter0`), never a blank peach screen.
- **Realistic content, no grey placeholder lines.** Write real-looking resumes, invoices, chat boxes, terminals, code and files. ("Make the visuals more realistic rather than showing lines.")
- **Real assets over mockups.** Use GitHub pages, real repo stats, real UIs and real creator videos. Logos are never redrawn.
- **Anything she names appears on screen**, and numbers count up.
- **One clear idea per scene**, kid-simple metaphors: a battery for limits, a sorting machine for routing, a 1-2-3-4 ladder for steps, a "#1" medal, an invoice with a red ✕.
- **Mascot:** use Harsh's supplied Claude mascot image (`assets/imgs/mascot.png`), never a copyrighted character. Our own drawn mascot is OK.
- **Real people:** only use a real person's photo when Harsh supplies it and asks. Keep captions generic ("Anthropic right now (probably)") and never put words in a real person's mouth.
- **Credit creators.** Any third-party video (prompt-motion.com and similar) shows "made with Claude · @handle" or a handle label. The site says the videos belong to their creators.
- **Transitions:** soft zoom-through in (`xin`) and a quick blur out (`xout`) on every clip, with swaps between headlines (`swap`). Pops and back-out eases, no hard cuts mid-sentence.

## Links
- [[Nicole reels  the playbook (what we learned)]]
