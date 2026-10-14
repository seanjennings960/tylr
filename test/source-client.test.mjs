import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const client = createRequire(import.meta.url)("../src/web/source-client.js");
const { sourceIndex, validateStructure, NavigationDocument, SourceSession, renderSnapshot } = client;

const text = "2 + 3 * 4\r\n# note 𝒙";
const doc = { uri: "file:///sample.py", version: 1, text };
const pos = (line, character) => ({ line, character });
const range = (start, end) => ({ start: pos(0, start), end: pos(0, end) });
function fixture(document = doc) {
  const end = sourceIndex(document.text).position(document.text.length);
  const node = (id, start, end, parentId, children = [], role = "token") =>
    ({ id, range: range(start, end), parentId, children, role, label: id });
  const nodes = [
    { id: "root", range: { start: pos(0, 0), end }, parentId: null, children: ["add", "comment"], role: "document", label: "Document" },
    node("add", 0, 9, "root", ["two", "plus", "multiply"], "structure"),
    node("two", 0, 1, "add"), node("plus", 2, 3, "add"),
    node("multiply", 4, 9, "add", ["three", "times", "four"], "structure"),
    node("three", 4, 5, "multiply"), node("times", 6, 7, "multiply"), node("four", 8, 9, "multiply"),
    { id: "comment", range: { start: pos(1, 0), end }, parentId: "root", children: [], role: "token", label: "Comment" },
  ];
  return { uri: document.uri, version: document.version, status: "ready", rootId: "root", nodes,
    tokens: ["two", "plus", "three", "times", "four", "comment"], diagnostics: [] };
}
function navigation() {
  const document = new NavigationDocument(doc);
  document.setStructure(fixture());
  return document;
}

test("UTF-16 offsets retain CRLF, astral characters, tabs, and final empty lines", () => {
  const index = sourceIndex("𝒙\t=\r\n\tλ\n");
  assert.equal(index.offset(pos(1, 1)), 7);
  assert.deepEqual(index.position(6), pos(1, 0));
  assert.deepEqual(index.displayPosition(4), { row: 0, col: 5 });
  assert.equal(index.displayOffset(0, 4), 3);
  assert.equal(index.displayOffset(1, 3), 7);
  assert.deepEqual(index.position(9), pos(2, 0));
  assert.throws(() => index.offset(pos(0, 1)), /Unicode/);
  assert.throws(() => index.offset(pos(0, 5)), /outside/);
  assert.deepEqual(sourceIndex("").position(0), pos(0, 0));
});

test("snapshot validation checks the complete tree, source, and token index", () => {
  const result = validateStructure(fixture(), doc);
  assert.equal(result.nodes.get("comment").start, 11);
  assert.equal(result.root.end, text.length);
  const invalid = [
    value => { value.uri = "file:///other.py"; },
    value => { value.version = 0; },
    value => { value.nodes.push(value.nodes[1]); },
    value => { value.nodes[1].parentId = "multiply"; },
    value => { value.nodes[1].children.push("missing"); },
    value => { value.nodes[1].children.push("root"); },
    value => { value.nodes[0].children.pop(); },
    value => { value.nodes[0].range.end = pos(1, 8); },
    value => { value.nodes[2].range.end = pos(0, 3); },
    value => { value.nodes[8].range.end = pos(1, 8); },
    value => { value.tokens.reverse(); },
    value => { value.tokens.pop(); },
    value => { value.tokens.push("comment"); },
    value => { value.diagnostics.push({ message: "bad", range: range(2, 1) }); },
  ];
  for (const mutate of invalid) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateStructure(value, doc));
  }
});

test("token navigation, parent/child, and siblings use server topology", () => {
  const document = navigation();
  assert.equal(document.navigate("nextToken"), true);
  assert.equal(document.snapshot().selectedText, "2");
  document.navigate("nextToken");
  document.navigate("nextToken");
  assert.equal(document.snapshot().selectedText, "3");
  document.navigate("parent");
  assert.equal(document.snapshot().selectedText, "3 * 4");
  document.navigate("prevSibling");
  assert.equal(document.snapshot().selectedText, "+");
  document.navigate("nextSibling");
  document.navigate("firstChild");
  assert.equal(document.snapshot().selectedText, "3");
  document.navigate("parent");
  document.navigate("parent");
  assert.equal(document.snapshot().selectedText, "2 + 3 * 4");
  document.navigate("firstChild");
  assert.equal(document.navigate("prevToken"), false);
  assert.equal(document.navigate("prevSibling"), false);
});

test("range selections cross tree boundaries in either direction without rewriting text", () => {
  const document = navigation();
  document.navigate("nextToken");
  document.navigate("nextToken", { extend: true });
  document.navigate("nextToken", { extend: true });
  assert.equal(document.snapshot().selectedText, "2 + 3");
  document.navigate("nextToken");
  document.navigate("nextToken", { extend: true });
  assert.equal(document.snapshot().selectedText, "* 4");
  document.selectOffsets(9, 9);
  document.navigate("prevToken", { extend: true });
  assert.equal(document.snapshot().selectedText, "* 4");
  document.selectOffsets(0, text.length);
  assert.equal(document.snapshot().selectedText, text);
  assert.equal(document.text, text);
});

test("render bridge preserves source and reports tab-aware cells and exact selected text", () => {
  const document = navigation();
  document.selectOffsets(4, 13);
  const view = renderSnapshot(document);
  assert.equal(view.source, text);
  assert.equal(view.selected_text, "3 * 4\r\n# ");
  assert.equal(view.lines[0].segments.map(segment => segment.text).join(""), "2 + 3 * 4");
  assert.equal(view.lines[1].segments.map(segment => segment.text).join(""), "# note 𝒙");
  assert.deepEqual(view.caret, { row: 1, col: 2 });
  const tabbed = new NavigationDocument({ uri: doc.uri, text: "\t𝒙\n" });
  tabbed.selectOffsets(0, 3);
  const tabView = renderSnapshot(tabbed);
  assert.equal(tabView.lines[0].segments[0].width, 5);
  assert.deepEqual(tabView.caret, { row: 0, col: 5 });
  assert.equal(tabView.lines.length, 2);
});

test("unavailable structures keep exact source and disable structural commands", () => {
  const document = navigation();
  document.setStructure({ uri: doc.uri, version: 1, status: "unavailable", rootId: null, nodes: [], tokens: [],
    diagnostics: [{ message: "Incomplete source", range: range(0, 1) }] });
  assert.equal(document.navigate("nextToken"), false);
  document.selectOffsets(0, text.length);
  assert.equal(document.snapshot().selectedText, text);
  assert.equal(renderSnapshot(document).message, "Incomplete source");
});

function server(options = {}) {
  const messages = [];
  let document = doc;
  async function fetch(url, init) {
    const message = JSON.parse(init.body);
    messages.push({ url, message, headers: init.headers });
    if (url.endsWith("/session")) return { ok: true, status: 200, json: async () => ({ sessionId: "session-1" }) };
    assert.equal(init.headers["X-Tylr-Session"], "session-1");
    if (message.method === "textDocument/didOpen") document = { ...message.params.textDocument };
    if (message.method === "textDocument/didChange") document = { ...document, ...message.params.textDocument, text: message.params.contentChanges[0].text };
    let result = null;
    if (message.method === "initialize") result = { capabilities: { positionEncoding: options.encoding || "utf-16", experimental: { tylrStructure: { version: 1 } } } };
    if (message.method === "tylr/structure") result = options.structure ? await options.structure(document) : fixture(document);
    return { ok: true, status: message.id ? 200 : 204,
      json: async () => ({ jsonrpc: "2.0", id: options.wrongId ? 999 : message.id, result }) };
  }
  return { fetch, messages };
}

test("HTTP transport negotiates capabilities and completes the LSP document lifecycle", async () => {
  const backend = server();
  const session = new SourceSession({ ...doc, languageId: "python", fetch: backend.fetch });
  await session.start();
  assert.equal(session.status, "ready");
  await session.update(text);
  assert.equal(session.version, 2);
  await session.close();
  assert.deepEqual(backend.messages.slice(1).map(item => item.message.method), [
    "initialize", "initialized", "textDocument/didOpen", "tylr/structure",
    "textDocument/didChange", "tylr/structure", "textDocument/didClose", "shutdown", "exit",
  ]);
  assert.equal(session.status, "closed");
});

test("protocol and transport failures become visible without losing source", async () => {
  for (const options of [{ encoding: "utf-8" }, { wrongId: true }, { structure: () => ({ ...fixture(), version: 42 }) }]) {
    const backend = server(options);
    const session = new SourceSession({ ...doc, languageId: "python", fetch: backend.fetch });
    await assert.rejects(session.start());
    assert.equal(session.status, "error");
    assert.equal(session.text, text);
    assert.equal(backend.messages.at(-1).message.method, "exit");
    assert.equal(session.initialized, false);
  }
  const session = new SourceSession({ ...doc, languageId: "python", fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(session.start(), /HTTP 503/);
  assert.equal(session.status, "error");
});

test("a late structure response cannot overwrite a newer document version", async () => {
  let release, requested;
  const waiting = new Promise(resolve => { requested = resolve; });
  const backend = server({ structure: async document => {
    const payload = fixture(document);
    if (document.version === 2) { requested(); await new Promise(resolve => { release = resolve; }); }
    return payload;
  } });
  const session = new SourceSession({ ...doc, languageId: "python", fetch: backend.fetch });
  await session.start();
  const seen = [];
  session.subscribe(state => { if (state.status === "ready") seen.push(state.version); });
  const first = session.update(text);
  await waiting;
  const second = session.update(text);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen, [1, 3]);
  assert.equal(session.version, 3);
  await session.close();
});

test("closing during initialize waits for the handshake and never opens a closed document", async () => {
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const backend = server();
  const fetch = async (url, init) => {
    const response = await backend.fetch(url, init);
    if (JSON.parse(init.body).method === "initialized") {
      reached();
      await new Promise(resolve => { release = resolve; });
    }
    return response;
  };
  const session = new SourceSession({ ...doc, languageId: "python", fetch });
  const starting = session.start();
  await waiting;
  const closing = session.close();
  assert.equal(session.status, "closed");
  release();
  await Promise.all([starting, closing]);
  assert.deepEqual(backend.messages.slice(1).map(item => item.message.method), ["initialize", "initialized", "shutdown", "exit"]);
  assert.equal(session.status, "closed");
});

test("file read failures are visible and a stale file read cannot replace a newer request", async () => {
  const oldDocument = globalThis.document;
  const inputs = [], snapshots = [];
  globalThis.document = { body: { append() {} }, createElement() {
    const input = { style: {}, handlers: {}, click() {}, removed: false,
      addEventListener(name, handler) { this.handlers[name] = handler; },
      remove() { this.removed = true; } };
    inputs.push(input);
    return input;
  } };
  client.start(value => snapshots.push(JSON.parse(value)));
  try {
    let release;
    client.openFile("python");
    inputs[0].files = [{ name: "slow.py", text: () => new Promise(resolve => { release = resolve; }) }];
    const pending = inputs[0].handlers.change();
    client.openFile("python");
    inputs[1].files = [{ name: "denied.py", text: async () => { throw new Error("File access denied"); } }];
    await inputs[1].handlers.change();
    assert.equal(snapshots.at(-1).status, "error");
    assert.match(snapshots.at(-1).message, /File access denied/);
    assert.equal(snapshots.at(-1).uri, "file:///denied.py");
    release("older content");
    await pending;
    assert.equal(snapshots.at(-1).uri, "file:///denied.py");
    assert.ok(inputs.every(input => input.removed));
    client.jump(-10, -10);
    client.jump(100, 100);
    assert.deepEqual(snapshots.at(-1).caret, { row: 0, col: 0 });
  } finally {
    await client.close();
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});
