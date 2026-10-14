"""Build a language-neutral navigation tree from valid Python source.

The tree describes selectable source spans, not Python's complete AST. Equal
spans collapse, crossing spans are omitted, and tokens are indivisible leaves.
Whitespace remains in the client's original text between those leaves.
"""

import ast
import bisect
import io
import tokenize

from .source import Source


TRIVIA = {
    tokenize.ENCODING, tokenize.ENDMARKER, tokenize.INDENT,
    tokenize.DEDENT, tokenize.NEWLINE, tokenize.NL,
}


def _tokens(source):
    result = []
    for token in tokenize.generate_tokens(io.StringIO(source.normalized).readline):
        if token.type in TRIVIA:
            continue
        start = source.python_offset(*token.start)
        end = source.python_offset(*token.end)
        if start < end:
            result.append((start, end, tokenize.tok_name[token.type].lower(), "token"))
    return result


def _structures(tree, source, tokens):
    token_starts = [item[0] for item in tokens]
    token_spans = {(item[0], item[1]) for item in tokens}

    def inside_token(offset):
        index = bisect.bisect_right(token_starts, offset) - 1
        return index >= 0 and tokens[index][0] < offset < tokens[index][1]

    spans = {}
    for node in ast.walk(tree):
        if not hasattr(node, "lineno") or getattr(node, "end_lineno", None) is None:
            continue
        start = source.python_offset(node.lineno, node.col_offset, byte_column=True)
        end = source.python_offset(node.end_lineno, node.end_col_offset, byte_column=True)
        # A definition's AST location starts at def/class, excluding decorators.
        for decorator in getattr(node, "decorator_list", []):
            start = min(start, source.python_offset(
                decorator.lineno, max(0, decorator.col_offset - 1), byte_column=True,
            ))
        if start >= end or (start, end) in token_spans:
            continue
        if inside_token(start) or inside_token(end):
            continue  # Older Python versions tokenize a whole f-string at once.
        spans[start, end] = (start, end, type(node).__name__, "structure")
    return list(spans.values())


def snapshot(uri, version, text):
    source = Source(text)
    result = {
        "uri": uri, "version": version, "status": "ready", "rootId": "n0",
        "nodes": [], "tokens": [], "diagnostics": [],
    }
    try:
        tree = ast.parse(source.normalized)
    except SyntaxError as error:
        result.update(status="unavailable", rootId=None)
        result["diagnostics"].append(source.syntax_diagnostic(error))
        return result

    tokens = _tokens(source)
    spans = sorted(_structures(tree, source, tokens) + tokens,
                   key=lambda item: (item[0], -item[1], item[3] == "token"))
    root = {
        "id": "n0", "range": source.range(0, len(text)), "label": "Document",
        "role": "document", "parentId": None, "children": [],
    }
    result["nodes"].append(root)
    stack = [(0, len(text), root)]
    child_ends = {}
    for start, end, label, role in spans:
        depth = len(stack) - 1
        while not (stack[depth][0] <= start and end <= stack[depth][1]):
            depth -= 1
        parent = stack[depth][2]
        if start < child_ends.get(parent["id"], start):
            # Some AST locations overlap without nesting. Such a span cannot
            # become a navigation sibling. Valid lexical tokens never cross.
            continue
        del stack[depth + 1:]
        node_id = "n" + str(len(result["nodes"]))
        node = {
            "id": node_id, "range": source.range(start, end), "label": label,
            "role": role, "parentId": parent["id"], "children": [],
        }
        result["nodes"].append(node)
        parent["children"].append(node_id)
        child_ends[parent["id"]] = end
        if role == "token":
            result["tokens"].append(node_id)
        else:
            stack.append((start, end, node))
    return result
