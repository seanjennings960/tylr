# Python structural language server

This standard-library Python server provides source navigation to a language-neutral
editor. It parses document text supplied over LSP. It does not execute that text or
read document URIs from disk. Use Python 3.10 or later; the running interpreter's
Python grammar determines which syntax is accepted.

From the repository root:

```sh
python3 -m server --stdio
python3 -m server --http --port 8765 --www _build/default/src/web/www
python3 -m unittest discover -s server/tests -v
```

The first command uses LSP `Content-Length` framing over standard input/output.
The second serves the built editor and browser transport at
`http://127.0.0.1:8765`. `--www` is optional when an editor is already served by
another local development server. Only files beneath that explicit directory are
served; directory traversal and symlinks escaping the directory are rejected.

## Browser transport

1. `POST /session` returns `{ "sessionId": "opaque-token" }`.
2. Send JSON-RPC messages to `POST /rpc`, with `Content-Type: application/json`
   and `X-Tylr-Session: opaque-token`.
3. Requests return HTTP 200 with a JSON-RPC response. Notifications return HTTP
   204 without a body. Transport failures use HTTP error status codes.

Each session has independent documents and LSP lifecycle. The server binds only
to `127.0.0.1`; browser origins must use `localhost`, `127.0.0.1`, or `[::1]`.
File origins (`Origin: null`) are unsupported: serve the editor over local HTTP.
Session tokens are removed on `exit`; creating a new session clears sessions
unused for one hour. At most 32 sessions and 2 MiB per request are accepted.

## LSP lifecycle

Send `initialize`, wait for its response, send `initialized`, and then
`textDocument/didOpen`. Initialization advertises:

```json
{
  "positionEncoding": "utf-16",
  "textDocumentSync": { "openClose": true, "change": 1 },
  "experimental": { "tylrStructure": { "version": 1 } }
}
```

`didOpen` includes `{uri, languageId: "python", version, text}`. Changes use
`textDocument/didChange` with an increasing integer version and full text in
`contentChanges: [{text: "..."}]`. The server applies a change atomically after
validating every supplied content change. `didClose` releases a document.
Finish with a `shutdown` request and then an `exit` notification.

## Structural snapshot extension, version 1

Request `tylr/structure` with:

```json
{ "textDocument": { "uri": "file:///example.py", "version": 1 } }
```

The response has this shape:

```json
{
  "uri": "file:///example.py",
  "version": 1,
  "status": "ready",
  "rootId": "n0",
  "nodes": [
    {
      "id": "n0",
      "range": {
        "start": { "line": 0, "character": 0 },
        "end": { "line": 0, "character": 0 }
      },
      "label": "Document",
      "role": "document",
      "parentId": null,
      "children": []
    }
  ],
  "tokens": [],
  "diagnostics": []
}
```

- IDs are opaque and valid only within one snapshot. Roles are `document`,
  `structure`, and `token`; labels are for display, never client-side grammar rules.
- The root covers the entire original document. Children are ordered, contained,
  and nonoverlapping. Token nodes are indivisible leaves; `tokens` lists their IDs
  in source order. Comments are tokens; whitespace stays between source ranges.
- Coordinates use zero-based lines, UTF-16 code units, and exclusive ends.
  Python AST UTF-8 byte columns and tokenizer code-point columns are converted
  separately. CRLF and other original source characters are retained by the client.
- The source-span tree collapses equal AST spans and omits crossing spans or spans
  cutting through a token. It is a navigation projection, not the complete AST.
  F-string navigation detail varies with the interpreter's tokenizer version.
- A syntax error returns `status: "unavailable"`, `rootId: null`, empty `nodes`
  and `tokens`, and diagnostics with `{range, severity: 1, message, source}`.
  There is no error-recovery parser or invented fallback structure. Parsing does
  not perform type checking or prove that a program will execute successfully.
- A version mismatch returns JSON-RPC error `-32801` (`ContentModified`). An
  unopened document or malformed request parameters return `-32602`. Clients must
  also discard results made obsolete by subsequent edits, reconnects, or navigation.

This endpoint is an explicitly experimental LSP extension. It is not a ChatLSP
method. [ChatLSP §5](https://arxiv.org/html/2409.00921v1#S5) describes semantic
context methods for LLM assistance. Standard
[selection ranges](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_selectionRange)
provide ancestor chains, while this editor needs ordered token leaves and child
relationships. Standard document symbols and semantic tokens are not complete
syntax trees. This first server does not advertise those optional features.
