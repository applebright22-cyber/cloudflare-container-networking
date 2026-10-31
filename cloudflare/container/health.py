from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import socket

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/health", "/"):
            body = json.dumps({
                "status": "ok",
                "service": "mysterium-container",
                "node_id": os.environ.get("NODE_ID"),
                "hostname": socket.gethostname(),
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *_args):
        return

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
