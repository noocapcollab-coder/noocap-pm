// Trial reels tab (Harsh, Nov 16): Zernio analytics grouped per creator and per video
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrial, summarize, captionTitle } from '../lib/trials.js';

const post = (id, acc, user, caption, at, views, extra = {}) => ({
  latePostId: id, content: caption, publishedAt: at, status: 'published', platform: 'instagram', mediaProductType: 'REELS', isSharedToFeed: false,
  profileId: 'p_' + user, platformPostUrl: 'https://www.instagram.com/reel/' + id,
  analytics: { views, impressions: views, reach: Math.round(views * 0.85), likes: 5, comments: 2, shares: 3, saves: 10, igReelsAvgWatchTime: 6500, videoDurationSeconds: 40, reelsSkipRate: 70, engagementRate: 5, lastUpdated: '2026-11-16T12:00:00Z' },
  platforms: [{ platform: 'instagram', status: 'published', accountId: acc, accountUsername: user }],
  ...extra,
});

const posts = [
  post('d1', 'A1', 'duncanrogoff', 'Comment 7 and I send the links\nmore', '2026-11-14T06:52:27Z', 17496),
  post('d2', 'A1', 'duncanrogoff', 'Comment 7 and I send the links\nmore', '2026-11-14T06:52:46Z', 1935),
  post('d3', 'A1', 'duncanrogoff', 'If you build with AI agents\nmore', '2026-11-16T13:12:26Z', 0),
  post('l1', 'A2', 'lindsay.ai', 'Comment HUMAN for the guide', '2026-10-29T13:03:59Z', 5062),
  post('feed', 'A2', 'lindsay.ai', 'A normal feed reel', '2026-10-30T13:00:00Z', 9999, { isSharedToFeed: true }),
];
const accounts = [
  { _id: 'A1', platform: 'instagram', username: 'duncanrogoff', profileId: 'p_duncanrogoff', displayName: 'Duncan Rogoff' },
  { _id: 'A2', platform: 'instagram', username: 'lindsay.ai', profileId: 'p_lindsay.ai', displayName: 'Lindsay Gonzales' },
];
const followerStats = {
  accounts: [{ _id: 'A1', currentFollowers: 36852 }, { _id: 'A2', currentFollowers: 52605 }],
  stats: {
    A1: [{ date: '2026-11-14', followers: 36584 }, { date: '2026-11-16', followers: 36852 }],
    A2: [{ date: '2026-10-28', followers: 52060 }, { date: '2026-10-29', followers: 52077 }, { date: '2026-11-16', followers: 52605 }],
  },
};
const profiles = [{ _id: 'p_duncanrogoff', name: 'Duncan' }, { _id: 'p_lindsay.ai', name: 'Lindsay' }, { _id: 'p_val', name: 'Valerie' }, { _id: 'p_def', name: 'Default', isDefault: true }];

test('feed reels and unpublished posts are not trial reels', () => {
  assert.equal(isTrial(posts[0]), true);
  assert.equal(isTrial(posts[4]), false);
  assert.equal(isTrial({ ...posts[0], status: 'failed', platforms: [{ platform: 'instagram', status: 'failed' }] }), false);
});

test('per creator totals, batches of hook variants and follower growth', () => {
  const d = summarize({ posts, accounts, followerStats, profiles }, new Date('2026-11-16T14:00:00Z'));
  const dun = d.creators.find((c) => c.username === 'duncanrogoff');
  assert.equal(dun.name, 'Duncan');
  assert.equal(dun.reels, 3);
  assert.equal(dun.batches, 2);
  assert.equal(dun.views, 17496 + 1935);
  assert.equal(dun.best.id, 'd1');
  assert.equal(dun.followersGained, 268);
  const batch = dun.batchList.find((b) => b.count === 2);
  assert.equal(batch.best.id, 'd1');
  const lin = d.creators.find((c) => c.username === 'lindsay.ai');
  assert.equal(lin.reels, 1, 'the feed reel is left out');
  assert.equal(lin.followersGained, 52605 - 52077);
  assert.deepEqual(d.waiting, ['Valerie']);
  assert.equal(d.totals.reels, 4);
  assert.equal(d.creators[0].username, 'duncanrogoff', 'most views first');
});

test('batch title is the first caption line, trimmed', () => {
  assert.equal(captionTitle('\n  Hello there\nsecond'), 'Hello there');
  assert.ok(captionTitle('x'.repeat(200)).length <= 90);
});
