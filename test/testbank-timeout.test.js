// The test bank run at 16:56 UTC on Nov 19 was killed by Vercel at 300 s (/api/daily): cases were still started up to
// 230 s in, a slow batch ran past the limit and nothing was written back, so its PM RUNS row stayed "Running".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCaseTimeout, BUDGET_MS, CASE_MS, FN_LIMIT_MS } from '../lib/testbank.js';

test('a case that hangs is cut off and counted as not run, not judged', async () => {
  const r = await withCaseTimeout(new Promise(() => {}), 20);
  assert.equal(r.error, true);
  assert.match(r.fails[0], /timed out/);
  const ok = await withCaseTimeout(Promise.resolve({ fails: [] }), 1000);
  assert.deepEqual(ok, { fails: [] });
});

test('the last batch plus writing ~30 results back always ends inside the function limit', () => {
  const writeBack = 30 * 1200;
  assert.ok(BUDGET_MS + CASE_MS + writeBack < FN_LIMIT_MS - 10000, `${BUDGET_MS} + ${CASE_MS} + ${writeBack} >= ${FN_LIMIT_MS - 10000}`);
});
