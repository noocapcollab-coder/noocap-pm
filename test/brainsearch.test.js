import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchBrain } from '../lib/brainsearch.js';

test('search_brain finds the right brand section and its graph links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  fs.mkdirSync(path.join(root, 'sources/brands'), { recursive: true });
  fs.mkdirSync(path.join(root, 'graphify-out'));
  fs.writeFileSync(path.join(root, 'sources/brands/lemlist.md'), '# Lemlist\n\nBrand.\n\n## Brand wiki\nWATCH OUT: John wants the script in Google Docs.\n');
  fs.writeFileSync(path.join(root, 'sources/brands/capcut.md'), '# CapCut\n\n## Brand wiki\nWATCH OUT: Mia needs UIDs.\n');
  fs.writeFileSync(path.join(root, 'graphify-out/graph.json'), JSON.stringify({ nodes: [{ id: 'lemlist', label: 'Lemlist' }, { id: 'lindsay', label: 'Lindsay' }], links: [{ source: 'lemlist', target: 'lindsay', relation: 'works with' }] }));
  const r = searchBrain('what does Lemlist want for the script?', { root });
  assert.equal(r.results[0].title, 'Lemlist');
  assert.ok(r.links[0].includes('works with Lindsay'));
});
