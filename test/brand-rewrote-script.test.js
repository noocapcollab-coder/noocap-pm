// System check Nov 24 (afternoon): Fotor x Chris (Marina) and Fotor x Duncan (Zoey) each sent their OWN rewritten
// version of our script, asking if it works for the creator. Both were read as script_changes: Rudraksh was told to
// rewrite and Marina got "you'll have the revised script within 2 to 3 working days". Their version is the revised
// script; the yes on it is Harsh's call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextGuards, brandRewroteScript } from '../lib/inbox.js';

const marina = "Hi ,\n\nWe've made a few adjustments to Chris's script. Please take a look at the revised version below and let us know if you have any questions or concerns.\n\nI've also attached some reference materials at the end of this email that you may find useful when creating the video.\n\nLooking forward to your feedback!\n\n*Script*\n\nHook:\n\n\"Every big explainer channel edits their talking heads like this.\"";
const zoey = "Hi Duncan's Team,\n\nThanks for your patience!\n\nWe've made some adjustments to the script to better incorporate the key selling points of Fotor Agent, including:\n\n*Talking Head + Motion Graphics*\n\nWe've attached our revised version for your review. Could you please take a look and let us know if the direction and script work for Duncan?\n\nIf everything looks good on your end, we'll submit this version to our management team for final approval.";

test("the brand's own rewritten script is a question for Harsh, not notes for the writer (Fotor x Chris, Nov 24)", () => {
  const x = applyTextGuards({ from_role: 'brand', event: 'script_changes', feedback: 'Use the revised script below', template: 'script_changes_ack' }, { text: marina });
  assert.equal(x.event, 'brand_reply');
  assert.equal(x.needs_our_info, true);
  assert.equal(x.template, null);
  assert.equal(x.feedback, null);
  assert.match(x.info_needed, /confirmation/);
});

test('same for "we\'ve attached our revised version" (Fotor x Duncan, Nov 24)', () => {
  const x = applyTextGuards({ from_role: 'brand', event: 'script_changes', feedback: 'Brand revised the script' }, { text: zoey });
  assert.equal(x.event, 'brand_reply');
});

test('real notes asking us to revise stay script_changes', () => {
  assert.equal(brandRewroteScript('Please revise the script: make the hook shorter and mention the free trial.'), false);
  assert.equal(brandRewroteScript("We've made some changes to the brief. Please send us a revised script."), false);
  const x = applyTextGuards({ from_role: 'brand', event: 'script_changes', feedback: 'shorter hook' }, { text: 'Thanks! A couple of notes on the script: shorter hook, and mention the free trial.' });
  assert.equal(x.event, 'script_changes');
});

test('an approval with their validated version stays script_approved (Weglot rule 27)', () => {
  const x = applyTextGuards({ from_role: 'brand', event: 'script_changes', feedback: 'x' }, { text: "Approved Idea, Script & Live Date With Feedback: here is the validated version. We've made a few edits to the script, updated version below." });
  assert.equal(x.event, 'script_approved');
});
