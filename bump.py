"""Stamp a content hash onto every module URL.

GitHub Pages serves static assets with max-age=600 and no way to override it,
so a deploy can otherwise leave a browser running a mix of old and new modules.
Relative imports do not inherit the entry module's query string, so the version
has to go on every specifier, not just index.html.

Also warns about modules nothing imports. That is not hypothetical: adding
clouds.js while the imports already carried a ?v= stamp made an exact-string
patch miss, and the only symptom was a ReferenceError at runtime.
"""
import hashlib
import pathlib
import re

root = pathlib.Path(__file__).parent
srcs = sorted((root / 'src').glob('*.js'))


def strip(text):
    return re.sub(r"(from\s+'\./[\w.]+\.js)\?v=[0-9a-f]+'", r"\1'", text)


digest = hashlib.sha1()
for f in srcs:
    digest.update(strip(f.read_text(encoding='utf-8')).encode())
ver = digest.hexdigest()[:8]

for f in srcs:
    text = strip(f.read_text(encoding='utf-8'))
    f.write_text(re.sub(r"(from\s+'\./[\w.]+\.js)'", r"\1?v=%s'" % ver, text),
                 encoding='utf-8')

html = root / 'index.html'
h = html.read_text(encoding='utf-8')
html.write_text(re.sub(r'(src="\./src/main\.js)(\?v=[0-9a-f]+)?"', r'\1?v=%s"' % ver, h),
                encoding='utf-8')

joined = '\n'.join(f.read_text(encoding='utf-8') for f in srcs)
orphans = [f.name for f in srcs
           if f.name not in ('main.js', 'config.js')
           and ("from './%s" % f.name) not in joined]
if orphans:
    print('WARNING: these modules are never imported ->', ', '.join(orphans))

print('stamped version', ver)
