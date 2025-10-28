#!/usr/bin/env python3
"""
Simple CORS proxy for Anthropic API
Run this alongside your main server: python3 anthropic-proxy.py
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import urllib.request
import urllib.error


class ProxyHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        """Handle preflight CORS requests"""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, x-api-key, anthropic-version"
        )
        self.end_headers()

    def do_POST(self):
        """Proxy POST requests to Anthropic API"""
        try:
            # Read request body
            content_length = int(self.headers["Content-Length"])
            body = self.rfile.read(content_length)

            # Get API key from headers
            api_key = self.headers.get("x-api-key")
            anthropic_version = self.headers.get("anthropic-version", "2023-06-01")

            if not api_key:
                self.send_error(401, "API key required")
                return

            # Forward request to Anthropic
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": api_key,
                    "anthropic-version": anthropic_version,
                },
                method="POST",
            )

            # Get response from Anthropic
            with urllib.request.urlopen(req) as response:
                response_data = response.read()

                # Send response back to client
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(response_data)

        except urllib.error.HTTPError as e:
            error_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(error_body)

        except Exception as e:
            self.send_error(500, str(e))


if __name__ == "__main__":
    PORT = 8001
    server = HTTPServer(("localhost", PORT), ProxyHandler)
    print(f"🚀 Anthropic API proxy running on http://localhost:{PORT}")
    print(f"   Use this URL in your app: http://localhost:{PORT}")
    server.serve_forever()
