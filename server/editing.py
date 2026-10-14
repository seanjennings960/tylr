"""Typed executable port of the checked definitions in formal/Tylr/Edit.lean.

These definitions manipulate editor syntax, including holes. They do not claim
Python type safety or evaluation semantics. Python execution is never involved.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Literal, TypeAlias


class Op(str, Enum):
    ADD = "+"
    SUB = "-"
    MUL = "*"


Direction: TypeAlias = Literal["left", "right", "body"]
Path: TypeAlias = tuple[Direction, ...]


@dataclass(frozen=True)
class Hole:
    pass


@dataclass(frozen=True)
class Name:
    value: str


@dataclass(frozen=True)
class Nat:
    value: int

    def __post_init__(self) -> None:
        if type(self.value) is not int or self.value < 0:
            raise ValueError("a natural number must be a nonnegative integer")


@dataclass(frozen=True)
class Binary:
    op: Op | None
    left: Expr
    right: Expr


@dataclass(frozen=True)
class Paren:
    body: Expr


Expr: TypeAlias = Hole | Name | Nat | Binary | Paren


@dataclass(frozen=True)
class State:
    root: Expr
    cursor: Path = ()


@dataclass(frozen=True)
class EraseOperator:
    pass


@dataclass(frozen=True)
class FillOperator:
    op: Op


@dataclass(frozen=True)
class EraseExpression:
    pass


@dataclass(frozen=True)
class FillName:
    value: str


@dataclass(frozen=True)
class FillNat:
    value: int

    def __post_init__(self) -> None:
        Nat(self.value)


Action: TypeAlias = EraseOperator | FillOperator | EraseExpression | FillName | FillNat

# Fixed to the model's keyword set, rather than the host interpreter's version.
KEYWORDS: frozenset[str] = frozenset({
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
})


def _name_start(character: str) -> bool:
    return character == "_" or "a" <= character <= "z" or "A" <= character <= "Z"


def valid_name(value: str) -> bool:
    return bool(value) and _name_start(value[0]) and all(
        _name_start(character) or "0" <= character <= "9" for character in value[1:]
    ) and value not in KEYWORDS


def well_formed(root: Expr) -> bool:
    if isinstance(root, Name):
        return valid_name(root.value)
    if isinstance(root, Binary):
        return well_formed(root.left) and well_formed(root.right)
    if isinstance(root, Paren):
        return well_formed(root.body)
    return True


def lookup(root: Expr, path: Path) -> Expr | None:
    for direction in path:
        if direction == "left" and isinstance(root, Binary):
            root = root.left
        elif direction == "right" and isinstance(root, Binary):
            root = root.right
        elif direction == "body" and isinstance(root, Paren):
            root = root.body
        else:
            return None
    return root


def replace_at(root: Expr, path: Path, replacement: Expr) -> Expr | None:
    if not path:
        return replacement
    direction, tail = path[0], path[1:]
    if direction == "left" and isinstance(root, Binary):
        changed = replace_at(root.left, tail, replacement)
        return Binary(root.op, changed, root.right) if changed is not None else None
    if direction == "right" and isinstance(root, Binary):
        changed = replace_at(root.right, tail, replacement)
        return Binary(root.op, root.left, changed) if changed is not None else None
    if direction == "body" and isinstance(root, Paren):
        changed = replace_at(root.body, tail, replacement)
        return Paren(changed) if changed is not None else None
    return None


def state_well_formed(state: State) -> bool:
    return well_formed(state.root) and lookup(state.root, state.cursor) is not None


def edit_local(expression: Expr, action: Action) -> Expr | None:
    if isinstance(action, EraseOperator) and isinstance(expression, Binary) and expression.op is not None:
        return Binary(None, expression.left, expression.right)
    if isinstance(action, FillOperator) and isinstance(expression, Binary) and expression.op is None:
        return Binary(action.op, expression.left, expression.right)
    if isinstance(action, EraseExpression):
        return Hole()
    if isinstance(action, FillName) and isinstance(expression, Hole) and valid_name(action.value):
        return Name(action.value)
    if isinstance(action, FillNat) and isinstance(expression, Hole):
        return Nat(action.value)
    return None


def edit(state: State, action: Action) -> State | None:
    focused = lookup(state.root, state.cursor)
    if focused is None:
        return None
    replacement = edit_local(focused, action)
    if replacement is None:
        return None
    root = replace_at(state.root, state.cursor, replacement)
    return State(root, state.cursor) if root is not None else None


def select(state: State, path: Path) -> State | None:
    return State(state.root, path) if lookup(state.root, path) is not None else None


def complete(root: Expr) -> Expr:
    if isinstance(root, Hole):
        return Nat(0)
    if isinstance(root, Binary):
        return Binary(root.op or Op.ADD, complete(root.left), complete(root.right))
    if isinstance(root, Paren):
        return Paren(complete(root.body))
    return root


def is_complete(root: Expr) -> bool:
    if isinstance(root, Hole):
        return False
    if isinstance(root, Binary):
        return root.op is not None and is_complete(root.left) and is_complete(root.right)
    if isinstance(root, Paren):
        return is_complete(root.body)
    return True
