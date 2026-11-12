import test from 'node:test';
import assert from 'node:assert/strict';
import { noMoney, dropMoneySections, slug } from '../lib/brain.js';

test('money never reaches the brain', () => {
  const t = noMoney('Agreed $1,500 for one reel, then USD 2000, ₹45,000 and 800 dollars; 3 reels by Friday; 1500 per video');
  assert.ok(!/1,500|2000|45,000|800|1500/.test(t), t);
  assert.ok(t.includes('3 reels by Friday'));
  const w = dropMoneySections('WHO: Lemlist\nCONTACTS: Ana\nPAYMENT: net 30 via Wise, paid late twice\nWATCH OUT: never post on weekends');
  assert.ok(!/Wise|net 30/.test(w)); assert.ok(w.includes('never post on weekends') && w.includes('Ana'));
  assert.equal(slug('Higgsfield.AI (agency)'), 'higgsfield-ai-agency');
});
