#!/usr/bin/env python3
"""Run before every commit: stamps file hashes into index.html and sw.js so phones
always load matching CSS/JS and pick up new releases."""
import hashlib, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
h = lambda p: hashlib.sha1((root / p).read_bytes()).hexdigest()[:10]
css, js, ms = h('purgo.css'), h('purgo.js'), h('measure.js')
idx = root / 'index.html'
s = idx.read_text()
s = re.sub(r'purgo\.css(\?v=[0-9a-f]+)?', f'purgo.css?v={css}', s)
s = re.sub(r'purgo\.js(\?v=[0-9a-f]+)?', f'purgo.js?v={js}', s)
s = re.sub(r'measure\.js(\?v=[0-9a-f]+)?', f'measure.js?v={ms}', s)
idx.write_text(s)
version = hashlib.sha1((css + js + ms + h('index.html') + h('config.js')).encode()).hexdigest()[:10]
tpl = (root / 'tools/sw.template.js').read_text()
(root / 'sw.js').write_text(tpl.replace('__VERSION__', version).replace('__CSS__', css).replace('__JS__', js).replace('__MS__', ms))
print('css', css, 'js', js, 'sw', version)
