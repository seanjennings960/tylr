import unittest

from server.structure import snapshot


def position(value):
    return value["line"], value["character"]


class StructureTests(unittest.TestCase):
    def assert_valid_tree(self, result):
        nodes = {node["id"]: node for node in result["nodes"]}
        seen = set()

        def visit(node_id):
            self.assertNotIn(node_id, seen)
            seen.add(node_id)
            node = nodes[node_id]
            start, end = map(position, (node["range"]["start"], node["range"]["end"]))
            last = start
            for child_id in node["children"]:
                child = nodes[child_id]
                self.assertEqual(child["parentId"], node_id)
                child_start = position(child["range"]["start"])
                child_end = position(child["range"]["end"])
                self.assertLessEqual(last, child_start)
                self.assertLessEqual(child_end, end)
                last = child_end
                visit(child_id)

        visit(result["rootId"])
        self.assertEqual(seen, set(nodes))
        self.assertEqual(result["tokens"], [
            node["id"] for node in result["nodes"] if node["role"] == "token"
        ])

    def test_nested_call_navigation_and_token_order(self):
        text = "def f(x):\n    return outer(x + 2, inner(x))\n"
        result = snapshot("file:///sample.py", 7, text)
        self.assertEqual((result["uri"], result["version"]), ("file:///sample.py", 7))
        self.assert_valid_tree(result)
        self.assertIn("FunctionDef", [node["label"] for node in result["nodes"]])
        self.assertIn("BinOp", [node["label"] for node in result["nodes"]])
        self.assertEqual(len(result["tokens"]), 18)

    def test_decorator_is_contained_in_definition(self):
        result = snapshot("file:///sample.py", 1, "@trace\ndef f():\n    pass\n")
        self.assert_valid_tree(result)
        definition = next(n for n in result["nodes"] if n["label"] == "FunctionDef")
        self.assertEqual(definition["range"]["start"], {"line": 0, "character": 0})

    def test_comments_and_astral_unicode_preserve_source_ranges(self):
        text = '# note\r\nx = "🧭"; café = (2 + 3)  # tail\r\n'
        result = snapshot("file:///sample.py", 1, text)
        self.assert_valid_tree(result)
        nodes = {node["id"]: node for node in result["nodes"]}
        token_texts = []
        lines = text.splitlines(keepends=True)
        for token_id in result["tokens"]:
            token = nodes[token_id]
            start, end = token["range"]["start"], token["range"]["end"]
            self.assertEqual(start["line"], end["line"])
            encoded = lines[start["line"]].encode("utf-16-le")
            token_texts.append(encoded[start["character"] * 2:end["character"] * 2].decode("utf-16-le"))
        self.assertEqual(token_texts, ["# note", "x", "=", '"🧭"', ";", "café", "=", "(", "2", "+", "3", ")", "# tail"])
        self.assertEqual(nodes["n0"]["range"]["end"], {"line": 2, "character": 0})

    def test_incomplete_python_is_honestly_unavailable(self):
        result = snapshot("file:///sample.py", 2, "def incomplete(\n")
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["rootId"])
        self.assertEqual(result["nodes"], [])
        self.assertEqual(result["tokens"], [])
        self.assertEqual(result["diagnostics"][0]["severity"], 1)

    def test_empty_multiline_and_fstring_trees(self):
        for text in ["", "# hi", 'x = f"hello {name}!"', 'x = """a\r\nb"""\r\n', "f(x for x in xs)\n"]:
            with self.subTest(text=text):
                self.assert_valid_tree(snapshot("file:///sample.py", 1, text))


if __name__ == "__main__":
    unittest.main()
