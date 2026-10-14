# Python navigation in Tylr

This branch adds a read-only, source-preserving Python navigation mode to the
existing Tylr application. Open a source file, move by tokens or structure, and
select ranges that cross tree boundaries. Python parsing and tokenization live
in a separate language server; the source-mode editor understands generic ranges
and relationships.

## Run locally

Requirements: Python 3.10 or later and a normal OCaml/opam build environment.
The repository's `opam.export` pins OCaml 5.0.0 and dune 3.17.2; the original
README's OCaml 4.08.1 instructions are outdated.

From the repository root, create a dedicated switch and build:

```sh
opam switch create tylr-python ocaml-base-compiler.5.0.0
opam repository add archive git+https://github.com/ocaml/opam-repository-archive
opam switch import opam.export --switch=tylr-python --yes
opam exec --switch=tylr-python -- dune build src --profile release
python3 -m server --http --port 8765 --www _build/default/src/web/www
```

Open <http://127.0.0.1:8765>, leave **Language ID** set to `python`, and click
**Open source…** to choose a local file. The file's text is sent to the local
server; a document URI does not authorize the server to read files from disk.
Use **Native editor** to return to Tylr's existing Hazel editor.

The editor must be served over local HTTP, as above. The passing CI run's
`tylr-web` artifact can replace the OCaml build step: extract it and point
`--www` at the directory containing `index.html`.

## Navigation

| Input | Action |
| --- | --- |
| Left / right arrow | Previous / next token |
| Up / down arrow | Parent / first child |
| Alt + left / right | Previous / next sibling |
| Shift + navigation | Extend the selection while retaining its anchor |
| Click / Shift + click | Set the cursor / select an arbitrary source range |
| Home / End | Start / end of the current line |
| Escape | Collapse the selection |
| Ctrl/Cmd + A / C | Select all / copy original source text |

The toolbar exposes the same structural commands. For example, in `2 + 3 * 4`
you can select `2 + 3` or `* 4`, although neither range is a complete AST subtree.
Cut copies the selection without modifying the source; paste and typing do not
edit imported documents in this first version.

## Integration and boundaries

- `server/` owns Python AST parsing, tokenization, source projection, diagnostics,
  and conversion of Python byte/code-point coordinates to LSP UTF-16 positions.
- `src/web/source-client.js` owns a generic versioned LSP client, graph validation,
  navigation and anchor/focus ranges. Labels from the server are display data;
  the client does not dispatch on Python syntax kinds.
- The existing `Model.re`, `Update.re`, `Page.re` and `Code.re` carry source-mode
  state, actions, input and rendering. Source rendering reuses Tylr's token SVG
  outline, caret and font-coordinate helpers inside the same code surface.
  It does not create a separate AST viewer or feed Python through Hazel's parser.
- Source text is retained verbatim, including comments, indentation, CRLF,
  trailing newlines and Unicode. Source-mode movement never invokes Hazel's
  whitespace repair. Copy writes the original selected text directly to the
  browser clipboard event; an operating system may normalize clipboard line endings.

The server supports ordinary LSP initialization, document lifecycle and shutdown
with stdio framing or an isolated loopback HTTP transport. Its capability-negotiated
`tylr/structure` method is a **custom extension**, not a ChatLSP method. See
[server/README.md](../../server/README.md) for the contract and launch options.

## Current limits

- This is source navigation, not Python structural editing, execution, type
  checking, definition lookup or refactoring.
- File loading uses the browser's UTF-8 decoder. Other Python source encodings
  are not supported; source preservation refers to the decoded Unicode text.
- Syntax errors preserve visible source and produce an explicit `unavailable`
  status; structural commands are disabled until a valid snapshot is available.
  There is no error-recovery parser or fabricated fallback tree.
- The server returns a source-span projection, not every Python AST node. Equal
  spans collapse; crossing spans and spans that split tokens are omitted. Accepted
  grammar and f-string detail follow the running Python interpreter.
- The view uses monospace display cells and four-column tab stops. It does not
  implement full grapheme-cluster or East Asian terminal-width layout. Token
  outlines can be split at selection boundaries.

## Verification status

GitHub Actions [run 38540874533](https://github.com/seanjennings960/tylr/actions/runs/38540874533)
passed on implementation commit `53742f18c7a32cc324ca3c547788f05f33ae5c78`:

- OCaml build of the actual editor and its existing native tests.
- **21 Python server tests** and **13 generic client / real client-server tests**.
- Compiled-browser acceptance against the real Python server, including source
  clicks retaining clipboard focus and exact copy-event text.
- Whitespace checks.

The run provides `tylr-web` (the runnable app) and `tylr-browser-evidence`
(cross-tree selection and Unicode source screenshots) artifacts. Later
documentation-only commits do not change the verified implementation.

Local Python and JavaScript tests also pass. This environment cannot initialize
opam's normal sandbox (`bwrap: Creating new namespace failed: Operation not permitted`),
and local browser downloads returned invalid archives. Build and browser evidence
therefore comes from GitHub CI; no local build or browser success is claimed.

```sh
python3 -m unittest discover -s server/tests -p 'test_*.py' -v
node --test test/source-client*.mjs
opam exec -- dune runtest --force
```

The CI workflow builds the real application and runs `test/ui-smoke.mjs` against
the Python server. That test opens files through the UI, checks token and tree
navigation, cross-tree ranges, exact copy-event text, Unicode/CRLF preservation,
read-only behavior, invalid-source status and returning to the native editor.
It captures screenshots in the `tylr-browser-evidence` artifact.

### Connector authorization

The initial GitHub API write failed because the ChatGPT Codex Connector used a
selected-repository installation that did not include the newly created fork.
Public reads still worked, which did not imply permission to write. The user
approved adding only `seanjennings960/tylr` to that installation; normal connector
writes then succeeded without changing browser-upload approval settings.

Early CI/server slices were published through GitHub's browser UI. The remaining
small commits use the GitHub connector and preserve those earlier commits. The
local implementation history and the published history consequently have different
commit IDs; their final source trees are checked for equality before verification.

## GNHF and implementation history

On 2026-10-14, the host forked `hazelgrove/tylr` to `seanjennings960/tylr`, based
on upstream `melds` commit `1543f29f87db20bdd94bc9fa82df5c8142ae73e7`, and loaded
the requested [GNHF skill](https://github.com/kunchenguid/gnhf/tree/main/skills/gnhf).
GNHF 0.1.51 created `gnhf/objective-implement-67097f` in Companion mode with Codex
CLI 0.159.2. Its worker failed to start producing events before the startup
watchdog stopped it: zero successful iterations and zero implementation commits.

The user subsequently explicitly authorized direct coding with CI verification.
The implementation commits on this branch were made under that authorization;
they are not represented as successful GNHF iterations. The original bounded
worker objective is preserved in [gnhf-prompt.md](gnhf-prompt.md).

References: [Tylr](https://github.com/hazelgrove/tylr),
[ChatLSP](https://arxiv.org/abs/2409.00921), and
[LSP selection ranges](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_selectionRange).
