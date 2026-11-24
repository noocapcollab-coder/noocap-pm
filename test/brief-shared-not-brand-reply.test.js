// Bug hunter Nov 24: test bank case speakon-second-reel was read as brand_reply twice in the 13:46 UTC gate run (after
// cb1c858), though it passed before. Cassie wrote on the paid reel 1 deal "I've attached the creative brief for your
// reference ... let me know when you'd be able to share the first script": a brief for reel 2. Read as brand_reply,
// the brief never reaches its own deal and card and the script writer is never handed it (rule 23, rule 42).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextGuards, sharesBriefForScript } from '../lib/inbox.js';

const speakon = "Hi Chris and team!\nHope you're doing well!\nNow that we've completed the payment for our first collaboration, we'd love to start planning and scheduling our second Reel!\nIdeally, we'd like to get this one published as soon as possible. I've attached the creative brief for your reference. https://app.notion.com/p/SpeakON-Notes-Agent-Brief-406f07094bef8099954ae9629937623a\nCould you take a look and let me know when you think you'd be able to share the first script with us?\nBest,\nCassie";

test('a brand sharing a brief and asking for the script is a brief, not a brand_reply (speakon-second-reel)', () => {
  const x = applyTextGuards({ from_role: 'brand', event: 'brand_reply', needs_reply: true }, { text: speakon });
  assert.equal(x.event, 'brief');
});

test('sharing a brief for a script is told apart from other brief talk', () => {
  assert.equal(sharesBriefForScript(speakon), true);
  assert.equal(sharesBriefForScript('Here is the brief for the next video, please send the script by Friday.'), true);
  assert.equal(sharesBriefForScript("Please find the campaign brief attached. When can we expect the script?"), true);
  // a promise to send the brief later is still the brand's move
  assert.equal(sharesBriefForScript("We'll share the brief soon, then you can start on the script."), false);
  // a rate question stays an inquiry (rule 46)
  assert.equal(sharesBriefForScript("I've attached the brief. What are your usual rates for a reel with a script?"), false);
  // no script asked for
  assert.equal(sharesBriefForScript("I've attached the brief for your reference."), false);
});

test('the guard leaves other events and our own emails alone', () => {
  assert.equal(applyTextGuards({ from_role: 'noocap', event: 'brand_reply' }, { text: speakon }).event, 'brand_reply');
  assert.equal(applyTextGuards({ from_role: 'brand', event: 'payment_confirmed' }, { text: speakon }).event, 'payment_confirmed');
});
