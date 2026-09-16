#!/usr/bin/env python3
"""jd-relay — localhost bridge to the JDownloader LAN API.

The browser always stamps an `Origin` header onto cross-origin POSTs and
JDownloader's deprecated RemoteAPI (port 3128) rejects every request that
carries one ("Bad Origin", hardcoded anti-webpage protection). This relay
listens on 127.0.0.1:3128, forwards everything to the JD box and strips
Origin/Referer in transit, so the harvest extension can use the LAN API.

Run:  python3 jd-relay.py          (keep the terminal open, same as dsh web)
"""
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "http://10.0.0.2:3128"       # <-- your JDownloader box IP          # JDownloader deprecated RemoteAPI
BIND = ("127.0.0.1", 3128)                   # localhost only — never expose this
STRIP = {"origin", "referer", "connection"}


class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() in STRIP:
                continue
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                payload, status = r.read(), r.status
                ctype = r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            payload, status = e.read(), e.code
            ctype = e.headers.get("Content-Type", "application/json")
        except Exception as e:
            payload, status, ctype = str(e).encode(), 502, "text/plain"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = _proxy

    def log_message(self, *a):  # quiet
        pass


if __name__ == "__main__":
    print(f"jd-relay: {BIND[0]}:{BIND[1]} -> {UPSTREAM} (Origin stripped)")
    ThreadingHTTPServer(BIND, Relay).serve_forever()
