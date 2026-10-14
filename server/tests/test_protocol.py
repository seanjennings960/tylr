import unittest

from server.protocol import LanguageServer


URI = "file:///sample.py"


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.server = LanguageServer()

    def request(self, method, params=None):
        return self.server.dispatch({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    def notify(self, method, params=None):
        return self.server.dispatch({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def open(self, text="x = 1", version=1):
        self.request("initialize")
        self.notify("initialized")
        self.notify("textDocument/didOpen", {"textDocument": {
            "uri": URI, "version": version, "languageId": "python", "text": text,
        }})

    def structure(self, version=1):
        return self.request("tylr/structure", {"textDocument": {"uri": URI, "version": version}})

    def test_lifecycle_and_capabilities(self):
        self.assertEqual(self.structure()["error"]["code"], -32002)
        capabilities = self.request("initialize")["result"]["capabilities"]
        self.assertEqual(capabilities["positionEncoding"], "utf-16")
        self.assertEqual(capabilities["experimental"]["tylrStructure"]["version"], 1)
        self.notify("initialized")
        self.assertIsNone(self.request("shutdown")["result"])
        self.assertEqual(self.structure()["error"]["code"], -32600)
        self.assertIsNone(self.notify("exit"))
        self.assertEqual(self.server.exit_code, 0)

    def test_full_change_and_stale_structure(self):
        self.open()
        self.notify("textDocument/didChange", {"textDocument": {"uri": URI, "version": 2}, "contentChanges": [{"text": "y = 2\r\n"}]})
        self.assertEqual(self.structure()["error"]["code"], -32801)
        result = self.structure(2)["result"]
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["nodes"][0]["range"]["end"], {"line": 1, "character": 0})
        self.notify("textDocument/didClose", {"textDocument": {"uri": URI}})
        self.assertEqual(self.structure(2)["error"]["code"], -32602)

    def test_malformed_or_reordered_changes_cannot_replace_source(self):
        self.open(version=2)
        for version, changes in [(1, [{"text": "bad"}]), (3, [{"text": "bad", "range": {}}]), (3, [{"text": "ok"}, {"text": None}])]:
            with self.assertLogs(level="WARNING"):
                self.notify("textDocument/didChange", {"textDocument": {"uri": URI, "version": version}, "contentChanges": changes})
            self.assertEqual(self.server.documents[URI], (2, "x = 1"))

    def test_malformed_request_and_params(self):
        self.open()
        for document in [None, {}, {"uri": URI, "version": True}, {"uri": "relative.py", "version": 1}]:
            self.assertEqual(self.request("tylr/structure", {"textDocument": document})["error"]["code"], -32602)
        self.assertEqual(self.server.dispatch([])["error"]["code"], -32600)
        self.assertEqual(self.request("madeUp/method")["error"]["code"], -32601)

    def test_open_document_is_not_read_or_executed(self):
        self.open("raise RuntimeError('must never run')\n")
        self.assertEqual(self.structure()["result"]["status"], "ready")

    def test_shutdown_accepts_null_params(self):
        self.open()
        response = self.server.dispatch({"jsonrpc": "2.0", "id": 5, "method": "shutdown", "params": None})
        self.assertEqual(response, {"jsonrpc": "2.0", "id": 5, "result": None})


if __name__ == "__main__":
    unittest.main()
