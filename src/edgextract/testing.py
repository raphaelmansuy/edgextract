"""In-process HTTP stand-in for POST /v1/systemone. Used by e2e tests."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HandlerFn = Callable[[dict[str, Any]], dict[str, Any]]


def start_fake_systemone(handler: HandlerFn, port: int = 0) -> tuple[str, Callable[[], None]]:
    class H(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._send(400, {"error": "bad json"})
                return
            if self.path != "/v1/systemone":
                self._send(404, {"error": "not found"})
                return
            try:
                out = handler(body)
            except Exception as exc:  # noqa: BLE001
                self._send(500, {"error": str(exc)})
                return
            self._send(200, out)

        def _send(self, code: int, payload: dict[str, Any]) -> None:
            blob = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)

        def log_message(self, fmt: str, *args: Any) -> None:
            del fmt, args

    httpd = ThreadingHTTPServer(("127.0.0.1", port), H)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, p = httpd.server_address

    def stop() -> None:
        httpd.shutdown()
        httpd.server_close()

    return f"http://{host}:{p}", stop
