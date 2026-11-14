// Posted links found on their own (Harsh, Nov 15): Readdy AI x Lindsay is the first case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { brandKeys, mentionsBrand, matchPosts, parseYoutubeFeed } from '../lib/postedlinks.js';

test('brand keys drop generic words', () => {
  assert.deepEqual(brandKeys('Readdy AI'), ['readdy', 'readdyai']);
  assert.ok(brandKeys('Teamily AI × Brad').includes('teamily'));
  assert.ok(!brandKeys('Readdy AI').includes('ai'));
});

test('a caption naming the brand or its @handle matches, others do not', () => {
  assert.ok(mentionsBrand('Built my whole site with @readdy.ai in 10 minutes #ad', 'Readdy AI'));
  assert.ok(mentionsBrand('Readdy turns a prompt into a website', 'Readdy AI'));
  assert.ok(!mentionsBrand('Claude + @higgsfield.ai can turn your video into a polished edit', 'Readdy AI'));
  assert.ok(!mentionsBrand('Already done', 'Readdy AI'));
});

test('only posts around the post date count', () => {
  const posts = [
    { url: 'a', text: 'Readdy built this', at: '2026-11-14T15:00:00Z' },
    { url: 'b', text: 'Readdy again', at: '2026-10-01T15:00:00Z' },
    { url: 'c', text: 'something else', at: '2026-11-14T16:00:00Z' },
  ];
  assert.deepEqual(matchPosts(posts, { brand: 'Readdy AI', postDate: '2026-11-14' }).map((p) => p.url), ['a']);
});

test('YouTube feed entries become Shorts links', () => {
  const xml = '<feed><entry><yt:videoId>abc123</yt:videoId><title>I built a site with Readdy</title><published>2026-11-14T10:00:00+00:00</published><media:group><media:description>#ad @readdy</media:description></media:group></entry></feed>';
  const [p] = parseYoutubeFeed(xml);
  assert.equal(p.url, 'https://www.youtube.com/shorts/abc123');
  assert.ok(mentionsBrand(p.text, 'Readdy AI'));
});

test('the real Readdy reel (Nov 14, lindsay.ai) matches the Readdy AI deal', () => {
  const posts = [{ url: 'https://www.instagram.com/reel/DfvNh_pGUud/', text: 'Paste its URL into Readdy AI. Comment READDY and I\'ll send you the tool. #ReaddyAI #WebDesign', at: '2026-11-14T21:51:07.000Z' },
    { url: 'https://www.instagram.com/reel/Dfp3JEAil-H/', text: 'PS2-style AI videos... @higgsfield.ai MCP with Seedance', at: '2026-11-12T19:59:17.000Z' }];
  assert.deepEqual(matchPosts(posts, { brand: 'Readdy AI', postDate: '2026-11-14' }).map((p) => p.url), ['https://www.instagram.com/reel/DfvNh_pGUud/']);
});
