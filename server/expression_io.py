"""Bounded Python-subset import and canonical presentation of editor syntax.

Parsing and rendering are outside the Lean theorems. Fully parenthesized output
adds presentation parentheses; it is not an inverse of the explicit-Paren AST.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
import io
import tokenize
from typing import Literal

from .editing import Binary, Expr, Hole, Name, Nat, Op, Paren, Path, valid_name


MAX_SOURCE_BYTES = 16_384
MAX_DEPTH = 64
MAX_NODES = 512
MAX_ATOM_CHARS = 1024


def validate_budget(root: Expr) -> None:
    pending: list[tuple[Expr, int]] = [(root, 0)]
    count = 0
    while pending:
        current, depth = pending.pop()
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            raise ValueError("expression exceeds the editor's node or depth budget")
        if isinstance(current, Name):
            if not valid_name(current.value) or len(current.value) > MAX_ATOM_CHARS:
                raise ValueError("identifier must be a bounded ASCII nonkeyword name")
        elif isinstance(current, Nat):
            if current.value >= 10 ** MAX_ATOM_CHARS:
                raise ValueError("natural number exceeds the editor's digit budget")
        elif isinstance(current, Binary):
            if current.op is not None and not isinstance(current.op, Op):
                raise ValueError("unsupported editor operator")
            pending.extend([(current.left, depth + 1), (current.right, depth + 1)])
        elif isinstance(current, Paren):
            pending.append((current.body, depth + 1))


class _Parser:
    def __init__(self, text: str) -> None:
        self.tokens: list[tokenize.TokenInfo] = []
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.COMMENT:
                raise ValueError("comments are outside the expression draft subset")
            if token.type not in {tokenize.ENCODING, tokenize.NL}:
                self.tokens.append(token)
        self.index = 0
        self.node_count = 0

    def peek(self) -> str:
        return self.tokens[self.index].string

    def new(self, expression: Expr) -> Expr:
        self.node_count += 1
        if self.node_count > MAX_NODES:
            raise ValueError("expression exceeds the editor's node budget")
        return expression

    def sum(self, depth: int) -> Expr:
        left = self.product(depth)
        while self.peek() in {"+", "-"}:
            op = Op(self.peek())
            self.index += 1
            left = self.new(Binary(op, left, self.product(depth)))
        return left

    def product(self, depth: int) -> Expr:
        left = self.atom(depth)
        while self.peek() == "*":
            self.index += 1
            left = self.new(Binary(Op.MUL, left, self.atom(depth)))
        return left

    def atom(self, depth: int) -> Expr:
        if depth > MAX_DEPTH:
            raise ValueError("expression exceeds the editor's depth budget")
        token = self.tokens[self.index]
        self.index += 1
        if token.type == tokenize.NAME and valid_name(token.string):
            if len(token.string) > MAX_ATOM_CHARS:
                raise ValueError("identifier exceeds the editor's length budget")
            return self.new(Name(token.string))
        if token.type == tokenize.NUMBER and token.string and all("0" <= c <= "9" for c in token.string):
            if len(token.string) > MAX_ATOM_CHARS:
                raise ValueError("natural number exceeds the editor's digit budget")
            return self.new(Nat(int(token.string)))
        if token.string == "(":
            body = self.sum(depth + 1)
            if self.peek() != ")":
                raise ValueError("expected a closing parenthesis")
            self.index += 1
            return self.new(Paren(body))
        raise ValueError("expected an ASCII name, decimal natural number, or parenthesized expression")

    def parse(self) -> Expr:
        root = self.sum(0)
        while self.tokens[self.index].type == tokenize.NEWLINE:
            self.index += 1
        if self.tokens[self.index].type != tokenize.ENDMARKER:
            raise ValueError("only binary +, -, and * are supported in an expression draft")
        validate_budget(root)
        return root


def parse_expression(text: str) -> Expr:
    if len(text.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError("expression source exceeds the editor's input budget")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    try:
        # Validate Python lexical/syntactic legality independently before the
        # subset parser; do not accidentally accept '1\n+2' or '01'.
        ast.parse(normalized, mode="eval")
        return _Parser(normalized).parse()
    except SyntaxError as error:
        raise ValueError(f"expected a valid Python expression: {error.msg}") from error
    except (tokenize.TokenError, RecursionError) as error:
        raise ValueError("expression is incomplete or exceeds parsing limits") from error


@dataclass(frozen=True)
class Target:
    path: Path
    kind: Literal["expression", "operator"]


@dataclass(frozen=True)
class Rendered:
    text: str
    structure: dict[str, object]
    targets: dict[str, Target]


@dataclass
class _Node:
    id: str
    start: int
    end: int
    label: str
    role: Literal["document", "structure", "token"]
    parent: str | None
    children: list[str] = field(default_factory=list)

    def wire(self) -> dict[str, object]:
        # Names/numerals are ASCII and both hole glyphs are single UTF-16 units.
        return {
            "id": self.id,
            "range": {"start": {"line": 0, "character": self.start},
                      "end": {"line": 0, "character": self.end}},
            "label": self.label, "role": self.role,
            "parentId": self.parent, "children": self.children,
        }


class _Renderer:
    def __init__(self) -> None:
        self.parts: list[str] = []
        self.offset = 0
        self.nodes: list[_Node] = []
        self.tokens: list[str] = []
        self.targets: dict[str, Target] = {}

    def node(self, label: str, role: Literal["document", "structure", "token"], parent: _Node | None) -> _Node:
        node = _Node(f"n{len(self.nodes)}", self.offset, self.offset, label, role, parent.id if parent else None)
        self.nodes.append(node)
        if parent:
            parent.children.append(node.id)
        return node

    def text(self, text: str) -> None:
        self.parts.append(text)
        self.offset += len(text)

    def token(self, text: str, label: str, parent: _Node, target: Target | None = None) -> None:
        node = self.node(label, "token", parent)
        self.text(text)
        node.end = self.offset
        self.tokens.append(node.id)
        if target:
            self.targets[node.id] = target

    def expression(self, root: Expr, parent: _Node, path: Path) -> None:
        target = Target(path, "expression")
        if isinstance(root, Hole):
            self.token("□", "Expression hole", parent, target)
        elif isinstance(root, Name):
            self.token(root.value, "Name", parent, target)
        elif isinstance(root, Nat):
            self.token(str(root.value), "Natural number", parent, target)
        else:
            label = "Binary expression" if isinstance(root, Binary) else "Parenthesized expression"
            node = self.node(label, "structure", parent)
            self.targets[node.id] = target
            self.token("(", "Delimiter", node)
            if isinstance(root, Binary):
                self.expression(root.left, node, path + ("left",))
                self.text(" ")
                self.token(root.op.value if root.op else "◇", "Operator" if root.op else "Operator hole",
                           node, Target(path, "operator"))
                self.text(" ")
                self.expression(root.right, node, path + ("right",))
            else:
                self.expression(root.body, node, path + ("body",))
            self.token(")", "Delimiter", node)
            node.end = self.offset


def render(root: Expr, uri: str, version: int) -> Rendered:
    validate_budget(root)
    renderer = _Renderer()
    document = renderer.node("Expression draft", "document", None)
    renderer.expression(root, document, ())
    document.end = renderer.offset
    structure: dict[str, object] = {
        "uri": uri, "version": version, "status": "ready", "rootId": document.id,
        "nodes": [node.wire() for node in renderer.nodes],
        "tokens": renderer.tokens, "diagnostics": [],
    }
    return Rendered("".join(renderer.parts), structure, renderer.targets)
