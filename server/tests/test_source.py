import unittest

from server.source import Source


class SourceTests(unittest.TestCase):
    def test_ast_bytes_and_token_codepoints_become_utf16(self):
        source = Source('value = "🧭"; café = 2')
        column = source.lines[0].index("café")
        byte_column = len(source.lines[0][:column].encode("utf-8"))
        offset = source.python_offset(1, byte_column, byte_column=True)
        self.assertEqual(offset, source.python_offset(1, column))
        self.assertEqual(source.position(offset), {"line": 0, "character": column + 1})

    def test_newline_mapping_keeps_original_text(self):
        text = "x = 1\r\ny = 2\r\nz = 3\r"
        source = Source(text)
        self.assertEqual(source.text, text)
        self.assertEqual(source.normalized, "x = 1\ny = 2\nz = 3\n")
        self.assertEqual(source.python_offset(2, 0), 7)
        self.assertEqual(source.position(len(text)), {"line": 3, "character": 0})
        with self.assertRaises(ValueError):
            source.position(6)  # The forbidden position between CR and LF.

    def test_unicode_byte_boundary_is_validated(self):
        source = Source("é")
        with self.assertRaises(UnicodeDecodeError):
            source.python_offset(1, 1, byte_column=True)
        with self.assertRaises(ValueError):
            source.python_offset(1, 3, byte_column=True)

    def test_empty_document_and_bounds(self):
        source = Source("")
        self.assertEqual(source.range(0, 0), {
            "start": {"line": 0, "character": 0},
            "end": {"line": 0, "character": 0},
        })
        with self.assertRaises(ValueError):
            source.position(1)
        with self.assertRaises(ValueError):
            source.offset(-1, 0)

    def test_syntax_error_location_after_astral_character(self):
        source = Source('x = "🧭"; value = )')
        try:
            compile(source.normalized, "example.py", "exec")
        except SyntaxError as error:
            diagnostic = source.syntax_diagnostic(error)
        self.assertEqual(diagnostic["range"]["start"], {
            "line": 0, "character": len(source.text) - 1 + 1,
        })


if __name__ == "__main__":
    unittest.main()
