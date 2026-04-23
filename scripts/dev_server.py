"""Local dev server: serves site/ statically AND proxies /v/{id} to Drive,
mirroring the production Cloudflare Pages Function so the frontend works
unchanged between dev and prod.

Run:
    python3 pipeline/scripts/dev_server.py --root site --port 8787
"""
from __future__ import annotations

import argparse
import http.server
import re
import socketserver
import urllib.request
from pathlib import Path

DRIVE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,80}$")
DRIVE_URL = "https://drive.usercontent.google.com/download?id={id}&export=download"
STRIP_HEADERS = {
    "cross-origin-resource-policy",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "content-security-policy",
    "x-content-security-policy",
    "transfer-encoding",  # we stream chunked ourselves via WSGI
    "content-encoding",
    "connection",
    "keep-alive",
}


def make_handler(root: Path):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(root), **kw)

        # only log warnings/errors
        def log_message(self, fmt, *args):
            pass

        def do_GET(self):
            if self.path.startswith("/v/"):
                return self._proxy_drive(self.path[3:])
            return super().do_GET()

        def do_HEAD(self):
            if self.path.startswith("/v/"):
                return self._proxy_drive(self.path[3:], head_only=True)
            return super().do_HEAD()

        def _proxy_drive(self, id_: str, head_only: bool = False):
            id_ = id_.split("?", 1)[0].strip("/")
            if not DRIVE_ID_RE.match(id_):
                self.send_error(400, "bad id")
                return

            req = urllib.request.Request(DRIVE_URL.format(id=id_), method="HEAD" if head_only else "GET")
            # Forward Range header to enable seeking
            range_hdr = self.headers.get("Range")
            if range_hdr:
                req.add_header("Range", range_hdr)

            try:
                resp = urllib.request.urlopen(req, timeout=30)
            except urllib.error.HTTPError as e:
                self.send_error(e.code, e.reason)
                return
            except Exception as e:
                self.send_error(502, f"upstream error: {e}")
                return

            self.send_response(resp.status)
            for k, v in resp.headers.items():
                if k.lower() in STRIP_HEADERS:
                    continue
                self.send_header(k, v)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
            self.send_header("Cache-Control", "public, max-age=300")
            self.end_headers()

            if head_only:
                return
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break

    return Handler


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path("site"))
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    with ThreadedServer(("", args.port), make_handler(args.root.resolve())) as httpd:
        print(f"dev server: http://localhost:{args.port}/  (proxying /v/*)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
