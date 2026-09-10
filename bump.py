"""Stamp a content hash onto every module URL.

GitHub Pages serves static assets with max-age=600 and no way to override it,
so a deploy can leave browsers running a mix of old and new modules for ten
minutes. Relative imports do not inherit the importing module's query string,
so the version has to be written onto every specifier, not just the entry.
"""
import hashlib, pathlib, re

root = pathlib.Path(__file__).parent
srcs = sorted((root / 'src').glob('*.js'))

def strip(t):
    return re.sub(r"(from\s+'\./[\w.]+\.js)\?v=[0-9a-f]+'", r"\1'", t)

digest = hashlib.sha1()
for f in srcs:
    digest.update(strip(f.read_text(encoding='utf-8')).encode())
ver = digest.hexdigest()[:8]

for f in srcs:
    t = strip(f.read_text(encoding='utf-8'))
    t = re.sub(r"(from\s+'\./[\w.]+\.js)'", r"\1?v=%s'" % ver, t)
    f.write_text(t, encoding='utf-8')

html = root / 'index.html'
h = html.read_text(encoding='utf-8')
h = re.sub(r'(src="\./src/main\.js)(\?v=[0-9a-f]+)?"', r'\1?v=%s"' % ver, h)
html.write_text(h, encoding='utf-8')
print('stamped version', ver)
