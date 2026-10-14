"""Versioned expression drafts; Python syntax and legal actions stay server-side."""

from __future__ import annotations

from dataclasses import dataclass, replace
import secrets
from typing import Literal, Mapping

from .editing import (
    Action, Binary, EraseExpression, EraseOperator, FillName, FillNat,
    FillOperator, Hole, Op, State, edit, is_complete, lookup, select,
)
from .expression_io import MAX_ATOM_CHARS, Rendered, Target, parse_expression, render


class EditError(ValueError):
    def __init__(self, message: str, code: int = -32602) -> None:
        super().__init__(message)
        self.code = code


def string_value(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise EditError(f"{label} must be a nonempty string")
    return value


@dataclass(frozen=True)
class Draft:
    editor_id: str
    request_id: str
    source_uri: str
    source_version: int
    revision: int
    state: State
    focus_kind: Literal["expression", "operator"] = "expression"


def offers(state: State, target: Target) -> list[dict[str, object]]:
    focused = lookup(state.root, target.path)
    if target.kind == "operator":
        if not isinstance(focused, Binary):
            return []
        if focused.op is not None:
            return [{"id": "erase_operator", "label": "Delete operator"}]
        return [
            {"id": "fill_operator:" + op.value, "label": "Fill " + op.value}
            for op in Op
        ]
    if isinstance(focused, Hole):
        return [
            {"id": "fill_name", "label": "Fill name", "input": {
                "label": "Name", "hint": "ASCII identifier, such as total"}},
            {"id": "fill_nat", "label": "Fill integer", "input": {
                "label": "Integer", "hint": "Nonnegative decimal integer"}},
        ]
    return [{"id": "erase_expression", "label": "Delete expression"}]


def decode_offered_action(action_id: str, value: object) -> Action:
    if action_id == "erase_operator":
        return EraseOperator()
    if action_id == "erase_expression":
        return EraseExpression()
    if action_id.startswith("fill_operator:"):
        return FillOperator(Op(action_id.removeprefix("fill_operator:")))
    text = string_value(value, "input")
    if len(text) > MAX_ATOM_CHARS:
        raise EditError("input exceeds the expression editor's size limit")
    if action_id == "fill_name":
        return FillName(text)
    if action_id == "fill_nat" and text.isascii() and text.isdecimal():
        return FillNat(int(text))
    raise EditError("input must be a nonnegative ASCII decimal integer")


def presentation(draft: Draft) -> Rendered:
    return render(draft.state.root, "tylr-editor://" + draft.editor_id, draft.revision)


def snapshot(draft: Draft, view: Rendered | None = None) -> dict[str, object]:
    view = view if view is not None else presentation(draft)
    targets = [
        {"nodeId": node_id, "actions": offers(draft.state, target)}
        for node_id, target in view.targets.items()
    ]
    selected = next(
        node_id for node_id, target in view.targets.items()
        if target.path == draft.state.cursor and target.kind == draft.focus_kind
    )
    complete = is_complete(draft.state.root)
    return {
        "editorId": draft.editor_id, "revision": draft.revision,
        "source": {"uri": draft.source_uri, "version": draft.source_version},
        "text": view.text, "structure": view.structure, "targets": targets,
        "selection": {"nodeId": selected}, "complete": complete,
        "hint": "Expression draft uses canonical formatting. " + (
            "Export the draft to save your changes." if complete
            else "Fill the remaining holes before exporting Python."
        ),
    }


class EditService:
    """Each LanguageServer owns one service, under its transport session lock."""

    def __init__(self) -> None:
        self.drafts: dict[str, Draft] = {}
        self.starts: dict[str, str | None] = {}

    def start(self, uri: str, version: int, text: str, request_id: object) -> dict[str, object]:
        token = string_value(request_id, "requestId")
        if len(token) > 128:
            raise EditError("requestId exceeds the draft request limit")
        if token in self.starts:
            editor_id = self.starts[token]
            if editor_id is None:
                raise EditError("this draft start request has already been closed")
            existing = self.drafts[editor_id]
            if (existing.source_uri, existing.source_version) != (uri, version):
                raise EditError("requestId already belongs to another document version")
            return snapshot(existing)
        if len(self.starts) >= 256:
            raise EditError("reopen the source to start more expression drafts")
        if len(self.drafts) >= 8:
            raise EditError("discard an existing draft before starting another")
        try:
            root = parse_expression(text)
            draft = Draft(secrets.token_hex(16), token, uri, version, 0, State(root, ()))
            result = snapshot(draft)
        except (ValueError, RecursionError) as error:
            raise EditError(str(error) or "expression is too deeply nested") from error
        self.drafts[draft.editor_id] = draft
        self.starts[token] = draft.editor_id
        return result

    def get(self, params: Mapping[str, object]) -> Draft:
        editor_id = string_value(params.get("editorId"), "editorId")
        draft = self.drafts.get(editor_id)
        if draft is None:
            raise EditError("unknown or closed expression draft")
        return draft

    def read(self, params: Mapping[str, object]) -> dict[str, object]:
        return snapshot(self.get(params))

    def apply(self, params: Mapping[str, object]) -> dict[str, object]:
        draft = self.get(params)
        revision = params.get("baseRevision")
        if type(revision) is not int:
            raise EditError("baseRevision must be an integer")
        if revision != draft.revision:
            raise EditError("Content modified: draft revision does not match", -32801)
        if draft.revision >= 2**31 - 1:
            raise EditError("draft revision limit reached")
        target_id = string_value(params.get("targetId"), "targetId")
        action_id = string_value(params.get("actionId"), "actionId")
        target = presentation(draft).targets.get(target_id)
        if target is None:
            raise EditError("unknown target in this draft revision")
        if action_id not in [offer["id"] for offer in offers(draft.state, target)]:
            raise EditError("action is not available for this target")
        selected = select(draft.state, target.path)
        if selected is None:
            raise EditError("target no longer identifies an expression")
        try:
            updated = edit(selected, decode_offered_action(action_id, params.get("input")))
            if updated is None:
                raise EditError("action rejected: the input does not satisfy the edit rule")
            candidate = replace(draft, revision=draft.revision + 1,
                                state=updated, focus_kind=target.kind)
            result = snapshot(candidate)
        except (ValueError, RecursionError) as error:
            raise EditError(str(error) or "expression is too deeply nested") from error
        # Commit only after validation and rendering succeed. The HTTP transport
        # serializes session requests; stale competing writes then fail above.
        self.drafts[draft.editor_id] = candidate
        return result

    def close(self, params: Mapping[str, object]) -> None:
        editor_id = string_value(params.get("editorId"), "editorId")
        draft = self.drafts.pop(editor_id, None)
        if draft is not None:
            # A delayed duplicate start must not recreate a discarded draft.
            self.starts[draft.request_id] = None

    def close_document(self, uri: str) -> None:
        for key, draft in list(self.drafts.items()):
            if draft.source_uri == uri:
                self.close({"editorId": key})

    def clear(self) -> None:
        self.drafts.clear()
        self.starts.clear()
