import test from 'node:test';
import assert from 'node:assert/strict';
import { openRawFolders } from '../lib/drive.js';
import { BOARDS } from '../lib/tools.js';

// Heartbeat 11:44 IST, Nov 22: the daily raw-folder opener shared every live card's folder one Drive call at a time
// with no time check and the run was killed at 250 s ("stuck on: after Invoices"), so the rest of the tick never ran.
const card = (n, folder) => ({ properties: {
  Status: { type: 'status', status: { name: `${n}- Something` } },
  'Raw Footage': { type: 'url', url: `https://drive.google.com/drive/folders/${folder}` },
} });
const snapWith = (rows) => async () => ({ boards: { [BOARDS[0].ds.replace(/-/g, '')]: { rows } } });
const rows = Array.from({ length: 20 }, (_, i) => card(7, `folder${String(i).padStart(4, '0')}abcdefgh`));

test('the raw-folder opener stops sharing once the heartbeat is out of time', async () => {
  const shared = [];
  let calls = 0;
  const late = () => calls++ >= 1; // time for one batch only
  const n = await openRawFolders({ late, share: async (id) => { shared.push(id); return true; }, snapshot: snapWith(rows) });
  assert.ok(shared.length > 0, "the first batch still runs");
  assert.ok(shared.length < rows.length, `shared ${shared.length} of ${rows.length} after running out of time`);
  assert.equal(n, shared.length);
});

test('with time left it shares each live card folder once and skips cards outside 6 to 11', async () => {
  const shared = [];
  const all = [...rows, rows[0], card(4, 'notlive0000abcdefgh'), card(12, 'posted0000abcdefgh')];
  const n = await openRawFolders({ share: async (id) => { shared.push(id); return true; }, snapshot: snapWith(all) });
  assert.equal(n, 20);
  assert.equal(new Set(shared).size, 20);
  assert.ok(!shared.some((id) => /notlive|posted/.test(id)));
});
