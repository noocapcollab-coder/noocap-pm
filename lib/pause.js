// AI pause. The Anthropic monthly spend limit was reached on 27 Oct 2026 and resets on 1 Nov 2026 00:00 UTC, so until
// then the PM makes no AI calls at all. Emails that arrive meanwhile are left untouched (not marked seen) and are read
// automatically once the pause ends. AI_PAUSED_UNTIL in Vercel overrides the date ("off" ends the pause early).
// Credits topped up on 30 Oct 2026, so the pause is over. Set AI_PAUSED_UNTIL in Vercel to pause again.
const UNTIL = process.env.AI_PAUSED_UNTIL || 'off';
export const aiPausedUntil = () => (/^off$/i.test(UNTIL) ? null : UNTIL);
export const aiPaused = () => { const u = aiPausedUntil(); return !!u && Date.now() < Date.parse(u); };
export const PAUSED_MSG = () => `AI paused until ${aiPausedUntil()} (Anthropic spend limit), will run after that`;
