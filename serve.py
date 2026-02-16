#!/usr/bin/env python3
"""Simple HTTP server for WebXR viewer with required headers.

WebXR requires HTTPS on non-localhost origins. This server supports:
- CORS headers (Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy)
- Optional HTTPS with self-signed cert for Quest standalone access

Usage:
    python serve.py                          # HTTP on port 8080
    python serve.py --port 3000              # Custom port
    python serve.py --https                  # HTTPS (needs cert.pem + key.pem)
    python serve.py --data /path/to/dir/     # Symlink exported data

Generate self-signed cert for HTTPS:
    openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
"""

import argparse
import http.server
import os
import ssl
from functools import partial
from pathlib import Path


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with CORS and SharedArrayBuffer headers."""

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    # Suppress request logging noise
    def log_message(self, format, *args):
        if '200' not in str(args):
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description="WebXR viewer HTTP server")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--bind", type=str, default="0.0.0.0")
    parser.add_argument(
        "--data", type=str, default=None,
        help="Path to directory containing scene.ply + scene.4d.bin"
    )
    parser.add_argument(
        "--https", action="store_true",
        help="Enable HTTPS (requires cert.pem + key.pem in webxr/ dir)"
    )
    args = parser.parse_args()

    webxr_dir = Path(__file__).parent.resolve()

    # Symlink data files if provided
    if args.data:
        data_dir = webxr_dir / "data"
        data_dir.mkdir(exist_ok=True)
        src_dir = Path(args.data).resolve()

        for name in ["scene.ply", "scene.4d.bin"]:
            src = src_dir / name
            dst = data_dir / name
            if src.exists():
                if dst.exists() or dst.is_symlink():
                    dst.unlink()
                dst.symlink_to(src)
                print(f"  Linked: {src} -> {dst}")
            else:
                print(f"  Warning: {src} not found")

    # Determine if we should serve from the dist/ (built) or root (dev)
    serve_dir = webxr_dir / "dist"
    if not serve_dir.exists():
        serve_dir = webxr_dir

    handler = partial(CORSHandler, directory=str(serve_dir))
    server = http.server.HTTPServer((args.bind, args.port), handler)

    proto = "http"
    if args.https:
        cert_path = webxr_dir / "cert.pem"
        key_path = webxr_dir / "key.pem"
        if cert_path.exists() and key_path.exists():
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(cert_path), str(key_path))
            server.socket = context.wrap_socket(server.socket, server_side=True)
            proto = "https"
        else:
            print("WARNING: --https requested but cert.pem/key.pem not found.")
            print("Generate with:")
            print('  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"')
            print("Falling back to HTTP.\n")

    print(f"FreeSplat4D WebXR Viewer")
    print(f"  Serving: {serve_dir}")
    print(f"  URL:     {proto}://localhost:{args.port}/")
    print(f"  VR URL:  {proto}://<your-ip>:{args.port}/")
    if proto == "http":
        print(f"  Note: WebXR requires HTTPS on non-localhost. Use --https for VR headsets.")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
