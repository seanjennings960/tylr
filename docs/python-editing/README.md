# Proof-first expression editing

This development adds an opt-in expression draft to the existing Python source
navigator. The original document remains unchanged. An editing draft has its own
server-owned syntax tree and revision; its text is a canonical presentation of
that tree. Incomplete presentations are not ordinary Python source.

## Scope

The Lean model in `formal/Tylr/Edit.lean` contains:

- ASCII identifiers other than Python keywords;
- nonnegative integer literals;
- binary `+`, `-`, and `*`;
- explicit parentheses;
- expression holes and missing operators.

A cursor is a path through left/right operands or a parenthesis body. Actions
erase an operator, fill an operator hole, erase an expression, fill an expression
hole with a name or integer, or select another valid path. Unsupported actions
are rejected. This first calculus does not include inserting larger expressions,
moving arbitrary token fragments, binding, types, evaluation, statements, calls,
unary operators, or all of Python's lexical syntax.

## What the proof says

Well-formedness means that every name is valid and the cursor identifies an
existing expression. Holes are intentional syntax in this editor language.

The Lean development proves that successful actions preserve this invariant,
selection preserves the expression, and deleting then restoring an operator at
any valid path restores the whole state while retaining both operands. It also
relates executable local actions to independent inductive action rules and
constructs a well-formed, hole-free completion of every well-formed expression.
Completion fills expression holes with `0` and operator holes with `+`; it does
not infer programmer intent or imply that an expression can execute without
errors.

The theorem is about the Lean calculus. The Python implementation, parser,
renderer, protocol, and browser are outside that proof. Differential checks
against a Lean executable and independent parser/renderer checks provide
implementation evidence; they are not a proof of Python-to-Lean refinement.

The model uses a fixed ASCII identifier/keyword definition. It does not formalize
CPython's full grammar, Unicode identifier rules, binding, or execution semantics.
The fully parenthesized presentation may add grouping parentheses, so source
round trips preserve expression structure after removing explicit grouping
nodes, not exact formatting or identical parenthesis constructors.

## Verification

The project pins Lean 4.19.0 and uses its standard library only:

```sh
cd formal
lake build
lake env lean -DwarningAsError=true Audit.lean
```

The audit checks theorem dependencies and rejects admitted proofs, custom axioms,
and compiler-trust axioms. The standard Lean axioms `propext`, `Quot.sound`, and
`Classical.choice` are the only permitted dependencies. Proof compilation treats
warnings as errors. CI downloads the pinned official distribution and checks its
SHA256 before running these commands.

## Interaction contract

Editing is a separate draft, entered explicitly from the source navigator.
The server owns the expression, holes, cursor, legal actions, and action labels.
The client displays a range tree and sends opaque target/action identifiers.
Only exact structural selections receive edit actions; a cross-subtree text
selection remains selectable and copyable but has no edit rule in this slice.

Every mutation carries the draft's revision. Rejected actions leave the draft
unchanged. The client waits for a validated server response before changing its
view. If a response is lost, it reads the authoritative draft state rather than
blindly repeating a mutation. A failed resynchronization disables editing until
the draft is recovered or discarded.

The first observable example is deleting `+` from `2 + 3`, obtaining a missing
operator with both operands intact, then filling that hole with `*`. Completed
drafts can be exported as Python. Discarding a draft restores the original source
view; incomplete drafts are never exported as executable Python.
