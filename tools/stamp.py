#!/usr/bin/env python3
"""Run before every commit: stamps file hashes into index.html and sw.js so phones
always load matching CSS/JS and pick up new releases."""
import hashlib, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
h = lambda p: hashlib.sha1((root / p).read_bytes()).hexdigest()[:10]
css, js = h('purgo.css'), h('purgo.js')
idx = root / 'index.html'
s = idx.read_text()
s = re.sub(r'purgo\.css(\?v=[0-9a-f]+)?', f'purgo.css?v={css}', s)
s = re.sub(r'purgo\.js(\?v=[0-9a-f]+)?', f'purgo.js?v={js}', s)
idx.write_text(s)
version = hashlib.sha1((css + js + h('index.html') + h('config.js')).encode()).hexdigest()[:10]
tpl = (root / 'tools/sw.template.js').read_text()
(root / 'sw.js').write_text(tpl.replace('__VERSION__', version).replace('__CSS__', css).replace('__JS__', js))
print('css', css, 'js', js, 'sw', version)
