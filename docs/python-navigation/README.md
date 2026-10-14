# Python structural navigation run

## Objective

Add Python token/tile navigation to the existing Tylr application. Keep Python
parsing, recovery, indentation interpretation, tokenization, and concrete-syntax
projection behind a Language Server Protocol boundary. Preserve original source.
The editor should understand generic ranges and relationships, not Python syntax.

The complete worker objective and acceptance criteria are in
[gnhf-prompt.md](gnhf-prompt.md).

## Current status: prepared, implementation blocked

On 2026-10-14, the host created the fork `seanjennings960/tylr`, cloned upstream
`melds` at `1543f29f87db20bdd94bc9fa82df5c8142ae73e7`, and loaded the upstream
[GNHF skill](https://github.com/kunchenguid/gnhf/tree/main/skills/gnhf).
GNHF 0.1.51 ran in Companion mode using Codex CLI 0.159.2 and created the branch
`gnhf/objective-implement-67097f`.

The worker produced no JSONL events or token usage before the host's three-minute
startup watchdog stopped the run. GNHF reported zero successful iterations,
zero implementation commits, and zero changed files. Its final status was
`stopped`; the completion condition was not met. Independent minimal Codex CLI
startup checks also timed out. The CLI reported an existing ChatGPT login, but
that is not evidence of a functioning model request. The cause remains unknown.

The build environment has a second blocker: ordinary opam sandbox initialization
failed with `bwrap: Creating new namespace failed: Operation not permitted`.
No OCaml switch or project dependencies were installed. No tests, build, or UI
acceptance checks have passed in this environment.

These two files are host-authored run preparation, not a completed GNHF iteration
or a Python navigation implementation. The local GNHF metadata remains under
`.gnhf/runs/objective-implement-67097f/` and is ignored by Git. No credentials or
machine-specific authentication configuration belong in the repository.

## Architecture constraints established during research

- Core `Sort` and `Grammar` virtual modules are implemented by `src/hazel`, but
  `Labeler.re` and layout still contain language-specific behavior.
- The integration should reach `Model.re`, `Update.re`, `Page.re`, and `Code.re`:
  the existing application's document, action, input, and render pipeline.
- Existing layout synthesizes indentation and navigation can call whitespace
  repair. Neither should change imported Python source.
- ChatLSP's contextual-assistance methods do not specify a structural graph.
  A namespaced, capability-negotiated LSP extension is acceptable; it must be
  documented as custom. Standard `selectionRange` only supplies ancestor chains.
- Preserve anchor/focus ranges independently of AST-node selection so selections
  such as `2 + 3` and `* 4` inside `2 + 3 * 4` remain possible.
- Validate UTF-16 wire coordinates, original-source mapping, tree invariants,
  response versions, server generations, and explicit degraded states.

## Continue in a working execution environment

Use a clean checkout of this feature branch with an authenticated, functioning
coding CLI and an OCaml build environment. Read `gnhf --help` and the GNHF skill
before relying on flags. Configure the chosen agent through GNHF's supported
configuration; retain the environment's normal permission and sandbox controls.

`opam.export` pins OCaml 5.0.0 and dune 3.17.2. The older README's reference to
OCaml 4.08.1 is stale. The upstream CI also adds the opam repository archive.
Install the pinned dependencies in an environment that supports their ordinary
build sandbox, then establish baseline evidence with:

```sh
opam exec -- dune build src --profile dev
opam exec -- dune runtest --force
git diff --check
```

Start or resume a bounded GNHF run on this branch:

```sh
GNHF_TELEMETRY=0 gnhf --agent codex --current-branch \
  --max-iterations 12 --max-tokens 800000 --prevent-sleep off \
  --stop-when 'Python structural navigation is integrated into Tylr through LSP; source is preserved; token, parent/child/sibling and cross-tree selection work; existing and new tests, build and UI acceptance pass; commits are small and the tree is clean.' \
  < docs/python-navigation/gnhf-prompt.md
```

The host must review the actual diffs and independently verify tests and the UI.
If the iteration limit is reached with good partial work, continue from the
existing state in a bounded follow-up run. A worker's completion claim alone is
not acceptance. Do not merge without explicit authorization.

Suggested slices: protocol contract, range invariants, Python server, generic
transport/versioning, navigation model, existing editor input integration,
existing structural rendering, then end-to-end verification and limitations.
Split large stages into further small commits rather than collapsing the feature.

## References

- [Tylr](https://github.com/hazelgrove/tylr)
- [ChatLSP paper](https://arxiv.org/abs/2409.00921)
- [LSP selection ranges](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_selectionRange)
