// Turns the script on a video's Notion page into a clean PDF for the brand.
// The auto-added brief lives in a "📋" toggle and is left out, so only Shreya's script is exported.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { notion, titleOf } from './notion.js';

const BRIEF_TOGGLE = /^\s*📋|^\s*brief\b/i;
const LEGACY_BRIEF_HEADINGS = /^(brief|key points|must mention|deliverables|dates|brief links|full brief|source email|brief update.*)$/i;

async function children(id) {
  const out = [];
  let cursor;
  do {
    const res = await notion('GET', `/blocks/${id}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
    out.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && out.length < 1000);
  return out;
}

const runsOf = (b) => (b[b.type]?.rich_text || []).map((t) => ({ text: t.plain_text || '', bold: !!t.annotations?.bold, italic: !!t.annotations?.italic, code: !!t.annotations?.code }));
const textOf = (b) => runsOf(b).map((r) => r.text).join('');

// Collect the script blocks, skipping the brief
export async function scriptBlocks(pageId) {
  const top = await children(pageId);
  const hasScriptHeading = top.findIndex((b) => /^heading_/.test(b.type) && /script/i.test(textOf(b)) && !BRIEF_TOGGLE.test(textOf(b)));
  const list = hasScriptHeading >= 0 ? top.slice(hasScriptHeading) : top;
  const out = [];
  let skipLevel = 0;
  for (const b of list) {
    const t = textOf(b);
    if ((b.type === 'toggle' || b[b.type]?.is_toggleable) && BRIEF_TOGGLE.test(t)) continue;
    const hl = /^heading_(\d)/.exec(b.type);
    if (hl) {
      const level = Number(hl[1]);
      if (LEGACY_BRIEF_HEADINGS.test(t.trim())) { skipLevel = level; continue; }
      if (skipLevel && level <= skipLevel) skipLevel = 0;
    }
    if (skipLevel) continue;
    if (b.type === 'child_database' || b.type === 'child_page' || b.type === 'file' || b.type === 'pdf' || b.type === 'image' || b.type === 'embed' || b.type === 'bookmark') continue;
    const item = { type: b.type, runs: runsOf(b), checked: b.to_do?.checked, kids: [] };
    if (b.has_children && ['bulleted_list_item', 'numbered_list_item', 'toggle', 'quote', 'callout', 'to_do', 'paragraph'].includes(b.type)) {
      for (const k of await children(b.id)) item.kids.push({ type: k.type, runs: runsOf(k), checked: k.to_do?.checked, kids: [] });
    }
    out.push(item);
  }
  return out;
}

// ---------- rendering ----------
const MAP = { '→': '->', '←': '<-', '✓': 'v', '✔': 'v', '✗': 'x', '❌': 'x', '✅': 'v', '⚠': '!', ' ': ' ', '​': '' };
function clean(font, s) {
  const set = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of String(s)) {
    if (MAP[ch] !== undefined) { out += MAP[ch]; continue; }
    const cp = ch.codePointAt(0);
    if (ch === '\n' || set.has(cp)) out += ch;
  }
  return out;
}

export async function buildScriptPdf({ pageId, brand, creator, title }) {
  const page = await notion('GET', `/pages/${pageId}`);
  const videoTitle = title || titleOf(page);
  const blocks = await scriptBlocks(pageId);
  const hasText = blocks.some((b) => b.runs.some((r) => r.text.trim()) || b.kids.length);
  if (!hasText) throw new Error('The video page has no script text yet.');

  const doc = await PDFDocument.create();
  doc.setTitle(`${videoTitle} - Script`);
  doc.setAuthor('NOOCAP Media');
  const F = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    ital: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldital: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const W = 595.28, H = 841.89, M = 56;
  const ink = rgb(0.1, 0.11, 0.13), muted = rgb(0.45, 0.48, 0.52), accent = rgb(0.05, 0.55, 0.5);
  let pg, y, pageNo = 0;

  const newPage = () => {
    pg = doc.addPage([W, H]);
    pageNo++;
    y = H - M;
    pg.drawText(clean(F.bold, 'NOOCAP MEDIA'), { x: M, y: H - 32, size: 8, font: F.bold, color: accent });
    pg.drawText(clean(F.reg, `${brand || ''}${brand && creator ? ' x ' : ''}${creator || ''}`), { x: W - M - F.reg.widthOfTextAtSize(clean(F.reg, `${brand || ''}${brand && creator ? ' x ' : ''}${creator || ''}`), 8), y: H - 32, size: 8, font: F.reg, color: muted });
    pg.drawText(`Page ${pageNo}`, { x: W / 2 - 12, y: 28, size: 8, font: F.reg, color: muted });
  };
  const ensure = (h) => { if (y - h < M) newPage(); };

  const fontFor = (r) => (r.code ? F.mono : r.bold && r.italic ? F.boldital : r.bold ? F.bold : r.italic ? F.ital : F.reg);

  // Lay out rich text runs with wrapping
  function paragraph(runs, { size = 11, x = M, width = W - 2 * M, lead = 1.45, color = ink, forceFont, prefix } = {}) {
    const words = [];
    for (const r of runs) {
      const font = forceFont || fontFor(r);
      const parts = clean(font, r.text).split(/(\s+)/);
      for (const p of parts) if (p) words.push({ t: p, font });
    }
    if (!words.length) { y -= size * 0.6; return; }
    const lineH = size * lead;
    let line = [];
    let lineW = 0;
    let first = true;
    const flush = () => {
      ensure(lineH);
      y -= lineH;
      if (first && prefix) pg.drawText(prefix.t, { x: x - prefix.w, y, size, font: prefix.font || F.reg, color });
      let cx = x;
      for (const w of line) {
        if (!(cx === x && /^\s+$/.test(w.t))) pg.drawText(w.t, { x: cx, y, size, font: w.font, color });
        cx += w.font.widthOfTextAtSize(w.t, size);
      }
      line = []; lineW = 0; first = false;
    };
    for (const w of words) {
      if (w.t.includes('\n')) { flush(); continue; }
      const ww = w.font.widthOfTextAtSize(w.t, size);
      if (lineW + ww > width && line.length && !/^\s+$/.test(w.t)) {
        flush();
        if (/^\s+$/.test(w.t)) continue;
      }
      line.push(w); lineW += ww;
    }
    if (line.length) flush();
  }

  newPage();
  // Title block
  paragraph([{ text: videoTitle, bold: true }], { size: 20, lead: 1.25 });
  y -= 4;
  const dateStr = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
  paragraph([{ text: `Script${brand ? ' for ' + brand : ''}${creator ? ' · ' + creator : ''} · ${dateStr}` }], { size: 10, color: muted });
  y -= 8;
  pg.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: accent });
  y -= 14;

  let num = 0;
  const render = (b, depth = 0) => {
    const x = M + depth * 18;
    const width = W - M - x;
    if (b.type !== 'numbered_list_item') num = 0;
    switch (b.type) {
      case 'heading_1': y -= 8; paragraph(b.runs, { size: 17, x, width, forceFont: F.bold, lead: 1.3 }); y -= 2; break;
      case 'heading_2': y -= 6; paragraph(b.runs, { size: 14.5, x, width, forceFont: F.bold, lead: 1.3 }); y -= 2; break;
      case 'heading_3': y -= 4; paragraph(b.runs, { size: 12.5, x, width, forceFont: F.bold, lead: 1.3 }); break;
      case 'bulleted_list_item': paragraph(b.runs, { x: x + 14, width: width - 14, prefix: { t: '•', w: 11 } }); break;
      case 'numbered_list_item': num++; paragraph(b.runs, { x: x + 16, width: width - 16, prefix: { t: `${num}.`, w: 15 } }); break;
      case 'to_do': paragraph(b.runs, { x: x + 16, width: width - 16, prefix: { t: b.checked ? '[x]' : '[ ]', w: 16 } }); break;
      case 'quote': case 'callout': {
        const top = y;
        paragraph(b.runs, { x: x + 12, width: width - 12, forceFont: F.ital, color: rgb(0.25, 0.27, 0.3) });
        if (top > y) pg.drawLine({ start: { x: x + 3, y: Math.min(top - 3, H - M) }, end: { x: x + 3, y: y - 2 }, thickness: 2, color: accent });
        break;
      }
      case 'code': paragraph(b.runs, { x: x + 8, width: width - 8, forceFont: F.mono, size: 9.5 }); break;
      case 'divider': ensure(14); y -= 8; pg.drawLine({ start: { x, y }, end: { x: W - M, y }, thickness: 0.5, color: muted }); y -= 6; break;
      case 'toggle': paragraph(b.runs, { x, width, forceFont: F.bold }); break;
      default: paragraph(b.runs, { x, width }); y -= 3;
    }
    for (const k of b.kids || []) render(k, depth + 1);
  };
  for (const b of blocks) render(b);

  const bytes = await doc.save();
  const safe = String(videoTitle).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'Script';
  return { filename: `${safe}_Script.pdf`, mimeType: 'application/pdf', data: Buffer.from(bytes).toString('base64'), pages: pageNo };
}
