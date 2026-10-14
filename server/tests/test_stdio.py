import io
import json
import unittest

from server.stdio import read_frame, serve_stdio, write_frame


class StdioTests(unittest.TestCase):
    def test_real_framed_session_with_unicode_document(self):
        incoming, outgoing = io.BytesIO(), io.BytesIO()
        messages = [
            {"id": 1, "method": "initialize"},
            {"method": "initialized"},
            {"method": "textDocument/didOpen", "params": {"textDocument": {
                "uri": "file:///sample.py", "version": 1, "languageId": "python", "text": 's = "🧭"',
            }}},
            {"id": 2, "method": "tylr/structure", "params": {"textDocument": {"uri": "file:///sample.py", "version": 1}}},
            {"id": 3, "method": "shutdown"},
            {"method": "exit"},
        ]
        for message in messages:
            write_frame(incoming, {"jsonrpc": "2.0", **message})
        incoming.seek(0)
        self.assertEqual(serve_stdio(incoming, outgoing), 0)
        outgoing.seek(0)
        responses = []
        while (body := read_frame(outgoing)) is not None:
            responses.append(json.loads(body))
        self.assertEqual([response["id"] for response in responses], [1, 2, 3])
        self.assertEqual(responses[1]["result"]["status"], "ready")
        self.assertEqual(responses[1]["result"]["nodes"][0]["range"]["end"]["character"], 8)

    def test_invalid_framing_and_json(self):
        for data in [b"Content-Length: 5\r\n\r\nx", b"Content-Length: -1\r\n\r\n", b"Content-Length: 1\r\nContent-Length: 2\r\n\r\n{}"]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                read_frame(io.BytesIO(data))
        outgoing = io.BytesIO()
        serve_stdio(io.BytesIO(b"Content-Length: 1\r\n\r\n{"), outgoing)
        outgoing.seek(0)
        self.assertEqual(json.loads(read_frame(outgoing))["error"]["code"], -32700)


if __name__ == "__main__":
    unittest.main()
