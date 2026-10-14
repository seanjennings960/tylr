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

The proof and audit first passed at commit
`ffa01209162b550809ebd8f9679f32cd3d77048f`, in
[GitHub Actions run 38582307128](https://github.com/seanjennings960/tylr/actions/runs/38582307128),
before the Python implementation was written.

The typed implementation is in `server/editing.py`; importing and presenting
expressions is in `server/expression_io.py`. `server/editing_wire.py` is the JSON
adapter used by the differential checker. Run the implementation checks with:

```sh
python -m unittest discover -s server/tests -p 'test_*.py' -v
python -m mypy --strict server/editing.py server/editing_wire.py server/expression_io.py server/edit_service.py
node --test test/source-client*.mjs
cd formal && lake build edit_oracle && cd ..
python test/lean-conformance.py --oracle formal/.lake/build/bin/edit_oracle
```

The conformance corpus exercises 9,215 transitions: small expressions at every
valid cursor, nested operator restoration, invalid selections and names, large
integer values, and 100 deterministic action sequences. It compares complete
tagged states, preserving explicit parenthesis nodes. CI also builds the Reason
application and runs browser acceptance against the real server.

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

After an ambiguous mutation failure, reading the old revision is insufficient:
the delayed mutation may still arrive. Editing and export stay blocked until a
newer revision is observed or the draft is discarded. Definitive server
rejections may retain the existing revision. Draft-start requests carry an
idempotency token; retrying a lost response retrieves the same draft, and a
delayed duplicate cannot recreate a closed draft.

The first observable example is deleting `+` from `2 + 3`, obtaining a missing
operator with both operands intact, then filling that hole with `*`. Completed
drafts can be exported as Python. Discarding a draft restores the original source
view; incomplete drafts are never exported as executable Python.

## LSP extension

The server advertises `experimental.tylrEdit.version = 1` with a display label
and description. These custom requests use the existing JSON-RPC session:

| Request | Parameters | Result |
| --- | --- | --- |
| `tylr/edit/start` | `textDocument: {uri, version}`, opaque `requestId` | Draft snapshot; repeated token returns the same draft |
| `tylr/edit/apply` | `editorId`, `baseRevision`, `targetId`, `actionId`, optional string `input` | Next draft snapshot |
| `tylr/edit/state` | `editorId` | Authoritative current snapshot |
| `tylr/edit/close` | `editorId` | `null`; discard is idempotent |

A snapshot contains `editorId`, `revision`, original `source: {uri, version}`,
canonical `text`, a generic `structure` tree, `targets`, `selection: {nodeId}`,
`complete`, and a display `hint`. Structure uses the synthetic URI
`tylr-editor://EDITOR_ID` and the draft revision. Each target contains `nodeId`
and offered actions with opaque `id`, display `label`, and optional
`input: {label, hint}`. The server maps those IDs to calculus paths and actions.

`baseRevision` must match exactly. Errors use JSON-RPC `-32602` for invalid
requests/unsupported actions and LSP `-32801` for stale versions. No edit request
may be sent as a notification. Original-document changes/closure invalidate its
drafts. Requests are serialized within each HTTP session.

The implementation bounds imported source to 16,384 bytes, expression depth to
64, nodes to 512, atom length to 1,024 characters, concurrent drafts to eight, and
start tokens to 256 per session. These are implementation limits outside the
unbounded Lean calculus. Comments, Unicode identifiers, calls, unary operators,
and other unsupported constructs fail explicitly while the source navigator
remains available.

## Try the editor

Build the existing application, then serve it with the Python server:

```sh
opam exec -- dune build src --profile release
python -m server --http --port 8765 --www _build/default/src/web/www
```

Open `http://127.0.0.1:8765`, open a file containing `2 + 3 * 4`, and choose
**Edit expression draft**. Select the `+` token and use **Delete operator**, then
**Fill \***. **Export draft** downloads a completed expression; **Discard draft**
returns to the exact imported source. This slice uses explicit action controls;
free typing and arbitrary fragment insertion/movement are not implemented.
