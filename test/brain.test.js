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

test('script cards get what we learned about the brand, never money or contract lines', async () => {
  const { teamNotesFrom } = await import('../lib/briefs.js');
  const page = 'WHO: X\nHOW THEY WORK: They review scripts in Google Docs and want the hook in the first 3 seconds. Invoices go to finance@x.com within 30 days. They pay $1,500 per reel.\nPAYMENT: net 30\nWATCH OUT: Never mention competitors by name. The contract forbids posting before approval.\nOPEN NOW: script';
  const n = teamNotesFrom(page);
  assert.deepEqual(n, ['They review scripts in Google Docs and want the hook in the first 3 seconds.', 'Never mention competitors by name.']);
});

test('EDIT TRACKER sponsor rows find their deal for the brand email (Nov 13)', async () => {
  const { trackerDeal, brandContacts } = await import('../lib/brandemails.js');
  const deals = [{ brand: 'PromoCut', creator: 'Brad', brandEmail: 'nicole@quilmedia.com', threadCc: 'hamza@quilmedia.com, collab@noocap.co' }, { brand: 'Polar', creator: 'Valeri', brandEmail: 'ushni@polar.sh' }];
  assert.equal(brandContacts(trackerDeal(deals, 'PromoCut × Brad', 'Brad')), 'nicole@quilmedia.com, hamza@quilmedia.com');
  assert.equal(trackerDeal(deals, 'POLAR - 2', 'Valerie').brand, 'Polar');
  assert.equal(trackerDeal(deals, '10 Website', 'Brad'), null);
  assert.equal(trackerDeal(deals, 'PromoCut × Brad', 'Chris'), null);
});
