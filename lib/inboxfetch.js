// "Get me the Atoms contract from Lindsay's inbox": a row in the Agent Log titled
//   Fetch from inbox: <Creator> | <search text>
// with Outcome = Alert. The heartbeat searches that creator's inbox, uploads the files it finds onto the row (so
// they open from Notion), lists the document links, and sets Outcome = Changed. For inboxes only the PM can read.
import { notion, plain } from './notion.js';
import { DS } from './tools.js';
import { uploadToNotion, discord } from './briefs.js';

const rt = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 1900) } }];
export const parseFetch = (title) => { const m = String(title || '').match(/^Fetch from inbox:\s*([^|]+)\|\s*(.+)$/i); return m ? { creator: m[1].trim(), text: m[2].trim() } : null; };

export async function runInboxFetches() {
  const r = await notion('POST', `/data_sources/${DS.agentLog}/query`, { page_size: 5, filter: { and: [{ property: 'Event', title: { starts_with: 'Fetch from inbox:' } }, { property: 'Outcome', select: { equals: 'Alert' } }] } }).catch(() => ({ results: [] }));
  const done = [];
  for (const row of r.results || []) {
    const ask = parseFetch(plain(row.properties?.Event));
    if (!ask) continue;
    let summary;
    try {
      const { findInMailbox } = await import('./mailbox.js');
      const hits = await findInMailbox(ask.creator, ask.text);
      const blocks = [];
      let files = 0;
      for (const h of hits) {
        blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt(`${h.date.slice(0, 10)} · ${h.from} · ${h.subject}`) } });
        for (const f of h.files.slice(0, 4)) {
          const id = await uploadToNotion(f).catch(() => null);
          if (id) { blocks.push({ object: 'block', type: 'file', file: { type: 'file_upload', file_upload: { id }, name: f.filename.slice(0, 100) } }); files++; }
          else blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(`(couldn't upload ${f.filename})`) } });
        }
        for (const l of h.links) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: l.slice(0, 1900), link: { url: l } } }] } });
      }
      if (blocks.length) await notion('PATCH', `/blocks/${row.id}/children`, { children: blocks.slice(0, 90) });
      summary = `${hits.length} email(s) found, ${files} file(s) attached below, ${hits.reduce((n, h) => n + h.links.length, 0)} document link(s).`;
    } catch (e) { summary = `Couldn't search: ${String(e.message || e).slice(0, 200)}`; }
    await notion('PATCH', `/pages/${row.id}`, { properties: { Outcome: { select: { name: 'Changed' } }, Details: { rich_text: rt(summary) } } }).catch(() => {});
    await discord(`📎 **${ask.creator}'s inbox: "${ask.text}"**\n• ${summary}\n→ [Open](${row.url})`, 'pm').catch(() => {});
    done.push(`${ask.creator}: ${ask.text}`);
  }
  return done;
}
