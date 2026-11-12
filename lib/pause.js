// AI pause. The Anthropic monthly spend limit was reached on 27 Oct 2026 and resets on 1 Nov 2026 00:00 UTC, so until
// then the PM makes no AI calls at all. Emails that arrive meanwhile are left untouched (not marked seen) and are read
// automatically once the pause ends. AI_PAUSED_UNTIL in Vercel overrides the date ("off" ends the pause early).
// 30 Oct: credits were topped up, but the org's monthly SPEND LIMIT in the Anthropic Console is what blocks the API
// ("You have reached your specified API usage limits") until 1 Nov. Raise it there, then set AI_PAUSED_UNTIL=off.
const UNTIL = process.env.AI_PAUSED_UNTIL || '2026-11-01T00:10:00Z';
export const aiPausedUntil = () => (/^off$/i.test(UNTIL) ? null : UNTIL);
// The pause only blocks Anthropic: with GEMINI_API_KEY set, callers keep going and lib/claude.js answers on Gemini
export const anthropicPaused = () => { const u = aiPausedUntil(); return !!u && Date.now() < Date.parse(u); };
export const aiPaused = () => anthropicPaused() && !(process.env.GEMINI_API_KEY || '').trim();
export const PAUSED_MSG = () => `AI paused until ${aiPausedUntil()} (Anthropic spend limit), will run after that`;

// System check, 12 Nov 2026: the spend limit was hit again at 19:50 IST and every inbox and lead email failed silently for
// hours (the PM only marks them "error" and retries), so Harsh never learned that brand emails were going unread. Now the
// first spend-limit or out-of-credit error sends one ⚠️ alert (Discord #pm-alerts, mirrored to WhatsApp). The headline
// never changes, so discord()'s 12-hour dedupe keeps it to one message however many emails fail.
export const SPEND_LIMIT = /usage limit|credit balance/i;
export const SPEND_LIMIT_ALERT = (err) => `⚠️ **Brand emails are not being read: the Anthropic API spend limit is reached**\nEvery inbox and lead email fails with: ${String(err).replace(/\s+/g, ' ').slice(0, 160)}\nPlease raise the monthly spend limit (or add credit) at console.anthropic.com > Settings > Limits. The unread emails are processed by themselves once it is raised.`;
export async function spendLimitAlert(err, send) {
  if ((process.env.GEMINI_API_KEY || '').trim() && !/Gemini/.test(String(err || ''))) return false; // Gemini took over
  if (!SPEND_LIMIT.test(String(err || ''))) return false;
  try { await send(SPEND_LIMIT_ALERT(err), 'pm'); } catch { /* alerting is best effort */ }
  return true;
}
