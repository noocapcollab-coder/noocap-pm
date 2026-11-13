// PM · Lessons. The PM's memory of its own mistakes. Every time Harsh corrects it (edits a draft, rejects one with a
// reason, tells it on WhatsApp or in the chat "never do X"), the second reader or the system check catches something,
// or Claude fixes a mistake, the correction is turned into one short lesson in the PM LESSONS database. Before the PM
// reads a brand email, checks a decision or writes an email, it reads the lessons that fit the situation, so a mistake
// made once is not made again. A lesson seen again is not duplicated: its "Times Seen" goes up, which shows which
// mistakes keep coming back.
import { notion, plain, queryAll } from './notion.js';
import { claude, HAIKU } from './claude.js';

export const LESSONS_DS = process.env.LESSONS_DS || '1e7ad6d4-df5d-4c01-84aa-59cb1d2e86d8';
const AREAS = ['Emails', 'Payments', 'Briefs & scripts', 'Video & editors', 'WhatsApp', 'Deals & data', 'Other'];
const SOURCES = ['Harsh correction', 'Draft edit', 'Draft rejected', 'Second reader', 'System check', 'Claude', 'Rulebook'];
const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
const today = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

let cache = { at: 0, rows: [] };
export async function loadLessons({ fresh = false } = {}) {
  if (!fresh && Date.now() - cache.at < 10 * 60e3 && cache.rows.length) return cache.rows;
  const pages = await queryAll(LESSONS_DS, { property: 'Active', checkbox: { equals: true } }, { useCache: false }).catch(() => []);
  const rows = pages.map((p) => {
    const g = (n) => plain(p.properties?.[n]);
    return { id: p.id, lesson: g('Lesson'), when: g('When'), do: g('Do'), never: g('Never'), area: g('Area'), seen: Number(g('Times Seen') || 1), example: g('Example') };
  }).filter((r) => r.lesson);
  cache = { at: Date.now(), rows };
  return rows;
}

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []);
const AREA_HINTS = {
  Payments: /\b(paid|payment|invoice|stripe|receipt|transfer|queue|due|billing|refund)\b/i,
  'Briefs & scripts': /\b(brief|script|approved|validated|hook|draft video|next step)\b/i,
  'Video & editors': /\b(cut|video|edit|frame\.io|f\.io|changes|feedback|revision|ugc)\b/i,
  WhatsApp: /\b(whatsapp)\b/i,
  Emails: /./,
};
// The lessons that fit this situation, most relevant (and most repeated) first
export function relevant(lessons = [], text = '', { max = 12, areas } = {}) {
  const w = words(text);
  const scored = lessons.map((l) => {
    let s = 0;
    for (const t of words(`${l.lesson} ${l.when} ${l.do} ${l.never}`)) if (w.has(t)) s += 1;
    if (AREA_HINTS[l.area]?.test(text)) s += 3;
    if (areas && areas.includes(l.area)) s += 4;
    s += Math.min(l.seen, 5) * 0.5;
    return { l, s };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.l);
}

export function lessonsText(list = []) {
  if (!list.length) return '';
  return `LESSONS FROM PAST MISTAKES (each one happened before; never repeat it):\n${list.map((l) => `- ${l.lesson}${l.when ? ` (when: ${l.when})` : ''}: ${l.do}${l.never ? ` Never: ${l.never}` : ''}`).join('\n')}`;
}

// Lessons for a prompt, never throws (an empty string when the database can't be read)
export async function lessonsFor(text, opts) {
  try { return lessonsText(relevant(await loadLessons(), text, opts)); } catch { return ''; }
}

const LESSON_TOOL = {
  name: 'lesson',
  description: 'Turn a correction into one reusable lesson, or say it repeats an existing one.',
  input_schema: {
    type: 'object',
    properties: {
      worth_keeping: { type: 'boolean', description: 'False if the correction is a one-off fact about one email (a typo fix, a name) that teaches nothing for next time' },
      duplicate_of: { type: ['integer', 'null'], description: 'Number of the existing lesson this is the same as, or null' },
      lesson: { type: 'string', description: 'Short title, under 10 words, of the general rule' },
      when: { type: 'string', description: 'The situation it applies to, in general terms' },
      do: { type: 'string', description: 'What to do, one or two plain sentences' },
      never: { type: 'string', description: 'What must not be done' },
      area: { type: 'string', enum: AREAS },
    },
    required: ['worth_keeping', 'duplicate_of', 'lesson', 'when', 'do', 'never', 'area'],
  },
};

// A correction in plain words -> a lesson (new, or an existing one seen again). Never throws.
export async function learn({ correction, source = 'Harsh correction', example = '' }) {
  try {
    if (!String(correction || '').trim()) return null;
    const have = await loadLessons({ fresh: true });
    const out = await claude({
      _job: 'lessons',
      model: HAIKU,
      max_tokens: 500,
      system: 'You keep the lesson book of an AI project manager at NOOCAP Media (an agency running sponsored-video deals for creators). A person corrected something the AI did. Turn it into a general rule the AI can follow next time in similar situations, not a note about this one email. Plain words, no names unless the rule is about that brand or creator. If an existing lesson already says the same thing, return its number.',
      tools: [LESSON_TOOL],
      tool_choice: { type: 'tool', name: 'lesson' },
      messages: [{ role: 'user', content: `Existing lessons:\n${have.map((l, i) => `${i + 1}. ${l.lesson}: ${l.do}`).join('\n') || '(none)'}\n\nThe correction:\n${String(correction).slice(0, 3000)}${example ? `\n\nWhere it happened: ${String(example).slice(0, 600)}` : ''}` }],
    });
    const v = (out.content || []).find((c) => c.type === 'tool_use')?.input;
    if (!v || v.worth_keeping === false) return { skipped: true };
    const dup = Number.isInteger(v.duplicate_of) ? have[v.duplicate_of - 1] : null;
    const src = SOURCES.includes(source) ? source : 'Harsh correction';
    if (dup) {
      const ex = [dup.example, example].filter(Boolean).join(' | ').slice(-1800);
      await notion('PATCH', `/pages/${dup.id}`, { properties: { 'Times Seen': { number: dup.seen + 1 }, 'Last Seen': { date: { start: today() } }, Example: { rich_text: rt(ex) } } });
      cache.at = 0;
      return { repeated: dup.lesson, times: dup.seen + 1, lesson: { id: dup.id, lesson: dup.lesson, do: dup.do, never: dup.never } };
    }
    const made = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: LESSONS_DS }, properties: {
      Lesson: { title: rt(v.lesson) }, When: { rich_text: rt(v.when) }, Do: { rich_text: rt(v.do) }, Never: { rich_text: rt(v.never) },
      Area: { select: { name: AREAS.includes(v.area) ? v.area : 'Other' } }, Source: { select: { name: src } }, Example: { rich_text: rt(example) },
      'Times Seen': { number: 1 }, 'Last Seen': { date: { start: today() } }, Active: { checkbox: true },
    } });
    cache.at = 0;
    return { added: v.lesson, lesson: { id: made?.id, lesson: v.lesson, do: v.do, never: v.never } };
  } catch (e) { console.error('learn', e.message); return null; }
}

// Did a person change a draft enough that there is something to learn? (more than a word or two)
export function changedEnough(before = '', after = '') {
  const norm = (s) => String(s).replace(/<br\s*\/?>/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(before), b = norm(after);
  if (!a || !b || a === b) return false;
  const wa = a.split(' '), wb = new Set(b.split(' '));
  const lost = wa.filter((w) => !wb.has(w)).length;
  return lost >= 3 || Math.abs(a.length - b.length) > 40;
}
