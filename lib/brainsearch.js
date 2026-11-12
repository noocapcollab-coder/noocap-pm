// Search the second brain (brain/sources markdown + brain/graphify-out/graph.json), bundled with the app.
// Used by the Ask PM tool search_brain, on WhatsApp and in the HQ chat. No AI: keyword scoring over sections,
// plus the graph's neighbours of the matching concepts, so the answer can follow links between brands, creators,
// rules and SOPs. Nothing in the brain carries money (lib/brain.js strips it).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'brain');
let cache = null;
const STOP = new Set('the a an and or of to in on for with is are was were be what who how why when which do does did we our us you about this that it any there have has from at by as can should'.split(' '));
export const terms = (q) => [...new Set(String(q || '').toLowerCase().replace(/[^a-z0-9@.\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];

function walk(dir, out = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

export function loadBrain(root = ROOT) {
  if (cache && cache.root === root) return cache;
  const sections = [];
  for (const file of walk(path.join(root, 'sources'))) {
    const rel = path.relative(path.join(root, 'sources'), file);
    const text = fs.readFileSync(file, 'utf8');
    const title = (text.match(/^# (.+)$/m) || [])[1] || rel;
    const parts = text.split(/\n(?=## )/);
    for (const part of parts) sections.push({ file: rel, title, heading: (part.match(/^## (.+)$/m) || [])[1] || title, text: part.trim(), lc: part.toLowerCase(), titleLc: `${title} ${rel}`.toLowerCase() });
  }
  let graph = { nodes: [], links: [] };
  try { graph = JSON.parse(fs.readFileSync(path.join(root, 'graphify-out', 'graph.json'), 'utf8')); } catch { /* no graph yet */ }
  const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const adj = new Map();
  for (const e of graph.links || graph.edges || []) {
    for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, rel: e.relation || e.label || 'related to' }); }
  }
  cache = { root, sections, nodes, adj };
  return cache;
}

export function searchBrain(query, { max = 6, root } = {}) {
  const b = loadBrain(root);
  const t = terms(query);
  if (!t.length) return { results: [], links: [] };
  // rare words count more (IDF), and a word in the page title (a brand or creator name) counts most
  const N = b.sections.length || 1;
  const idf = Object.fromEntries(t.map((w) => [w, Math.log(1 + N / (1 + b.sections.filter((s) => s.lc.includes(w) || s.titleLc.includes(w)).length))]));
  const scored = b.sections.map((s) => {
    let score = 0;
    for (const w of t) {
      const n = s.lc.split(w).length - 1;
      if (n) score += idf[w] * (1 + Math.min(n, 4) * 0.25);
      if (s.titleLc.includes(w)) score += idf[w] * 6;
    }
    const all = t.every((w) => s.lc.includes(w) || s.titleLc.includes(w));
    return { s, score: score * (all ? 1.2 : 1) };
  }).filter((x) => x.score > 0).sort((a, b2) => b2.score - a.score);
  const results = scored.slice(0, max).map(({ s }) => ({ source: s.file, title: s.title, section: s.heading, text: s.text.slice(0, 1500) }));
  // Graph: concepts whose label matches, and what they connect to
  const links = [];
  for (const [id, n] of b.nodes) {
    const label = String(n.label || id).toLowerCase();
    if (!t.some((w) => w.length > 3 && (N < 50 || idf[w] > 2) && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(label))) continue;
    const near = (b.adj.get(id) || []).slice(0, 8).map((x) => `${x.rel} ${b.nodes.get(x.to)?.label || x.to}`);
    if (near.length) links.push(`${n.label || id}: ${near.join('; ')}`);
    if (links.length >= 8) break;
  }
  return { results, links };
}
