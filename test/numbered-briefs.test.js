// CapCut x Chris (Nov 14): Mia sent "Second brief:" and "Third brief:" links; each must land on its own card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { numberedBriefs } from '../lib/briefs.js';

test('Mia\'s numbered briefs map to videos 2 and 3', () => {
  const t = "Here are the briefs for the second video and the third video.\nSecond brief：https://sparklinggroup.feishu.cn/wiki/Kjc8wjZ9vimTewkSjJFcAY3Knvf?from=from_copylink\nThird brief：https://sparklinggroup.feishu.cn/wiki/G2TwwD39eiKs5PkAbNFc3SJgnEh?from=from_copylink";
  assert.deepEqual(numberedBriefs(t).map((b) => [b.n, b.link.slice(-40)]), [[2, 'Kjc8wjZ9vimTewkSjJFcAY3Knvf?from=from_copylink'.slice(-40)], [3, 'G2TwwD39eiKs5PkAbNFc3SJgnEh?from=from_copylink'.slice(-40)]]);
});

test('other numbered forms, and plain links are ignored', () => {
  assert.deepEqual(numberedBriefs('Brief 2: https://a.com/x\nVideo 3 brief - https://b.com/y').map((b) => b.n), [2, 3]);
  assert.deepEqual(numberedBriefs('Here is the brief: https://a.com/x\nOur site https://b.com'), []);
});

test('every brief link reaches the script writer, the doc first (AI Inspo x Duncan)', async () => {
  const { briefLinkLines } = await import('../lib/briefs.js');
  const t = briefLinkLines(['https://drive.google.com/drive/folders/1fyUHXezuz6Y-lX8otvPtYnpPxc3KsAg6?usp=sharing', 'https://docs.google.com/document/d/1IOfSNbddcTQt_YLu67G4GwB9tf4ZSn1pVaZ30pAuBeA/edit?usp=sharing']);
  assert.match(t, /2 links/);
  assert.ok(t.indexOf('Brief doc') < t.indexOf('Drive folder'));
  assert.equal(briefLinkLines(['https://a.com/x']), 'Brief: https://a.com/x');
});
