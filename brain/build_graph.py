"""Rebuild the NOOCAP brain graph from brain/sources with Graphify.

Run from noocap-pm/brain:  GEMINI_API_KEY=... python3 build_graph.py
- Only new or changed files are sent to Gemini (Graphify's cache), on a model the PM's fallback does not use first.
- [[links]] in the sources (brand -> creator, page -> sub-page) become EXTRACTED edges.
- Concepts with the same name are merged, creators/brands/pages keep their own node.
- Writes graphify-out/graph.json, GRAPH_REPORT.md, graph.html and the manifest.
"""
import json, re, subprocess, sys
from pathlib import Path

from graphify.detect import detect, save_manifest
from graphify.cache import check_semantic_cache, save_semantic_cache
from graphify.llm import extract_corpus_parallel
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json
from graphify.cli import _stamped_manifest_files

HERE = Path(__file__).resolve().parent
ROOT = HERE / 'sources'
OUT = HERE / 'graphify-out'
SPEC = str(Path.home() / '.claude/skills/graphify/references/extraction-spec.md')
OUT.mkdir(exist_ok=True)
(OUT / '.graphify_root').write_text(str(ROOT))
slug = lambda s: re.sub(r'[^a-z0-9]+', '', str(s).lower())

det = detect(ROOT)
docs = det['files'].get('document', [])
print(f'{len(docs)} source files')

# 1. Semantic extraction, only for files Graphify has not seen in this version
for attempt in range(3):
    nodes, edges, hyper, unc = check_semantic_cache(docs, root=str(ROOT), prompt_file=SPEC)
    if not unc:
        break
    print(f'extracting {len(unc)} new/changed files (attempt {attempt + 1})', flush=True)
    res = extract_corpus_parallel([Path(f) for f in unc], backend='gemini', root=ROOT, token_budget=15000 if attempt else 40000, max_concurrency=3)
    save_semantic_cache(res['nodes'], res['edges'], res.get('hyperedges', []), root=str(ROOT), allowed_source_files=unc, prompt_file=SPEC)
nodes, edges, hyper, unc = check_semantic_cache(docs, root=str(ROOT), prompt_file=SPEC)
if unc:
    print(f'WARNING: {len(unc)} files still not extracted: {", ".join(Path(u).name for u in unc[:10])}')

# 2. One node per source file, and [[links]] as edges
byfile = {}
for n in nodes:
    byfile.setdefault(n.get('source_file'), []).append(n)
primary, title_file = {}, {}
for f in ROOT.rglob('*.md'):
    rel = str(f.relative_to(ROOT))
    title = (re.search(r'^# (.+)$', f.read_text(), re.M) or [None, f.stem])[1]
    title_file[slug(title)] = rel
    stem = slug(f.stem)
    cands = byfile.get(rel, [])
    pick = next((n for n in cands if stem and stem in slug(n['id'])), None) or (cands[0] if cands else None)
    if not pick:
        pick = {'id': rel.replace('/', '_').removesuffix('.md'), 'label': title, 'file_type': 'document', 'source_file': rel}
        nodes.append(pick)
    pick['label'] = title if rel.split('/')[0] in ('brands', 'creators', 'pages') else pick.get('label', title)
    primary[rel] = pick['id']
have = {(e['source'], e['target']) for e in edges}
for f in ROOT.rglob('*.md'):
    rel = str(f.relative_to(ROOT))
    for link in set(re.findall(r'\[\[([^\]]+)\]\]', f.read_text())):
        tf = title_file.get(slug(link))
        if not tf or primary[tf] == primary[rel] or (primary[rel], primary[tf]) in have:
            continue
        edges.append({'source': primary[rel], 'target': primary[tf], 'relation': 'works with' if rel.startswith('brands') else 'links to',
                      'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': rel})
        have.add((primary[rel], primary[tf]))

# 3. Merge concepts with the same name; file nodes (creators first) win
file_ids = set(primary.values())
rank = lambda n: (0 if n['id'] in file_ids and n.get('source_file', '').startswith('creators') else 1 if n['id'] in file_ids else 2)
canon, keep, remap = {}, [], {}
for n in sorted(nodes, key=rank):
    n.setdefault('_origin', 'semantic')
    k = slug(n.get('label') or n['id'])
    if k in canon:
        remap[n['id']] = canon[k]
    else:
        canon[k] = n['id']; keep.append(n)
seen, out_edges = set(), []
for e in edges:
    e.setdefault('_origin', 'semantic')
    s, t = remap.get(e['source'], e['source']), remap.get(e['target'], e['target'])
    if s == t or (s, t, e.get('relation')) in seen:
        continue
    seen.add((s, t, e.get('relation'))); e['source'], e['target'] = s, t; out_edges.append(e)
for h in hyper:
    if 'nodes' in h:
        h['nodes'] = list(dict.fromkeys(remap.get(i, i) for i in h['nodes']))
extraction = {'nodes': keep, 'edges': out_edges, 'hyperedges': hyper, 'input_tokens': 0, 'output_tokens': 0}

# 4. Build, cluster, name communities, export
G = build_from_json(extraction, root=str(ROOT), directed=False)
communities = cluster(G)
cohesion = score_all(G, communities)
CREATORS = {'chris', 'lindsay', 'duncan', 'valeri', 'brad', 'emtech', 'nicole', 'dmytro', 'davidiya', 'ailearns'}
labels = {}
for c, members in communities.items():
    top = sorted(members, key=lambda x: -G.degree(x))
    names = [G.nodes[x].get('label', x) for x in top[:3]]
    lead = names[0] if names else 'Other'
    labels[c] = f'{lead} brand deals' if slug(lead) in CREATORS and len(members) > 8 else ' / '.join(names[:2])
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
questions = suggest_questions(G, communities, labels)
if not to_json(G, communities, str(OUT / 'graph.json'), force=True, community_labels=labels):
    sys.exit('graph.json not written')
(OUT / 'GRAPH_REPORT.md').write_text(generate(G, communities, cohesion, labels, gods, surprises, det, {'input': 0, 'output': 0}, str(ROOT), suggested_questions=questions))
(OUT / '.graphify_labels.json').write_text(json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False))
subprocess.run(['graphify', 'export', 'html'], cwd=HERE, check=False)
save_manifest(_stamped_manifest_files(det['files'], extraction, ROOT), root=str(ROOT), scan_corpus={f for fl in det['files'].values() for f in fl})
for f in OUT.glob('.graphify_*'):
    if f.name not in ('.graphify_root', '.graphify_labels.json', '.graphify_python'):
        f.unlink()
for f in OUT.glob('.sem_run*.json'):
    f.unlink()
print(f'graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} groups')

# 5. Data for the team page (site/index.html), published as the "NOOCAP Brain" artifact
from datetime import date
GROUPS = {'brands': 'Brands', 'creators': 'Creators', 'editing': 'Editing style', 'rules': 'Rules', 'lessons': 'Lessons', 'pages': 'SOPs & Notion pages', 'systems': 'Automations'}
pages = []
for f in sorted(ROOT.rglob('*.md')):
    rel = str(f.relative_to(ROOT)); grp = rel.split('/')[0]
    if grp not in GROUPS:
        continue
    md = f.read_text()
    pages.append({'p': rel, 'g': GROUPS[grp], 't': (re.search(r'^# (.+)$', md, re.M) or [None, f.stem])[1], 'md': md})
g = json.loads((OUT / 'graph.json').read_text())
ids = {n['id']: i for i, n in enumerate(g['nodes'])}
site = {'built': str(date.today()), 'pages': pages,
        'nodes': [{'l': n.get('label', n['id']), 'c': n.get('community', -1), 'f': n.get('source_file', '')} for n in g['nodes']],
        'links': [[ids[e['source']], ids[e['target']], e.get('relation', '')] for e in g['links'] if e['source'] in ids and e['target'] in ids],
        'groups': {str(k): v for k, v in labels.items()}}
(HERE / 'site').mkdir(exist_ok=True)
(HERE / 'site' / 'brain-data.json').write_text(json.dumps(site, ensure_ascii=False, separators=(',', ':')))
print(f'team page data: {len(pages)} pages')
