import unittest

from server.editing import (
    Binary, EraseExpression, EraseOperator, FillName, FillNat, FillOperator,
    Hole, Name, Nat, Op, Paren, State, complete, edit, is_complete, lookup,
    replace_at, select, state_well_formed, valid_name,
)
from server.editing_wire import (
    decode_action, decode_expr, decode_state, encode_action, encode_expr,
    encode_state, process_request,
)


class EditingTests(unittest.TestCase):
    def test_operator_roundtrip_preserves_context_children_and_cursor(self):
        for op in Op:
            focused = Binary(op, Name("left"), Paren(Binary(Op.SUB, Nat(4), Nat(2))))
            original = State(Binary(Op.MUL, Nat(9), Paren(focused)), ("right", "body"))
            erased = edit(original, EraseOperator())
            self.assertEqual(lookup(erased.root, erased.cursor), Binary(None, focused.left, focused.right))
            self.assertEqual(edit(erased, FillOperator(op)), original)
            changed = edit(erased, FillOperator(Op.ADD))
            self.assertEqual(changed.cursor, original.cursor)
            self.assertEqual(changed.root.left, Nat(9))
            self.assertTrue(state_well_formed(changed))

    def test_rejected_actions_are_partial_and_leave_immutable_state(self):
        state = State(Binary(Op.ADD, Hole(), Name("keep")), ("left",))
        for action in [EraseOperator(), FillOperator(Op.MUL), FillName("for"), FillName("café")]:
            self.assertIsNone(edit(state, action))
        self.assertEqual(state.root, Binary(Op.ADD, Hole(), Name("keep")))
        filled = edit(state, FillName("_value2"))
        self.assertEqual(lookup(filled.root, filled.cursor), Name("_value2"))
        self.assertIsNone(edit(filled, FillNat(8)))
        erased = edit(filled, EraseExpression())
        self.assertEqual(edit(erased, FillNat(8)).root, Binary(Op.ADD, Nat(8), Name("keep")))

    def test_paths_are_constructor_sensitive_and_replacement_preserves_siblings(self):
        root = Paren(Binary(Op.ADD, Name("x"), Nat(2)))
        self.assertEqual(select(State(root), ("body", "right")), State(root, ("body", "right")))
        self.assertIsNone(select(State(root), ("right",)))
        self.assertIsNone(replace_at(root, ("body", "body"), Hole()))
        self.assertEqual(replace_at(root, ("body", "left"), Nat(3)),
                         Paren(Binary(Op.ADD, Nat(3), Nat(2))))
        self.assertFalse(state_well_formed(State(root, ("left",))))

    def test_completion_and_ascii_name_boundary(self):
        root = Paren(Binary(None, Hole(), Binary(Op.SUB, Name("match"), Hole())))
        self.assertFalse(is_complete(root))
        completed = complete(root)
        self.assertTrue(is_complete(completed))
        self.assertEqual(completed, Paren(Binary(Op.ADD, Nat(0), Binary(Op.SUB, Name("match"), Nat(0)))))
        self.assertEqual(complete(completed), completed)
        for name in ["a", "_", "A01", "match", "case", "type"]:
            self.assertTrue(valid_name(name))
        for name in ["", "2x", "True", "async", "café", "𝑥", "a-b", "a\n"]:
            self.assertFalse(valid_name(name))

    def test_natural_numbers_reject_non_model_values(self):
        for invalid in [-1, True, 1.5]:
            with self.assertRaises(ValueError):
                Nat(invalid)
            with self.assertRaises(ValueError):
                FillNat(invalid)


class EditingWireTests(unittest.TestCase):
    def test_json_roundtrip_keeps_big_naturals_and_explicit_grouping(self):
        state = State(Paren(Binary(None, Nat(10**55 + 7), Hole())), ("body", "right"))
        encoded = encode_state(state)
        self.assertEqual(decode_state(encoded), state)
        self.assertIsInstance(encoded["root"]["body"]["left"]["value"], str)
        self.assertEqual(encode_expr(decode_expr({"kind": "nat", "value": "00042"})),
                         {"kind": "nat", "value": "42"})
        for action in [EraseOperator(), FillOperator(Op.SUB), EraseExpression(), FillName("x"), FillNat(10**50)]:
            self.assertEqual(decode_action(encode_action(action)), action)

    def test_normal_rejection_is_distinct_from_malformed_model(self):
        state = encode_state(State(Hole()))
        for action in [{"kind": "fill_name", "value": "for"},
                       {"kind": "select", "path": ["left"]},
                       {"kind": "erase_operator"}]:
            self.assertEqual(process_request({"state": state, "action": action}),
                             {"accepted": False, "state": None})
        malformed = [None, {}, {"root": {"kind": "name", "value": "for"}, "cursor": []},
                     {"root": {"kind": "hole"}, "cursor": ["left"]}]
        for value in malformed:
            result = process_request({"state": value, "action": {"kind": "erase_expression"}})
            self.assertIn("error", result)

    def test_wire_budget_and_non_decimal_naturals(self):
        for value in [1, True, "-1", "+1", "١", "1_000", "", "1" * 1025]:
            with self.assertRaises(ValueError):
                decode_expr({"kind": "nat", "value": value})
        expression = {"kind": "hole"}
        for _ in range(65):
            expression = {"kind": "paren", "body": expression}
        with self.assertRaises(ValueError):
            decode_expr(expression)
        with self.assertRaises(ValueError):
            decode_expr({"kind": "name", "value": "a" * 1025})


if __name__ == "__main__":
    unittest.main()
