#!/usr/bin/env python3
"""Compare the typed Python editor with the checked Lean executable model.

This is deterministic differential testing, not a proof of the Python port.
The fixture generator is independent of both implementations. Every starting
state is within the model's well-formedness precondition; rejected actions,
including invalid names and cursor destinations, are tested explicitly.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterator
import json
from pathlib import Path
import random
import selectors
import subprocess
import sys
import tempfile
from typing import TextIO, cast


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.editing_wire import process_request  # noqa: E402


JsonObject = dict[str, object]
OPS: tuple[str | None, ...] = (None, "+", "-", "*")
BIG_NAT = "90071992547409931234567890123456789012345678901234567890"
KEYWORDS = (
    "False None True and as assert async await break class continue def del elif "
    "else except finally for from global if import in is lambda nonlocal not or "
    "pass raise return try while with yield"
).split()


def hole() -> JsonObject:
    return {"kind": "hole"}


def name(value: str = "x") -> JsonObject:
    return {"kind": "name", "value": value}


def natural(value: str = "0") -> JsonObject:
    return {"kind": "nat", "value": value}


def binary(op: str | None, left: JsonObject, right: JsonObject) -> JsonObject:
    return {"kind": "binary", "op": op, "left": left, "right": right}


def paren(body: JsonObject) -> JsonObject:
    return {"kind": "paren", "body": body}


def state(root: JsonObject, cursor: list[str]) -> JsonObject:
    return {"root": root, "cursor": cursor}


def paths(root: JsonObject) -> Iterator[tuple[list[str], JsonObject]]:
    """Enumerate each valid expression cursor without calling either model."""
    yield [], root
    children: tuple[str, ...]
    if root["kind"] == "binary":
        children = ("left", "right")
    elif root["kind"] == "paren":
        children = ("body",)
    else:
        children = ()
    for direction in children:
        child = cast(JsonObject, root[direction])
        for tail, expression in paths(child):
            yield [direction, *tail], expression


def small_expressions() -> Iterator[JsonObject]:
    """All binary combinations of four atoms and four operator states."""
    atoms = [hole(), name(), natural(), natural(BIG_NAT)]
    yield from atoms
    for atom in atoms:
        yield paren(atom)
    for op in OPS:
        for left in atoms:
            for right in atoms:
                yield binary(op, left, right)
    # Vary context depth and shape; these cases exercise arbitrary-path edits.
    for op in OPS:
        yield paren(binary(op, paren(binary("*", name("_v2"), hole())), natural("17")))
        yield binary(op, name(), paren(binary(None, hole(), binary("-", name("z"), natural()))))
    deep = binary("+", name(), natural("3"))
    for index in range(20):
        deep = paren(deep) if index % 2 else binary("*", natural("2"), deep)
    yield deep


def action_cases(cursor: list[str]) -> Iterator[JsonObject]:
    yield {"kind": "erase_operator"}
    for op in ("+", "-", "*"):
        yield {"kind": "fill_operator", "op": op}
    yield {"kind": "erase_expression"}
    for value in ("x", "_", "value_2", "match", "", "1x", "class", "λ", "a-b", "True"):
        yield {"kind": "fill_name", "value": value}
    for value in ("0", "17", BIG_NAT):
        yield {"kind": "fill_nat", "value": value}
    yield {"kind": "select", "path": []}
    yield {"kind": "select", "path": cursor}
    # Some destinations are invalid because of their shape, others depth.
    yield {"kind": "select", "path": [*cursor, "left", "body"]}
    yield {"kind": "select", "path": ["right", "right", "right", "right"]}


class Oracle:
    """A single subprocess with bounded line waits and nonblocking stderr storage."""

    def __init__(self, executable: Path, stderr: TextIO) -> None:
        self.stderr = stderr
        self.process: subprocess.Popen[str] = subprocess.Popen(
            [str(executable)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("Oracle pipes were not created")
        self.stdin = self.process.stdin
        self.stdout = self.process.stdout
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.stdout, selectors.EVENT_READ)
        self.comparisons = 0
        self.accepted = 0
        self.rejected = 0

    def compare(self, before: JsonObject, action: JsonObject) -> JsonObject:
        request = {"state": before, "action": action}
        serialized = json.dumps(request, separators=(",", ":"), ensure_ascii=False)
        self.stdin.write(serialized + "\n")
        self.stdin.flush()
        python_result = process_request(request)
        if json.dumps(request, separators=(",", ":"), ensure_ascii=False) != serialized:
            raise AssertionError("Python implementation mutated its input request")
        if not self.selector.select(timeout=20.0):
            raise RuntimeError("Lean oracle did not respond within 20 seconds")
        line = self.stdout.readline()
        if not line:
            self.stderr.seek(0)
            raise RuntimeError(f"Lean oracle exited early: {self.stderr.read()[:2000]}")
        lean_result: object = json.loads(line)
        if lean_result != python_result:
            raise AssertionError(
                f"Model mismatch at comparison {self.comparisons + 1}\n"
                f"request: {serialized}\n"
                f"Lean: {json.dumps(lean_result, ensure_ascii=False)}\n"
                f"Python: {json.dumps(python_result, ensure_ascii=False)}"
            )
        if not isinstance(python_result.get("accepted"), bool):
            raise AssertionError(f"Fixture unexpectedly rejected as malformed: {python_result}")
        self.comparisons += 1
        if python_result["accepted"]:
            self.accepted += 1
        else:
            self.rejected += 1
        return python_result

    def close(self) -> None:
        self.selector.close()
        self.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.stdout.close()


def check_small_cases(oracle: Oracle) -> None:
    for expression in small_expressions():
        for cursor, focused in paths(expression):
            before = state(expression, cursor)
            for action in action_cases(cursor):
                result = oracle.compare(before, action)
                if result["accepted"] and action["kind"] == "select":
                    after = cast(JsonObject, result["state"])
                    if after["root"] != expression:
                        raise AssertionError("Selection changed the expression")
            if focused["kind"] == "binary" and focused["op"] is not None:
                erased = oracle.compare(before, {"kind": "erase_operator"})
                if erased["accepted"] is not True:
                    raise AssertionError("A present binary operator could not be erased")
                erased_state = cast(JsonObject, erased["state"])
                restored = oracle.compare(
                    erased_state, {"kind": "fill_operator", "op": focused["op"]}
                )
                if restored != {"accepted": True, "state": before}:
                    raise AssertionError("Erase/fill did not restore the entire original state")
    for keyword in KEYWORDS:
        result = oracle.compare(state(hole(), []), {"kind": "fill_name", "value": keyword})
        if result != {"accepted": False, "state": None}:
            raise AssertionError(f"Reserved keyword accepted as identifier: {keyword}")


def random_expression(rng: random.Random, depth: int) -> JsonObject:
    if depth == 0 or rng.random() < 0.3:
        return rng.choice([hole(), name(rng.choice(["x", "_", "count_3", "match"])),
                           natural(str(rng.randrange(10**30)))])
    if rng.random() < 0.25:
        return paren(random_expression(rng, depth - 1))
    return binary(rng.choice(OPS), random_expression(rng, depth - 1),
                  random_expression(rng, depth - 1))


def check_sequences(oracle: Oracle) -> None:
    rng = random.Random(0x54594C52)
    for _ in range(100):
        current = state(random_expression(rng, 5), [])
        for _ in range(25):
            available = list(paths(cast(JsonObject, current["root"])))
            if rng.random() < 0.45:
                destination, _ = rng.choice(available)
                if rng.random() < 0.15:
                    destination = [*destination, "body", "left"]
                action: JsonObject = {"kind": "select", "path": destination}
            else:
                action = rng.choice(list(action_cases(cast(list[str], current["cursor"]))))
            result = oracle.compare(current, action)
            if result["accepted"]:
                current = cast(JsonObject, result["state"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--oracle", required=True, type=Path,
                        help="Path to the compiled formal/.lake/build/bin/edit_oracle")
    args = parser.parse_args()
    executable = args.oracle.resolve()
    if not executable.is_file():
        parser.error(f"Oracle executable does not exist: {executable}")
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as stderr:
        oracle = Oracle(executable, stderr)
        try:
            check_small_cases(oracle)
            check_sequences(oracle)
            if oracle.comparisons < 5000 or oracle.accepted < 1000 or oracle.rejected < 1000:
                raise AssertionError("Conformance corpus unexpectedly lost coverage")
            print(f"Lean/Python conformance: {oracle.comparisons} comparisons passed "
                  f"({oracle.accepted} accepted, {oracle.rejected} rejected); "
                  "exhaustive small cases, nested operator restoration, and 100 seeded traces.")
        finally:
            oracle.close()


if __name__ == "__main__":
    main()
