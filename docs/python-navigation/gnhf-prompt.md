# Python structural navigation: GNHF prompt

Objective: implement source-preserving Python structural navigation within the existing hazelgrove/tylr editor, with every Python-specific behavior behind a real Language Server Protocol integration. Work on the feature branch created by GNHF. This is a Companion-mode GNHF run supervised by the host agent. The host owns GitHub forking/pushing; do not push or merge.

User intent: transfer Tylr's token/tile structural navigation mechanics to Python. A standalone AST viewer, separate HTML application, or outline alongside an otherwise untouched editor does not satisfy the goal. Navigation support is the initial scope; do not claim arbitrary Python structural-editing guarantees.

Before coding inspect AGENTS.md if present, current repo and recent commits, README, Makefile, opam.export, and the real editor pipeline. Preserve existing files and behavior. The upstream base is melds at 1543f29f87db20bdd94bc9fa82df5c8142ae73e7. Actual toolchain is OCaml 5.0.0 / dune 3.17.2, despite the older README. Do not alter sandbox, network, approval or authentication controls to obtain tooling.

Architecture research already performed (verify before implementing):
- Core has virtual Sort and Grammar modules (src/core/dune and src/core/grammar); Hazel implements these in src/hazel.
- src/core/parser/Labeler.re, grammar/Label.re and layout currently contain language assumptions. Do not add Python regexes/tokenizers/AST kinds into client code.
- Model.re owns Zipper.t; Update.re routes Edit.perform; Page.re owns input and document loading; Code.re renders Zipper.zip via Layout into text and SVG structural decorations. Integrate into this existing application and event/render pipeline.
- Layout synthesizes indentation, Linter.repad may alter whitespace on navigation, and Block treats tiles as single-line. A Python navigation mode must preserve original text (including multiline strings) and must not run Hazel parsing or whitespace normalization.

Protocol boundary:
- Use JSON-RPC LSP initialization, capability negotiation, versioned didOpen/didChange/didClose, shutdown/exit and a real transport. A language-neutral WebSocket-to-stdio bridge is acceptable for the browser application.
- Standard selectionRange is suitable for nested expansion but not a complete structural graph. documentSymbol and semanticTokens are not complete syntax trees.
- ChatLSP (https://arxiv.org/abs/2409.00921, section 5) proposes aiTutorial, expectedType, retrieveRelevantTypes, retrieveRelevantHeaders and errorReport; it does not define structural navigation. If needed define and document a namespaced experimental request such as tylr/structure. Never call it a ChatLSP standard endpoint.
- A generic versioned snapshot can expose opaque node IDs, source ranges, ordered children, token boundaries, server-supplied display labels/categories and parse/recovery status. The server owns all Python parsing, indentation interpretation, tokenization and concrete-syntax projection. The editor operates on validated ranges/relationships and geometry only.
- Preserve source via original slices. Use a recovery CST parser if feasible; otherwise explicitly report limited/unavailable structure for invalid Python. Do not present stale structure as current or assume Python tokenize guarantees invalid-input behavior.
- Negotiate UTF-16 positions and correctly convert Python AST UTF-8 byte offsets or parser code-point positions. Test astral Unicode, non-ASCII identifiers, CRLF, empty files and missing trailing newline.
- Only apply responses matching URI, document version and server session generation. Validate malformed ranges/graphs. Server disconnect, unsupported capability, malformed response and parse error must have visible honest states.

Observable interaction acceptance:
1. Open/import Python in the existing Tylr UI, retaining source byte-for-byte.
2. Move between ordered tokens and parent/child/previous-sibling/next-sibling structural nodes with visible cursor/selection.
3. Keep anchor/focus ranges independent of AST node selection; extend a selection across subtree boundaries (e.g. select `2 + 3` or `* 4` in `2 + 3 * 4`).
4. Navigate nested functions/classes/blocks/calls/expressions, comments, decorators and multiline strings.
5. Source errors, stale responses and server failure produce tested explicit degraded states.
6. Keep the existing Hazel editor and its tests working.

Commit discipline: exactly one cohesive, small, reviewable slice per successful GNHF iteration; GNHF commits it. Do not manually create a giant cumulative commit. Prefer ~250 changed lines or fewer per commit where practical, explaining larger fixture/generated portions. Suggested sequence: (1) architecture and executable acceptance plan; (2) generic protocol types/range invariants; (3) Python server lifecycle and projection; (4) generic transport and version handling; (5) navigation model; (6) existing editor model/input integration; (7) structural rendering; (8) end-to-end fixtures/docs and evidence. Split any large stage into further iterations. Each code slice includes focused meaningful verification.

First iteration: inspect code/toolchain and commit the minimal architecture/acceptance plan with exact integration seams and runnable verification commands. Then proceed incrementally. All required checks must eventually run, including an actual OCaml build, existing tests, server/client protocol tests and browser interaction acceptance against real Python input. Do not report a check as passed unless run. If a prerequisite is impossible, report its exact failure and preserve useful work; do not invent a substitute implementation.

Stop only when the implementation is integrated into the actual editor, all observable acceptance requirements are met, relevant existing/new tests and build pass, a real UI smoke check passes, remaining limitations are documented, and all work is in small commits with a clean working tree. A planning-only commit does not satisfy the overall stop condition.
