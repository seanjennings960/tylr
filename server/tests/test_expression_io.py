import ast
import unittest

from server.editing import Binary, Hole, Name, Nat, Op, Paren, complete, lookup
from server.expression_io import MAX_SOURCE_BYTES, parse_expression, render, validate_budget


class ExpressionParseTests(unittest.TestCase):
    def test_precedence_association_and_explicit_parentheses(self):
        self.assertEqual(parse_expression("a-b-c*2"),
                         Binary(Op.SUB, Binary(Op.SUB, Name("a"), Name("b")),
                                Binary(Op.MUL, Name("c"), Nat(2))))
        self.assertEqual(parse_expression("((a))"), Paren(Paren(Name("a"))))
        self.assertEqual(parse_expression("(a +\r\n 2)\r\n"),
                         Paren(Binary(Op.ADD, Name("a"), Nat(2))))

    def test_import_rejects_syntax_outside_subset_and_python_lexical_errors(self):
        for source in ["", "a()", "a.b", "a[0]", "-1", "+1", "True", "café",
                       "a / b", "a ** b", "a // b", "a and b", "1.0", "0xff",
                       "1_000", "a # comment", "01", "1\n+2", "a;b", "a = 2",
                       "(a, b)", "'hello'", "lambda: 1", "□", "(a ◇ b)"]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                parse_expression(source)

    def test_import_and_model_budget_boundaries(self):
        for source in ["a" * (MAX_SOURCE_BYTES + 1), "a" * 1025, "1" * 1025,
                       "(" * 65 + "a" + ")" * 65, "+".join(["a"] * 258)]:
            with self.assertRaises(ValueError):
                parse_expression(source)
        self.assertEqual(parse_expression("1" * 1024), Nat(int("1" * 1024)))
        for root in [Name("a" * 1025), Name("for"), Nat(10**1024)]:
            with self.assertRaises(ValueError):
                validate_budget(root)
        # A broad shallow tree exercises the node cap independently of depth.
        root = Name("a")
        for _ in range(9):
            root = Binary(Op.ADD, root, root)
        with self.assertRaises(ValueError):
            validate_budget(root)

    def test_complete_render_preserves_independent_cpython_ast_up_to_grouping(self):
        for source in ["a-b-c*2", "a-(b-c)", "(a-b)*c", "a*(b+c)",
                       "((a))", "000+2", "(a +\r\n 2)", "9007199254740993123456789 * n"]:
            with self.subTest(source=source):
                view = render(parse_expression(source), "draft://test", 0)
                expected = ast.dump(ast.parse(source, mode="eval"), include_attributes=False)
                actual = ast.dump(ast.parse(view.text, mode="eval"), include_attributes=False)
                self.assertEqual(actual, expected)
        # This model was edited, not imported: verify the resulting Python shape.
        edited = complete(Binary(None, Hole(), Paren(Binary(Op.SUB, Name("x"), Nat(2)))))
        actual = ast.dump(ast.parse(render(edited, "draft://test", 1).text, mode="eval"))
        self.assertEqual(actual, ast.dump(ast.parse("0 + (x - 2)", mode="eval")))


class ExpressionRenderTests(unittest.TestCase):
    def test_holes_have_live_targets_and_source_ordered_ranges(self):
        root = Paren(Binary(None, Hole(), Binary(Op.MUL, Name("x"), Nat(123))))
        view = render(root, "tylr-editor://test", 4)
        self.assertEqual(view.text, "((□ ◇ (x * 123)))")
        self.assertEqual((view.structure["uri"], view.structure["version"]), ("tylr-editor://test", 4))
        nodes = {node["id"]: node for node in view.structure["nodes"]}
        self.assertEqual(nodes[view.structure["rootId"]]["range"]["end"]["character"], len(view.text))
        slices = []
        previous = 0
        for token_id in view.structure["tokens"]:
            node = nodes[token_id]
            start = node["range"]["start"]["character"]
            end = node["range"]["end"]["character"]
            self.assertGreaterEqual(start, previous)
            self.assertGreater(end, start)
            slices.append(view.text.encode("utf-16-le")[2*start:2*end].decode("utf-16-le"))
            previous = end
        self.assertEqual(slices, ["(", "(", "□", "◇", "(", "x", "*", "123", ")", ")", ")"])
        self.assertEqual(sum(target.kind == "operator" for target in view.targets.values()), 2)
        self.assertTrue(any(target.path == () and target.kind == "expression" for target in view.targets.values()))
        for node_id, target in view.targets.items():
            self.assertIn(node_id, nodes)
            focused = lookup(root, target.path)
            self.assertIsNotNone(focused)
            if target.kind == "operator":
                self.assertIsInstance(focused, Binary)
        for node in nodes.values():
            last = node["range"]["start"]["character"]
            for child_id in node["children"]:
                child = nodes[child_id]
                self.assertEqual(child["parentId"], node["id"])
                self.assertGreaterEqual(child["range"]["start"]["character"], last)
                last = child["range"]["end"]["character"]
                self.assertLessEqual(last, node["range"]["end"]["character"])


if __name__ == "__main__":
    unittest.main()
