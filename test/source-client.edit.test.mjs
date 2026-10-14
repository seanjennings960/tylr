import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { SourceSession, renderSnapshot, validateEditSnapshot } =
  createRequire(import.meta.url)("../src/web/source-client.js");

const source = { uri: "file:///original.txt", version: 1, text: "original" };
function structure(uri, version, text) {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } };
  return { uri, version, status: "ready", rootId: "root", diagnostics: [], tokens: ["leaf"], nodes: [
    { id: "root", range, label: "Document", role: "document", parentId: null, children: ["leaf"] },
    { id: "leaf", range, label: "Server node", role: "token", parentId: "root", children: [] },
  ] };
}
function presentation(revision = 0, text = "item") {
  return { editorId: "draft-1", revision, source: { uri: source.uri, version: source.version }, text,
    structure: structure("tylr-editor://draft-1", revision, text), selection: { nodeId: "leaf" },
    targets: [{ nodeId: "leaf", actions: [{ id: "opaque-command", label: "Server action",
      input: { label: "Server value", hint: "Server supplied hint" } }] }],
    complete: text !== "□", hint: "Canonical server draft" };
}
function backend(options = {}) {
  const messages = [];
  const starts = new Map();
  let draft;
  return {
    messages, get draft() { return draft; }, get allocatedDrafts() { return starts.size; },
    fetch: async (url, init) => {
      const message = JSON.parse(init.body);
      messages.push(message);
      if (url.endsWith("/session")) return { ok: true, status: 200, json: async () => ({ sessionId: "session-1" }) };
      let result = null, error;
      if (message.method === "initialize") result = { capabilities: { positionEncoding: "utf-16", experimental: {
        tylrStructure: { version: 1 }, tylrEdit: { version: 1, label: "Server draft mode", description: "Canonical draft, original retained" },
      } } };
      if (message.method === "tylr/structure") result = structure(source.uri, source.version, source.text);
      if (message.method === "tylr/edit/start") {
        assert.equal(typeof message.params.requestId, "string");
        if (!starts.has(message.params.requestId)) starts.set(message.params.requestId, presentation());
        draft = starts.get(message.params.requestId);
        result = options.start ? await options.start(structuredClone(draft)) : draft;
      }
      if (message.method === "tylr/edit/apply") {
        assert.equal(message.params.editorId, draft.editorId);
        assert.equal(message.params.baseRevision, draft.revision);
        assert.equal(message.params.targetId, "leaf");
        assert.equal(message.params.actionId, "opaque-command");
        if (options.reject) error = { code: -32602, message: "Rejected by server rule" };
        else {
          draft = presentation(draft.revision + 1, message.params.input);
          result = options.apply ? await options.apply(structuredClone(draft)) : draft;
        }
      }
      if (message.method === "tylr/edit/state") result = options.state ? await options.state(structuredClone(draft)) : draft;
      if (message.method === "tylr/edit/close") draft = null;
      const body = structuredClone({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) });
      return { ok: true, status: message.id ? 200 : 204, json: async () => body };
    },
  };
}
async function started(options) {
  const server = backend(options);
  const session = new SourceSession({ ...source, languageId: "configured-language", fetch: server.fetch });
  await session.start();
  assert.equal(await session.startEdit(), true);
  return { session, server };
}

test("draft validation rejects foreign versions, bad targets, malformed offers, and invalid selection", () => {
  const mutations = [
    value => { value.source.version += 1; }, value => { value.source.uri = "file:///other"; },
    value => { value.structure.version += 1; }, value => { value.structure.uri = "tylr-editor://other"; },
    value => { value.targets[0].nodeId = "missing"; }, value => { value.targets.push(value.targets[0]); },
    value => { value.targets[0].actions.push(value.targets[0].actions[0]); },
    value => { value.targets[0].actions[0].input.hint = false; },
    value => { value.selection.nodeId = "missing"; }, value => { value.complete = "true"; },
  ];
  for (const mutate of mutations) {
    const value = presentation();
    mutate(value);
    assert.throws(() => validateEditSnapshot(value, source));
  }
  assert.throws(() => validateEditSnapshot(presentation(), source, { revision: 1 }), /revision/);
  assert.throws(() => validateEditSnapshot(presentation(), source, { editorId: "other" }), /draft response/);
});

test("server-offered edits affect a separate draft and export only complete server text", async () => {
  const { session, server } = await started();
  assert.equal(session.text, source.text);
  assert.equal(session.version, 1);
  assert.equal(renderSnapshot(session).source, "item");
  assert.deepEqual(renderSnapshot(session).edit_actions, [{ id: "opaque-command", label: "Server action",
    input_label: "Server value", input_hint: "Server supplied hint" }]);
  session.draft.selectOffsets(0, 2);
  assert.deepEqual(renderSnapshot(session).edit_actions, []);
  assert.equal(await session.applyEdit("opaque-command", "ignored"), false);
  assert.equal(server.messages.filter(message => message.method === "tylr/edit/apply").length, 0);
  session.draft.selectOffsets(0, session.draft.text.length);
  assert.equal(await session.applyEdit("opaque-command", "□"), true);
  assert.equal(session.exportDraft(), null);
  assert.equal(renderSnapshot(session).edit_complete, false);
  await session.applyEdit("opaque-command", "finished");
  assert.deepEqual(session.exportDraft(), { name: "original.txt", text: "finished" });
  assert.throws(() => session.update("changed"), /Discard/);
  await session.discardEdit();
  assert.equal(renderSnapshot(session).source, source.text);
  assert.equal(renderSnapshot(session).editing, false);
  assert.equal(session.version, 1);
  assert.equal(server.messages.some(message => message.method === "textDocument/didChange"), false);
  await session.close();
});

test("a lost start response retries the same idempotency token without allocating another draft", async () => {
  let lost = true;
  const server = backend({ start: value => {
    if (lost) { lost = false; throw new Error("Start response lost"); }
    return value;
  } });
  const session = new SourceSession({ ...source, languageId: "configured-language", fetch: server.fetch });
  await session.start();
  assert.equal(await session.startEdit(), false);
  assert.equal(session.draft, null);
  assert.equal(await session.startEdit(), true);
  const requests = server.messages.filter(message => message.method === "tylr/edit/start");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.requestId, requests[1].params.requestId);
  assert.equal(server.allocatedDrafts, 1);
  assert.equal(session.editStartRequestId, null);
  await session.close();
});

test("lost or malformed apply replies resync the committed draft without retrying the mutation", async () => {
  for (const apply of [() => { throw new Error("Reply lost"); }, value => ({ ...value, revision: value.revision + 1 })]) {
    const { session, server } = await started({ apply });
    assert.equal(await session.applyEdit("opaque-command", "committed"), false);
    assert.equal(session.draft.version, 1);
    assert.equal(session.draft.text, "committed");
    assert.equal(session.editRecoverable, false);
    assert.equal(server.messages.filter(message => message.method === "tylr/edit/apply").length, 1);
    assert.equal(server.messages.filter(message => message.method === "tylr/edit/state").length, 1);
    assert.equal(session.text, source.text);
    await session.close();
  }
});

test("failed resync blocks mutation/export until explicit recovery succeeds", async () => {
  let unavailable = true;
  const { session, server } = await started({
    apply: () => { throw new Error("Reply lost"); },
    state: value => { if (unavailable) throw new Error("Offline"); return value; },
  });
  await session.applyEdit("opaque-command", "committed");
  assert.equal(session.draft.text, "item");
  assert.equal(session.editRecoverable, true);
  assert.equal(session.exportDraft(), null);
  await session.applyEdit("opaque-command", "must not send");
  assert.equal(server.messages.filter(message => message.method === "tylr/edit/apply").length, 1);
  unavailable = false;
  assert.equal(await session.recoverEdit(), true);
  assert.equal(session.draft.text, "committed");
  assert.equal(session.editRecoverable, false);
  await session.close();
});

test("an ambiguous mutation cannot be cleared by a state read preceding its commit", async () => {
  let delayed = true;
  const { session } = await started({
    apply: () => { throw new Error("Mutation outcome unknown"); },
    state: value => delayed ? presentation(0) : value,
  });
  await session.applyEdit("opaque-command", "eventually committed");
  assert.equal(session.editRecoverable, true);
  assert.equal(session.exportDraft(), null);
  assert.equal(await session.recoverEdit(), false);
  assert.equal(session.draft.version, 0);
  delayed = false;
  assert.equal(await session.recoverEdit(), true);
  assert.equal(session.draft.version, 1);
  assert.equal(session.draft.text, "eventually committed");
  assert.equal(session.editRecoverable, false);
  await session.close();
});

test("rejected actions retain the draft, selection and original source", async () => {
  const { session } = await started({ reject: true });
  await session.applyEdit("opaque-command", "bad value");
  assert.equal(session.draft.version, 0);
  assert.equal(session.draft.snapshot().selectedText, "item");
  assert.match(renderSnapshot(session).edit_hint, /Rejected by server rule/);
  assert.equal(session.text, source.text);
  await session.close();
});

test("a response arriving after discard cannot restore the discarded draft", async () => {
  let release, requested;
  const waiting = new Promise(resolve => { requested = resolve; });
  const { session } = await started({ apply: async value => {
    requested();
    await new Promise(resolve => { release = resolve; });
    return value;
  } });
  const pending = session.applyEdit("opaque-command", "late");
  await waiting;
  assert.equal(session.draft.text, "item", "no optimistic mutation");
  assert.equal(session.editBusy, true);
  await session.discardEdit();
  release();
  await pending;
  assert.equal(session.draft, null);
  assert.equal(renderSnapshot(session).source, source.text);
  await session.close();
});

test("recovery rejects stale revisions and same-revision text changes", async () => {
  let corrupt = false;
  const { session } = await started({ state: value => corrupt ? presentation(0, "other") : value });
  await session.applyEdit("opaque-command", "new");
  corrupt = true;
  assert.equal(await session.recoverEdit(), false);
  assert.equal(session.draft.text, "new");
  assert.equal(session.editRecoverable, true);
  await session.close();
  const other = await started({ state: () => presentation(0, "same revision, different text") });
  assert.equal(await other.session.recoverEdit(), false);
  assert.equal(other.session.draft.text, "item");
  await other.session.close();
});
