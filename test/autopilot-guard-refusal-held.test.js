// Bug hunter (Nov 23): Dreamina x Chris and Runway AI x Chris script drafts were refused by the send guard ("these
// scripts already went to the brand") on every heartbeat from 12:36 / 14:07 UTC onwards. autoSend threw, runAutopilot
// logged it as skipped and tried again 10 minutes later, forever, while Approvals still said "Sends on its own in 30 min"
// and Harsh had been told the script was going. A guard refusal must hold the draft for Harsh once (Why: Needs you).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rtx = (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s, text: { content: s } }] });
const CARD = 'https://app.notion.com/p/Dreamina-Chris-3ea508e99dda815490c2e0994cd53cea';

function draftPage() {
  return { id: 'draft-1', url: 'https://app.notion.com/draft1', created_time: '2026-11-23T12:36:13.000Z', properties: {
    Subject: { type: 'title', title: [{ plain_text: 'Re: Paid Collaboration with Dreamina' }] },
    Status: { type: 'select', select: { name: 'Draft' } }, Kind: { type: 'select', select: { name: 'Script' } },
    Attach: { type: 'select', select: { name: 'Script PDF' } }, To: rtx('outreach@katlasmedia.com'),
    Why: rtx('Rudraksh\'s script for "Dreamina × Chris" is ready (status 5). Sends on its own in 30 min unless you reject it.'),
    Body: rtx('Hi Anna,\n\nHere is the script for the Dreamina video. Let us know if you approve or have any feedback.\n\nBest,\nChris\'s Team'),
    Creator: { type: 'select', select: { name: 'Chris' } }, Video: { type: 'url', url: CARD },
    Deal: { type: 'relation', relation: [{ id: 'deal-new' }] }, Error: rtx(''),
  } };
}

function mock(calls, page) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts.method, body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.includes('/query')) {
      const f = JSON.stringify(body || {});
      if (/"Script"/.test(f) && /"Sent"/.test(f)) return ok({ results: [{ id: 'sent-old', properties: { Video: { type: 'url', url: CARD }, Context: rtx(''), 'Sent At': { type: 'date', date: { start: '2026-11-19T22:26:00.000Z' } } } }] });
      return ok({ results: [] });
    }
    if (u.endsWith('/pages/draft-1') && opts.method === 'PATCH') {
      for (const [k, v] of Object.entries(body.properties || {})) page.properties[k] = { type: 'rich_text', ...v, rich_text: (v.rich_text || []).map((t) => ({ plain_text: t.text?.content || '', text: t.text })) };
      return ok(page);
    }
    if (u.endsWith('/pages/draft-1')) return ok(page);
    if (u.includes('/pages/deal-new')) return ok({ id: 'deal-new', properties: {} });
    return ok({});
  };
}

test('a script the send guard refuses as already sent is retired, not held, and nothing is sent', async () => {
  // System check, Nov 27: the held Dreamina duplicate sat in Approvals as "Needs you" for 21 hours. An unrevised script
  // whose cards already went to the brand is retired at once (Rejected, with the guard's reason in Error).
  const { autoSend } = await import('../lib/outbox.js');
  const calls = [];
  const page = draftPage();
  mock(calls, page);
  const r = await autoSend('draft-1');
  assert.equal(r?.retired, true);
  assert.match(r.why, /already went to the brand/);
  const status = calls.find((c) => c.method === 'PATCH' && c.body?.properties?.Status);
  assert.equal(status?.body.properties.Status.select.name, 'Rejected');
  assert.match(status.body.properties.Error.rich_text[0].text.content, /^Retired: these scripts already went to the brand/);
  assert.ok(!calls.some((c) => /n8n|gmail|railway/i.test(c.url)), calls.map((c) => c.url).join(' '));
});

test('guardRefusal only treats pre-send refusals as holds', async () => {
  const { guardRefusal } = await import('../lib/outbox.js');
  assert.match(guardRefusal(new Error('Not sent: someone on our side already replied in this thread.')), /already replied/);
  assert.equal(guardRefusal(new Error('Not sent: it was rejected while the send was being prepared.')), null);
  assert.equal(guardRefusal(new Error('This email is already being sent, so it was not sent a second time.')), null);
  assert.equal(guardRefusal(new Error('Gmail 500')), null);
});
