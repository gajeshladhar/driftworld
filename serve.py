"""Driftworld dev server.

ES modules need HTTP (file:// blocks them). Also accepts POST /upload so the
page can hand a recorded video back to disk without going through the browser's
download machinery, which is awkward to drive headlessly.
"""
import http.server
import socketserver
import os
import sys
import webbrowser
from urllib.parse import urlparse, parse_qs, unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
ROOT = os.path.dirname(os.path.abspath(__file__))
CAPTURE = os.path.join(ROOT, 'capture')
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != '/upload':
            self.send_error(404)
            return
        name = parse_qs(parsed.query).get('name', ['capture.webm'])[0]
        name = os.path.basename(unquote(name)) or 'capture.webm'
        length = int(self.headers.get('Content-Length', 0))

        os.makedirs(CAPTURE, exist_ok=True)
        dest = os.path.join(CAPTURE, name)
        remaining = length
        with open(dest, 'wb') as fh:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)

        sys.stderr.write('saved %s (%d bytes)\n' % (dest, length - max(0, remaining)))
        sys.stderr.flush()
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as srv:
    url = 'http://127.0.0.1:%d/' % PORT
    print('Driftworld running at %s  (Ctrl+C to stop)' % url)
    print('captures -> %s' % CAPTURE)
    if '--no-open' not in sys.argv:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    srv.serve_forever()
