"""Split brain/sources into small linked notes, the way an Obsidian vault is built.

Every brand, creator, deal, inbound lead, lesson, PM rule and SOP/style section becomes its own note, named with its
date where it has one ("2026-11-08 Dreamina x Chris"), and linked with [[wiki links]] to the brand, creator or page it
belongs to. The notes are written to brain/vault/ (open that folder in Obsidian for its graph view) and returned as a
graph for the team page's map. No AI is involved, and no money: the sources are already money-free.
"""
import re, shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / 'sources'
VAULT = HERE / 'vault'
TYPES = {'brands': 'brand', 'creators': 'creator', 'editing': 'style', 'rules': 'rule', 'lessons': 'lesson', 'pages': 'sop', 'systems': 'system'}
safe = lambda s: re.sub(r'[\\/:*?"<>|#^\[\]]+', ' ', s).strip()[:90] or 'untitled'


def build(write_vault=True):
    notes = {}  # title -> {type, page, body, links}

    def add(title, kind, page, body, links=()):
        title = safe(title)
        n = notes.setdefault(title, {'type': kind, 'page': page, 'body': '', 'links': set()})
        n['body'] += body.strip() + '\n'
        n['links'].update(safe(l) for l in links if l)
        n['links'].update(safe(l) for l in re.findall(r'\[\[([^\]]+)\]\]', body))
        return title

    for f in sorted(SRC.rglob('*.md')):
        rel = str(f.relative_to(SRC))
        top = rel.split('/')[0]
        if top not in TYPES:
            continue
        md = f.read_text()
        title = (re.search(r'^# (.+)$', md, re.M) or [None, f.stem])[1]
        parts = re.split(r'\n(?=## )', md)
        head = parts[0]
        kind = TYPES[top]
        if top == 'brands':
            parent = add(title, 'brand', rel, head)
            for sec in parts[1:]:
                h = sec.split('\n', 1)[0][3:]
                m = re.match(r'Deal with \[\[(.+?)\]\] \((.*?), opened (\d{4}-\d\d-\d\d)\)', h)
                if m:
                    add(f'{m[3]} {title} x {m[1]}', 'deal', rel, f'Stage: {m[2]}\n' + sec.split('\n', 1)[-1], [title, m[1]])
                elif h.startswith('Inbound leads'):
                    for line in re.findall(r'^- (.+)$', sec, re.M):
                        cr = (re.search(r'Creator: ([^·]+)', line) or [None, ''])[1].strip()
                        dt = (re.search(r'Last Brand Email: (\d{4}-\d\d-\d\d)', line) or [None, ''])[1]
                        add(f'{dt} {title} lead {cr}'.strip(), 'lead', rel, line.replace(' · ', '\n'), [title, cr])
                else:
                    notes[parent]['body'] += sec + '\n'
                    notes[parent]['links'].update(safe(l) for l in re.findall(r'\[\[([^\]]+)\]\]', sec))
        elif top == 'rules':
            parent = add(title, 'hub', rel, head)
            for line in re.findall(r'^- \((.+?), (\d{4}-\d\d-\d\d)\) (.+)$', md, re.M):
                cat, dt, text = line
                words = ' '.join(text.split()[:7])
                add(f'{dt} {cat}: {words}', 'rule', rel, text, [parent] + [c for c in ('Chris', 'Lindsay', 'Duncan', 'Valeri', 'Brad', 'Emtech', 'Nicole', 'Harsh', 'Pratham', 'Rudraksh') if c in text])
        else:
            hub_kind = 'creator' if top == 'creators' else 'hub'
            parent = add(title, hub_kind, rel, head)
            for sec in parts[1:]:
                h = sec.split('\n', 1)[0][3:].strip()
                if len(h) < 3:
                    continue
                add(h if top == 'lessons' else f'{title} - {h}', kind, rel, sec.split('\n', 1)[-1], [parent])

    # creators mentioned anywhere get a note, so links land on one node
    for n in list(notes.values()):
        for l in n['links']:
            if l not in notes:
                notes[l] = {'type': 'creator' if l in ('Chris', 'Lindsay', 'Duncan', 'Valeri', 'Brad', 'Emtech', 'Nicole', 'Dmytro', 'David Iya', 'AI Learns') else 'tag', 'page': '', 'body': '', 'links': set()}

    if write_vault:
        if VAULT.exists():
            shutil.rmtree(VAULT)
        for kind in set(n['type'] for n in notes.values()):
            (VAULT / kind).mkdir(parents=True, exist_ok=True)
        for t, n in notes.items():
            links = ''.join(f'\n- [[{l}]]' for l in sorted(n['links']) if l != t)
            (VAULT / n['type'] / f'{t}.md').write_text(f"---\ntype: {n['type']}\n---\n{n['body']}\n{'## Links' + links if links else ''}\n")

    titles = list(notes)
    idx = {t: i for i, t in enumerate(titles)}
    links = sorted({tuple(sorted((idx[t], idx[l]))) for t, n in notes.items() for l in n['links'] if l in idx and l != t})
    return {'nodes': [{'l': t, 't': notes[t]['type'], 'p': notes[t]['page'], 'b': notes[t]['body'][:3000]} for t in titles], 'links': [list(x) for x in links]}


if __name__ == '__main__':
    g = build()
    from collections import Counter
    print(len(g['nodes']), 'notes', len(g['links']), 'links', Counter(n['t'] for n in g['nodes']))
