import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Bug hunter, Nov 20: ff42ec3 made geminiFirst() follow anthropicPaused(). Vercel has AI_PAUSED_UNTIL=Dec 1 set, and the
// production build runs the tests with Vercel's env, so three AI-routing tests failed there (they passed locally) and
// the deploy went to ERROR, leaving production on the previous commit. Both test scripts must clear every env var that
// switches the AI route, so the build tests the code and not the live pause.
test('npm test and the Vercel build both clear the AI pause and AI provider env vars', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['test', 'vercel-build']) {
    const s = pkg.scripts[name];
    for (const v of ['GEMINI_API_KEY=', 'PM_AI_PROVIDER=', 'AI_PAUSED_UNTIL=off']) assert.ok(s.includes(v), `${name} sets ${v}`);
  }
});
