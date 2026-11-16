// Once the brand approves the script, the video card shows only the approved script (Harsh, Nov 16: "it should just
// show the approved script in this Notion page, that's it, and nothing else"). Everything that was on the card before
// (brief updates, brand feedback, older script versions, reminders) is copied to a history page under
// "Card history (before script approval)", and older script sub-pages are moved there. Nothing is thrown away.
import { notion, titleOf } from './notion.js';

export const HISTORY_PAGE = process.env.CARD_HISTORY_PAGE || '41a508e9-9dda-812b-ad84-f0d6c4e0b39c';
const SKIP_COPY = new Set(['child_page', 'child_database', 'unsupported', 'synced_block', 'link_preview', 'breadcrumb', 'table_of_contents', 'column_list', 'column', 'table', 'table_row', 'template', 'link_to_page', 'ai_block', 'transcription', 'meeting_notes']);
const BRIEF = /^\s*(📋|⏰|🎬|brief\b)/i;
const textOf = (b) => (b[b.type]?.rich_text || []).map((t) => t.plain_text || '').join('');

async function children(id) {
  const out = [];
  let cursor;
  do {
    const r = await notion('GET', `/blocks/${id}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
    out.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor && out.length < 1000);
  return out;
}

// A block as it can be written again (read-only fields dropped)
export function writable(b) {
  if (!b || SKIP_COPY.has(b.type)) return null;
  const body = { ...(b[b.type] || {}) };
  delete body.children;
  if (body.rich_text) body.rich_text = body.rich_text.map((t) => (t.type === 'mention' ? { type: 'text', text: { content: t.plain_text || '' }, annotations: t.annotations } : { type: t.type, [t.type]: t[t.type], annotations: t.annotations })).filter((t) => t[t.type] !== undefined);
  // files and images: only external ones can be written back
  if (['image', 'file', 'pdf', 'video', 'audio'].includes(b.type)) {
    if (body.type !== 'external') return { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `[${b.type} on the card before cleanup: ${body.file?.url ? 'uploaded file' : ''}]` } }] } };
    return { type: b.type, [b.type]: { type: 'external', external: body.external, caption: body.caption || [] } };
  }
  return { type: b.type, [b.type]: body };
}

// Copy blocks (with their nested children) under a parent
export async function copyBlocks(blocks, parentId) {
  const plan = blocks.map((b) => ({ src: b, w: writable(b) })).filter((x) => x.w);
  for (let i = 0; i < plan.length; i += 50) {
    const chunk = plan.slice(i, i + 50);
    const r = await notion('PATCH', `/blocks/${parentId}/children`, { children: chunk.map((x) => x.w) });
    const made = r.results || [];
    for (let j = 0; j < chunk.length; j++) {
      if (chunk[j].src.has_children && made[j]?.id) await copyBlocks(await children(chunk[j].src.id), made[j].id);
    }
  }
}

const para = (t, bold = false) => ({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(t).slice(0, 1900) }, annotations: { bold } }] } });

// Which blocks are the approved script: the brand's own validated wording if they sent it, else the newest script
// version on the card (the last sub-page named like "Script" / "UPDATED SCRIPT", else the card's own text without the
// brief, feedback and reminder toggles)
export function pickApproved(top) {
  const pages = top.filter((b) => b.type === 'child_page' && /script/i.test(b.child_page?.title || ''));
  if (pages.length) return { page: pages[pages.length - 1] };
  const inline = top.filter((b) => b.type !== 'child_page' && b.type !== 'child_database' && !(((b.type === 'toggle' || b[b.type]?.is_toggleable || b.type === 'callout' || b.type === 'quote') && BRIEF.test(textOf(b)))));
  return { inline };
}

export async function cleanCardToApprovedScript(cardId, { brandScript = '', filmingNotes = '', date = new Date().toISOString().slice(0, 10), dryRun = false } = {}) {
  const card = await notion('GET', `/pages/${cardId}`);
  const title = titleOf(card) || 'Video';
  const top = await children(cardId);
  if (!top.length) return { cleaned: false, reason: 'card is empty' };
  // Already clean (a second approval email, or the PM ran twice): the card only holds the approved script
  if (/^✅ Approved script/.test(textOf(top[0])) && !top.some((b) => b.type === 'child_page' || ((b.type === 'toggle') && BRIEF.test(textOf(b))))) return { cleaned: false, reason: 'already shows only the approved script' };
  const pick = pickApproved(top);
  const scriptBlocks = brandScript ? brandScript.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => para(l, /^\[.*\]$|^\*\*.*\*\*$/.test(l))) : pick.page ? await children(pick.page.id) : pick.inline;
  if (!scriptBlocks.length) return { cleaned: false, reason: 'no script found on the card' };
  if (dryRun) return { cleaned: false, dryRun: true, title, from: brandScript ? "brand's validated wording" : pick.page ? `sub-page "${pick.page.child_page.title}"` : 'the card text', blocks: scriptBlocks.length, moving: top.filter((b) => b.type === 'child_page').map((b) => b.child_page.title) };

  // 1. history page with everything that was on the card
  const hist = await notion('POST', '/pages', { parent: { type: 'page_id', page_id: HISTORY_PAGE }, properties: { title: { title: [{ type: 'text', text: { content: `${title.trim()} · before approval ${date}` } }] } }, children: [para(`Everything that was on the card "${title.trim()}" before the brand approved the script on ${date}. The card now shows only the approved script.`), { type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { page: { id: cardId } } }] } }] });
  await copyBlocks(top.filter((b) => b.type !== 'child_page'), hist.id);
  // 2. older script sub-pages move to the history page (copied there instead if the move isn't allowed)
  const moved = [];
  for (const b of top.filter((x) => x.type === 'child_page')) {
    try { await notion('POST', `/pages/${b.id}/move`, { parent: { type: 'page_id', page_id: hist.id } }); moved.push(b.child_page.title); }
    catch {
      const sub = await notion('POST', '/pages', { parent: { type: 'page_id', page_id: hist.id }, properties: { title: { title: [{ type: 'text', text: { content: b.child_page.title } }] } } });
      await copyBlocks(await children(b.id), sub.id);
      moved.push(`${b.child_page.title} (copied)`);
    }
  }
  // 3. the card: the approved script and nothing else (filming notes the brand attached to the approval stay with it)
  const keepPageIds = new Set();
  for (const b of await children(cardId)) {
    if (b.type === 'child_page' && keepPageIds.has(b.id)) continue;
    await notion('DELETE', `/blocks/${b.id}`).catch(() => {});
  }
  await notion('PATCH', `/blocks/${cardId}/children`, { children: [{ type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: `✅ Approved script (${date})` } }] } }] });
  await copyBlocks(scriptBlocks, cardId);
  if (String(filmingNotes).trim()) await notion('PATCH', `/blocks/${cardId}/children`, { children: [para('Brand notes for filming', true), ...String(filmingNotes).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: l.slice(0, 1900) } }] } }))] });
  return { cleaned: true, title, history: hist.url, moved, from: brandScript ? "brand's validated wording" : pick.page ? `sub-page "${pick.page.child_page.title}"` : 'the card text' };
}
