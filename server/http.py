"""Loopback JSON-RPC bridge with isolated browser sessions."""

import json
import mimetypes
import secrets
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .protocol import LanguageServer
from .stdio import MAX_MESSAGE_BYTES, parse_error


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class NavigationHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=8765, www=None):
        self.www = Path(www).resolve() if www is not None else None
        if self.www is not None and not self.www.is_dir():
            raise ValueError("--www must name an existing directory")
        self.sessions = {}
        self.sessions_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), Handler)

    def new_session(self):
        with self.sessions_lock:
            now = time.monotonic()
            self.sessions = {key: value for key, value in self.sessions.items() if now - value[2] < 3600}
            if len(self.sessions) >= 32:
                return None
            token = secrets.token_urlsafe(32)
            self.sessions[token] = [LanguageServer(), threading.Lock(), now]
            return token

    def get_session(self, token):
        with self.sessions_lock:
            session = self.sessions.get(token)
            if session is not None:
                session[2] = time.monotonic()
            return session


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "allowed_origin", None):
            self.send_header("Access-Control-Allow-Origin", self.allowed_origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def respond(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def allowed(self):
        self.allowed_origin = None
        try:
            host = urlsplit("//" + self.headers.get("Host", ""))
            if host.hostname not in LOCAL_HOSTS or host.port != self.server.server_port or host.username:
                raise ValueError()
            origin = self.headers.get("Origin")
            if origin:
                parsed = urlsplit(origin)
                if parsed.scheme not in {"http", "https"} or parsed.hostname not in LOCAL_HOSTS or parsed.username or parsed.path or parsed.query or parsed.fragment:
                    raise ValueError()
                self.allowed_origin = origin
        except ValueError:
            self.respond(403, {"error": "only loopback hosts and local browser origins are allowed"})
            return False
        return True

    def do_OPTIONS(self):
        if not self.allowed():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Tylr-Session")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.allowed():
            return
        if self.server.www is None:
            self.respond(404, {"error": "no static directory configured; use --www"})
            return
        try:
            path = unquote(urlsplit(self.path).path)
            target = (self.server.www / path.lstrip("/")).resolve()
            if target.is_dir():
                target = (target / "index.html").resolve()
            target.relative_to(self.server.www)
            with target.open("rb") as source:
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
                self.send_header("Content-Length", str(target.stat().st_size))
                self.end_headers()
                shutil.copyfileobj(source, self.wfile)
        except (ValueError, OSError):
            self.respond(404, {"error": "not found"})

    def do_POST(self):
        if not self.allowed():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 <= length <= MAX_MESSAGE_BYTES:
            self.respond(413, {"error": "invalid or oversized request body"})
            return
        body = self.rfile.read(length)
        path = urlsplit(self.path).path
        if path == "/session":
            token = self.server.new_session()
            self.respond(200, {"sessionId": token}) if token else self.respond(503, {"error": "session limit reached"})
            return
        if path != "/rpc":
            self.respond(404, {"error": "not found"})
            return
        token = self.headers.get("X-Tylr-Session")
        session = self.server.get_session(token)
        if session is None:
            self.respond(404, {"error": "unknown session; create a session at /session"})
            return
        try:
            message = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeError):
            self.respond(200, parse_error())
            return
        with session[1]:
            response = session[0].dispatch(message)
            if session[0].exited:
                with self.server.sessions_lock:
                    self.server.sessions.pop(token, None)
        self.respond(204 if response is None else 200, response)
