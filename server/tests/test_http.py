import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from server.http import NavigationHTTPServer


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = tempfile.TemporaryDirectory()
        root = Path(cls.files.name) / "www"
        root.mkdir()
        (root / "index.html").write_text("<h1>editor</h1>")
        (Path(cls.files.name) / "outside.txt").write_text("outside static root")
        (root / "escape.txt").symlink_to(Path(cls.files.name) / "outside.txt")
        cls.server = NavigationHTTPServer(0, root)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.files.cleanup()

    def post(self, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request("POST", path, json.dumps(body or {}), headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = response.status, json.loads(payload) if payload else None, dict(response.getheaders())
        connection.close()
        return result

    def test_real_session_has_isolated_versioned_documents(self):
        session = self.post("/session")[1]["sessionId"]
        other = self.post("/session")[1]["sessionId"]
        for token in [session, other]:
            headers = {"X-Tylr-Session": token}
            self.assertEqual(self.post("/rpc", {"jsonrpc": "2.0", "id": 1, "method": "initialize"}, headers)[0], 200)
            self.assertEqual(self.post("/rpc", {"jsonrpc": "2.0", "method": "initialized"}, headers)[0], 204)
        self.post("/rpc", {"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {"textDocument": {
            "uri": "file:///sample.py", "version": 1, "languageId": "python", "text": "x = 1",
        }}}, {"X-Tylr-Session": session})
        request = {"jsonrpc": "2.0", "id": 2, "method": "tylr/structure", "params": {"textDocument": {"uri": "file:///sample.py", "version": 1}}}
        self.assertEqual(self.post("/rpc", request, {"X-Tylr-Session": session})[1]["result"]["status"], "ready")
        self.assertEqual(self.post("/rpc", request, {"X-Tylr-Session": other})[1]["error"]["code"], -32602)

    def test_origin_host_and_session_guards(self):
        self.assertEqual(self.post("/session", headers={"Origin": "https://example.org"})[0], 403)
        self.assertEqual(self.post("/session", headers={"Host": "example.org"})[0], 403)
        self.assertEqual(self.post("/rpc")[0], 404)
        origin = "http://localhost:8000"
        self.assertEqual(self.post("/session", headers={"Origin": origin})[2]["Access-Control-Allow-Origin"], origin)

    def test_static_files_stay_inside_explicit_root(self):
        for path, expected_status in [("/", 200), ("/../outside.txt", 404), ("/%2e%2e/outside.txt", 404), ("/escape.txt", 404)]:
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
            connection.request("GET", path)
            response = connection.getresponse()
            self.assertEqual(response.status, expected_status)
            if expected_status == 200:
                self.assertEqual(response.read(), b"<h1>editor</h1>")
            connection.close()


if __name__ == "__main__":
    unittest.main()
