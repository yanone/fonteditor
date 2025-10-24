#!/usr/bin/env python3
"""
HTTP server with CORS headers required for SharedArrayBuffer (WASM threading)
Based on Simon Cozens' approach in fontc-web
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
import sys


class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # These headers are required for SharedArrayBuffer to work
        # which is needed for WASM threading with wasm-bindgen-rayon
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        # Also allow WASM MIME type
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        SimpleHTTPRequestHandler.end_headers(self)

    def guess_type(self, path):
        mime_type = SimpleHTTPRequestHandler.guess_type(self, path)
        # Ensure .wasm files get the correct MIME type
        if path.endswith(".wasm"):
            return "application/wasm"
        return mime_type


def run(port=8000):
    server_address = ("", port)
    httpd = HTTPServer(server_address, CORSRequestHandler)
    print(f"🚀 Starting server with CORS headers on port {port}")
    print(f"📡 Server URL: http://localhost:{port}")
    print(f"")
    print(f"✅ CORS headers enabled for WASM threading:")
    print(f"   - Cross-Origin-Embedder-Policy: require-corp")
    print(f"   - Cross-Origin-Opener-Policy: same-origin")
    print(f"")
    print(f"Press Ctrl+C to stop the server")
    print(f"")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print(f"\n👋 Server stopped")
        sys.exit(0)


if __name__ == "__main__":
    port = 8000
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    run(port)
