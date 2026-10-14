"""Bounded JSON adapter for differential checks against the Lean oracle."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from .editing import (
    Action, Binary, Direction, EraseExpression, EraseOperator, Expr, FillName,
    FillNat, FillOperator, Hole, Name, Nat, Op, Paren, Path, State, edit,
    lookup, select, valid_name,
)
from .expression_io import MAX_ATOM_CHARS, MAX_DEPTH, MAX_NODES, validate_budget


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("expected a JSON object")
    return cast(dict[str, object], value)


def _string(value: object) -> str:
    if not isinstance(value, str) or len(value) > MAX_ATOM_CHARS:
        raise ValueError("expected a bounded string")
    return value


def _natural(value: object) -> int:
    text = _string(value)
    if not text or not all("0" <= digit <= "9" for digit in text):
        raise ValueError("expected a nonempty ASCII decimal string")
    return int(text)


def _operator(value: object) -> Op:
    return Op(_string(value))


def _path(value: object) -> Path:
    if not isinstance(value, list) or len(value) > MAX_DEPTH:
        raise ValueError("expected a bounded path array")
    directions: list[Direction] = []
    for item in value:
        if item not in ("left", "right", "body"):
            raise ValueError("unknown path direction")
        directions.append(cast(Direction, item))
    return tuple(directions)


@dataclass
class _Decoder:
    count: int = 0

    def expression(self, value: object, depth: int = 0) -> Expr:
        self.count += 1
        if self.count > MAX_NODES or depth > MAX_DEPTH:
            raise ValueError("expression exceeds the editor's node or depth budget")
        data = _object(value)
        kind = data.get("kind")
        if kind == "hole":
            return Hole()
        if kind == "name":
            name = _string(data.get("value"))
            if not valid_name(name):
                raise ValueError("invalid ASCII nonkeyword name")
            return Name(name)
        if kind == "nat":
            return Nat(_natural(data.get("value")))
        if kind == "binary":
            if "op" not in data:
                raise ValueError("binary expression requires an operator field")
            op = None if data["op"] is None else _operator(data["op"])
            return Binary(op, self.expression(data.get("left"), depth + 1),
                          self.expression(data.get("right"), depth + 1))
        if kind == "paren":
            return Paren(self.expression(data.get("body"), depth + 1))
        raise ValueError("unknown expression kind")


def decode_expr(value: object) -> Expr:
    return _Decoder().expression(value)


def encode_expr(root: Expr) -> dict[str, object]:
    if isinstance(root, Hole):
        return {"kind": "hole"}
    if isinstance(root, Name):
        return {"kind": "name", "value": root.value}
    if isinstance(root, Nat):
        return {"kind": "nat", "value": str(root.value)}
    if isinstance(root, Binary):
        return {"kind": "binary", "op": root.op.value if root.op else None,
                "left": encode_expr(root.left), "right": encode_expr(root.right)}
    return {"kind": "paren", "body": encode_expr(root.body)}


def decode_state(value: object) -> State:
    data = _object(value)
    root = decode_expr(data.get("root"))
    path = _path(data.get("cursor"))
    if lookup(root, path) is None:
        raise ValueError("cursor does not identify an expression")
    return State(root, path)


def encode_state(state: State) -> dict[str, object]:
    return {"root": encode_expr(state.root), "cursor": list(state.cursor)}


def decode_action(value: object) -> Action:
    data = _object(value)
    kind = data.get("kind")
    if kind == "erase_operator":
        return EraseOperator()
    if kind == "fill_operator":
        return FillOperator(_operator(data.get("op")))
    if kind == "erase_expression":
        return EraseExpression()
    if kind == "fill_name":
        # An invalid name is a well-shaped action that the edit rule rejects.
        return FillName(_string(data.get("value")))
    if kind == "fill_nat":
        return FillNat(_natural(data.get("value")))
    raise ValueError("unknown edit action kind")


def encode_action(action: Action) -> dict[str, object]:
    if isinstance(action, EraseOperator):
        return {"kind": "erase_operator"}
    if isinstance(action, FillOperator):
        return {"kind": "fill_operator", "op": action.op.value}
    if isinstance(action, EraseExpression):
        return {"kind": "erase_expression"}
    if isinstance(action, FillName):
        return {"kind": "fill_name", "value": action.value}
    return {"kind": "fill_nat", "value": str(action.value)}


def process_request(request: object) -> dict[str, object]:
    """Match Oracle.lean's accepted/state outcome within the boundary budgets."""
    try:
        data = _object(request)
        state = decode_state(data.get("state"))
        action = _object(data.get("action"))
        if action.get("kind") == "select":
            updated = select(state, _path(action.get("path")))
        else:
            updated = edit(state, decode_action(action))
        if updated is not None:
            validate_budget(updated.root)
        return {"accepted": updated is not None,
                "state": encode_state(updated) if updated is not None else None}
    except ValueError as error:
        return {"error": str(error)}
