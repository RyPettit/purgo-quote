#!/usr/bin/env python3
"""Run before every commit: stamps file hashes into index.html and sw.js so phones
always load matching CSS/JS and pick up new releases."""
import hashlib, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
h = lambda p: hashlib.sha1((root / p).read_bytes()).hexdigest()[:10]
css, js, ms, pf, pt, ac, ml = h('purgo.css'), h('purgo.js'), h('measure.js'), h('portfolio.js'), h('portal.js'), h('accounts.js'), h('mail.js')
jb = h('jobs.js')
idx = root / 'index.html'
s = idx.read_text()
s = re.sub(r'purgo\.css(\?v=[0-9a-f]+)?', f'purgo.css?v={css}', s)
s = re.sub(r'purgo\.js(\?v=[0-9a-f]+)?', f'purgo.js?v={js}', s)
s = re.sub(r'measure\.js(\?v=[0-9a-f]+)?', f'measure.js?v={ms}', s)
s = re.sub(r'portfolio\.js(\?v=[0-9a-f]+)?', f'portfolio.js?v={pf}', s)
s = re.sub(r'mail\.js(\?v=[0-9a-f]+)?', f'mail.js?v={ml}', s)
s = re.sub(r'accounts\.js(\?v=[0-9a-f]+)?', f'accounts.js?v={ac}', s)
s = re.sub(r'jobs\.js(\?v=[0-9a-f]+)?', f'jobs.js?v={jb}', s)
s = re.sub(r'portal\.js(\?v=[0-9a-f]+)?', f'portal.js?v={pt}', s)
idx.write_text(s)
version = hashlib.sha1((css + js + ms + pf + pt + ac + ml + jb + h('index.html') + h('config.js')).encode()).hexdigest()[:10]
tpl = (root / 'tools/sw.template.js').read_text()
(root / 'sw.js').write_text(tpl.replace('__VERSION__', version).replace('__CSS__', css).replace('__JS__', js).replace('__MS__', ms).replace('__PF__', pf).replace('__PT__', pt).replace('__AC__', ac).replace('__ML__', ml).replace('__JB__', jb))
print('css', css, 'js', js, 'sw', version)
