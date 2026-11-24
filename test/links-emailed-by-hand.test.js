// System check Nov 24 (afternoon): Upfluence x Duncan. Duncan's team emailed video 1's live links on Nov 16, but Links
// Sent Date stayed empty, so on Nov 24 the PM drafted a Posted links email calling the same links "the second video".
import test from 'node:test';
import assert from 'node:assert/strict';
import { linksEmailedBefore } from '../lib/heartbeat.js';

const posted = 'Instagram: [https://www.instagram.com/reel/DfzcByjnLC1/](https://www.instagram.com/reel/DfzcByjnLC1/)\nYouTube Shorts: [https://youtube.com/shorts/ZCorEYd18n8](https://youtube.com/shorts/ZCorEYd18n8)';
const lines = [
  '📨 2026-11-16 · brand ("Upfluence" <collabs@upfluence.com>) · Re: Upfluence x Duncan Rogoff\nGreat to see the first video live! Could you share its link?',
  "📨 2026-11-16 · us (NOOCAP) · Re: Upfluence x Duncan Rogoff\nHere are the links:\nInstagram:\nhttps://www.instagram.com/reel/DfzcByjnLC1/?utm_source=ig_web_copy_link\nYouTube Shorts: https://youtube.com/shorts/ZCorEYd18n8?feature=share",
];

test('links our side already emailed count as sent (Upfluence x Duncan, Nov 24)', () => {
  assert.equal(linksEmailedBefore(lines, posted), '2026-11-16');
});
test("a creator team's email counts too", () => {
  assert.equal(linksEmailedBefore(["📨 2026-11-10 · Duncan's team · Re: x\nlive: https://youtube.com/shorts/ZCorEYd18n8"], posted), '2026-11-10');
});
test('the brand quoting a link, or no link at all, does not', () => {
  assert.equal(linksEmailedBefore(['📨 2026-11-17 · brand (A <a@b.co>) · Re: x\nis this https://youtube.com/shorts/ZCorEYd18n8 yours?'], posted), '');
  assert.equal(linksEmailedBefore([lines[0]], posted), '');
});
