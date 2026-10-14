"""Exercise draft transactions through the actual JSON-RPC dispatcher."""

from __future__ import annotations

from copy import deepcopy
from typing import Any
import unittest
from unittest.mock import patch

from server.protocol import LanguageServer


URI = "file:///expression.py"


class EditProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LanguageServer()
        self.request_number = 0
        self.request("initialize")
        self.notify("initialized")
        self.source = "2 + 3 * 4\r\n"
        self.notify("textDocument/didOpen", {"textDocument": {
            "uri": URI, "version": 1, "languageId": "python", "text": self.source,
        }})

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.request_number += 1
        if method == "tylr/edit/start":
            params = {"requestId": f"start-{self.request_number}", **(params or {})}
        return self.server.dispatch({"jsonrpc": "2.0", "id": 1,
                                     "method": method, "params": params or {}})

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.server.dispatch({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def start(self) -> dict[str, Any]:
        response = self.request("tylr/edit/start", {"textDocument": {"uri": URI, "version": 1}})
        self.assertNotIn("error", response)
        return response["result"]

    def target(self, state: dict[str, Any], action: str, selected: str | None = None) -> str:
        nodes = {node["id"]: node for node in state["structure"]["nodes"]}
        for target in state["targets"]:
            node = nodes[target["nodeId"]]
            text = state["text"][node["range"]["start"]["character"]:node["range"]["end"]["character"]]
            if any(item["id"] == action for item in target["actions"]) and (selected is None or text == selected):
                return target["nodeId"]
        self.fail(f"No target for {action}, {selected!r}: {state}")

    def apply(self, state: dict[str, Any], action: str, selected: str | None = None,
              value: str | None = None) -> dict[str, Any]:
        return self.request("tylr/edit/apply", {
            "editorId": state["editorId"], "baseRevision": state["revision"],
            "targetId": self.target(state, action, selected), "actionId": action,
            **({"input": value} if value is not None else {}),
        })

    def read(self, state: dict[str, Any]) -> dict[str, Any]:
        return self.request("tylr/edit/state", {"editorId": state["editorId"]})["result"]

    def test_operator_hole_roundtrip_keeps_original_document(self) -> None:
        before = self.start()
        self.assertTrue(before["complete"])
        erased = self.apply(before, "erase_operator", "+")["result"]
        self.assertEqual(erased["text"], "(2 ◇ (3 * 4))")
        self.assertFalse(erased["complete"])
        restored = self.apply(erased, "fill_operator:+")["result"]
        self.assertEqual(restored["text"], before["text"])
        self.assertEqual(restored["revision"], 2)
        self.assertEqual(self.server.documents[URI], (1, self.source))
        # Recovery reads authoritative state without replaying a write.
        self.assertEqual(self.read(before), restored)

    def test_stale_writes_and_notifications_do_not_mutate_draft(self) -> None:
        before = self.start()
        erased = self.apply(before, "erase_operator", "+")["result"]
        stale = self.apply(before, "erase_operator", "+")
        self.assertEqual(stale["error"]["code"], -32801)
        self.notify("tylr/edit/apply", {"editorId": before["editorId"], "baseRevision": 1,
                    "targetId": self.target(erased, "fill_operator:*"), "actionId": "fill_operator:*"})
        self.assertEqual(self.read(before), erased)
        self.notify("tylr/edit/start", {"textDocument": {"uri": URI, "version": 1}})
        self.assertEqual(len(self.server.edits.drafts), 1)

    def test_expression_hole_rejects_invalid_name_and_accepts_large_integer(self) -> None:
        before = self.start()
        hole = self.apply(before, "erase_expression", "2")["result"]
        rejected = self.apply(hole, "fill_name", value="class")
        self.assertEqual(rejected["error"]["code"], -32602)
        self.assertEqual(self.read(hole), hole)
        value = "123456789012345678901234567890"
        filled = self.apply(hole, "fill_nat", value=value)["result"]
        self.assertTrue(filled["complete"])
        self.assertIn(value, filled["text"])

    def test_invalid_targets_actions_and_revisions_are_atomic(self) -> None:
        before = self.start()
        base = {"editorId": before["editorId"], "baseRevision": 0,
                "targetId": self.target(before, "erase_operator", "+"), "actionId": "erase_operator"}
        for change in [{"targetId": "nonexistent"}, {"actionId": "erase_expression"},
                       {"baseRevision": True}, {"baseRevision": "0"}]:
            response = self.request("tylr/edit/apply", {**base, **change})
            self.assertEqual(response["error"]["code"], -32602)
            self.assertEqual(self.read(before), before)
        saved = deepcopy(self.server.edits.drafts)
        with patch("server.edit_service.snapshot", side_effect=ValueError("render failed")):
            self.assertEqual(self.request("tylr/edit/apply", base)["error"]["code"], -32602)
        self.assertEqual(self.server.edits.drafts, saved)

    def test_close_and_document_changes_invalidate_drafts_only_after_valid_change(self) -> None:
        draft = self.start()
        self.request("tylr/edit/close", {"editorId": draft["editorId"]})
        self.assertIn("error", self.request("tylr/edit/state", {"editorId": draft["editorId"]}))
        draft = self.start()
        with self.assertLogs(level="WARNING"):
            self.notify("textDocument/didChange", {"textDocument": {"uri": URI, "version": 2},
                        "contentChanges": [{"text": None}]})
        self.assertEqual(self.read(draft), draft)
        self.notify("textDocument/didChange", {"textDocument": {"uri": URI, "version": 2},
                    "contentChanges": [{"text": "42"}]})
        self.assertFalse(self.server.edits.drafts)
        self.assertEqual(self.server.documents[URI], (2, "42"))

    def test_unsupported_source_and_old_version_are_explicit(self) -> None:
        response = self.request("tylr/edit/start", {"textDocument": {"uri": URI, "version": 0}})
        self.assertEqual(response["error"]["code"], -32801)
        self.notify("textDocument/didChange", {"textDocument": {"uri": URI, "version": 2},
                    "contentChanges": [{"text": "dangerous_call()"}]})
        response = self.request("tylr/edit/start", {"textDocument": {"uri": URI, "version": 2}})
        self.assertEqual(response["error"]["code"], -32602)
        self.assertFalse(self.server.edits.drafts)
        self.assertEqual(self.server.documents[URI], (2, "dangerous_call()"))

    def test_draft_limit_and_shutdown_cleanup(self) -> None:
        for _ in range(8):
            self.start()
        response = self.request("tylr/edit/start", {"textDocument": {"uri": URI, "version": 1}})
        self.assertEqual(response["error"]["code"], -32602)
        self.request("shutdown")
        self.assertFalse(self.server.edits.drafts)

    def test_start_retries_are_idempotent_and_cannot_resurrect_closed_drafts(self) -> None:
        params = {"requestId": "retry-token", "textDocument": {"uri": URI, "version": 1}}
        first = self.request("tylr/edit/start", params)["result"]
        self.assertEqual(self.request("tylr/edit/start", params)["result"], first)
        self.assertEqual(len(self.server.edits.drafts), 1)
        edited = self.apply(first, "erase_operator", "+")["result"]
        self.assertEqual(self.request("tylr/edit/start", params)["result"], edited)
        self.request("tylr/edit/close", {"editorId": first["editorId"]})
        self.assertEqual(self.request("tylr/edit/start", params)["error"]["code"], -32602)
        self.assertFalse(self.server.edits.drafts)


if __name__ == "__main__":
    unittest.main()
