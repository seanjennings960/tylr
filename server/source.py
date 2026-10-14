"""Conversions between original source, Python locations and LSP UTF-16."""

import bisect
import re


class Source:
    def __init__(self, text):
        # JSON can carry lone surrogates, but Python source and UTF-8 LSP cannot.
        text.encode("utf-8")
        self.text = text
        parts = re.split(r"(\r\n|\r|\n)", text)
        self.lines = parts[::2]
        self.starts = [0]
        for index in range(0, len(parts) - 1, 2):
            self.starts.append(self.starts[-1] + len(parts[index]) + len(parts[index + 1]))
        # Only the parser sees normalized newlines. Display always uses text.
        self.normalized = "\n".join(self.lines)

    def offset(self, line, column):
        """Convert zero-based line/code-point column to original text offset."""
        if not 0 <= line < len(self.lines) or not 0 <= column <= len(self.lines[line]):
            raise ValueError("source location out of bounds")
        return self.starts[line] + column

    def python_offset(self, line, column, *, byte_column=False):
        """Python lines are one-based; AST columns are UTF-8 byte offsets."""
        line -= 1
        if not 0 <= line < len(self.lines):
            raise ValueError("Python line out of bounds")
        if byte_column:
            encoded = self.lines[line].encode("utf-8")
            if not 0 <= column <= len(encoded):
                raise ValueError("Python column out of bounds")
            column = len(encoded[:column].decode("utf-8"))
        return self.offset(line, column)

    def position(self, offset):
        """An original text offset becomes an LSP UTF-16 position."""
        if not 0 <= offset <= len(self.text):
            raise ValueError("source offset out of bounds")
        line = bisect.bisect_right(self.starts, offset) - 1
        column = offset - self.starts[line]
        if column > len(self.lines[line]):
            raise ValueError("position inside a line ending")
        character = len(self.lines[line][:column].encode("utf-16-le")) // 2
        return {"line": line, "character": character}

    def range(self, start, end):
        if end < start:
            raise ValueError("reversed source range")
        return {"start": self.position(start), "end": self.position(end)}

    def syntax_diagnostic(self, error):
        line = min(max((error.lineno or 1) - 1, 0), len(self.lines) - 1)
        column = min(max((error.offset or 1) - 1, 0), len(self.lines[line]))
        end_line = min(max((error.end_lineno or line + 1) - 1, line), len(self.lines) - 1)
        end_column = min(max((error.end_offset or column + 2) - 1, 0), len(self.lines[end_line]))
        start = self.offset(line, column)
        end = max(start, self.offset(end_line, end_column))
        return {
            "range": self.range(start, end),
            "severity": 1,
            "message": error.msg,
            "source": "tylr-python",
        }
