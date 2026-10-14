/* Language-neutral source navigation. Syntax and structure come from LSP. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TylrSource = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  function requireValue(condition, message) {
    if (!condition) throw new Error(message);
  }

  // JS offsets and LSP's negotiated UTF-16 positions use the same code units.
  // Keep each original line ending; splitting/joining would lose CRLF or EOF.
  function sourceIndex(text) {
    requireValue(typeof text === "string", "Source must be text");
    const lines = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\r" || text[i] === "\n") {
        const end = i;
        if (text[i] === "\r" && text[i + 1] === "\n") i += 1;
        lines.push({ start, end, next: i + 1 });
        start = i + 1;
      }
    }
    lines.push({ start, end: text.length, next: text.length });
    function boundary(offset) {
      if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
      const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
      return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
    }
    function offset(position) {
      requireValue(position && Number.isInteger(position.line) && Number.isInteger(position.character), "Invalid source position");
      const line = lines[position.line];
      requireValue(line && position.character >= 0 && position.character <= line.end - line.start, "Position outside source");
      const value = line.start + position.character;
      requireValue(boundary(value), "Position splits a Unicode character");
      return value;
    }
    function position(value) {
      requireValue(boundary(value), "Invalid source offset");
      // Offsets within CRLF display at the end of the preceding line.
      let low = 0, high = lines.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (lines[mid].start <= value) low = mid;
        else high = mid - 1;
      }
      return { line: low, character: Math.min(value, lines[low].end) - lines[low].start };
    }
    function displayPosition(value) {
      const pos = position(value);
      let col = 0;
      for (const char of text.slice(lines[pos.line].start, lines[pos.line].start + pos.character)) {
        col += char === "\t" ? 4 - col % 4 : 1;
      }
      return { row: pos.line, col };
    }
    function displayOffset(row, col) {
      requireValue(Number.isInteger(row) && lines[row] && Number.isFinite(col), "Invalid display position");
      const line = lines[row];
      let width = 0, value = line.start;
      for (const char of text.slice(line.start, line.end)) {
        const next = width + (char === "\t" ? 4 - width % 4 : 1);
        if (col < (width + next) / 2) break;
        width = next;
        value += char.length;
      }
      return value;
    }
    return { text, lines, boundary, offset, position, displayPosition, displayOffset };
  }

  function validateStructure(payload, document) {
    requireValue(payload && typeof payload === "object", "Missing structure response");
    requireValue(payload.uri === document.uri && payload.version === document.version, "Stale structure response");
    requireValue(payload.status === "ready" || payload.status === "unavailable", "Unknown structure status");
    requireValue(Array.isArray(payload.nodes) && Array.isArray(payload.tokens) && Array.isArray(payload.diagnostics), "Malformed structure response");
    const index = sourceIndex(document.text);
    for (const diagnostic of payload.diagnostics) {
      requireValue(diagnostic && typeof diagnostic.message === "string" && diagnostic.range, "Malformed diagnostic");
      requireValue(index.offset(diagnostic.range.start) <= index.offset(diagnostic.range.end), "Reversed diagnostic range");
    }
    if (payload.status === "unavailable") {
      requireValue(payload.rootId === null && payload.nodes.length === 0 && payload.tokens.length === 0, "Unavailable structure contains nodes");
      return { index, root: null, nodes: new Map(), tokens: [], diagnostics: payload.diagnostics, status: payload.status };
    }
    requireValue(typeof payload.rootId === "string", "Missing structure root");
    // Bound untrusted protocol data and avoid recursive traversals.
    requireValue(payload.nodes.length <= 200000, "Structure exceeds node limit");
    const nodes = new Map();
    for (const item of payload.nodes) {
      requireValue(item && typeof item.id === "string" && item.id.length > 0 && !nodes.has(item.id), "Duplicate or invalid node ID");
      requireValue(item.range && typeof item.label === "string" && ["document", "structure", "token"].includes(item.role), "Malformed structure node");
      requireValue(item.parentId === null || typeof item.parentId === "string", "Malformed parent ID");
      requireValue(Array.isArray(item.children) && item.children.every(id => typeof id === "string"), "Malformed child IDs");
      const start = index.offset(item.range.start), end = index.offset(item.range.end);
      requireValue(start <= end, "Reversed node range");
      requireValue(item.role !== "token" || (start < end && item.children.length === 0), "Invalid token node");
      nodes.set(item.id, { id: item.id, start, end, label: item.label, role: item.role, parentId: item.parentId, children: item.children.slice() });
    }
    const root = nodes.get(payload.rootId);
    requireValue(root && root.role === "document" && root.parentId === null && root.start === 0 && root.end === document.text.length, "Invalid document root");
    const seen = new Set(), pending = [root.id];
    while (pending.length) {
      const node = nodes.get(pending.pop());
      requireValue(!seen.has(node.id), "Cyclic or duplicated structure edge");
      seen.add(node.id);
      let end = node.start;
      for (const id of node.children) {
        const child = nodes.get(id);
        requireValue(child && child.parentId === node.id, "Inconsistent child/parent links");
        requireValue(child.role !== "document", "Nested document root");
        requireValue(child.start >= end && child.end <= node.end, "Overlapping or unordered children");
        end = child.end;
        pending.push(id);
      }
    }
    requireValue(seen.size === nodes.size, "Unreachable structure node");
    const tokenIds = new Set();
    let tokenEnd = 0;
    const tokens = payload.tokens.map(id => {
      const token = nodes.get(id);
      requireValue(token && token.role === "token" && !tokenIds.has(id), "Invalid token index");
      requireValue(token.start >= tokenEnd, "Overlapping or unordered tokens");
      tokenIds.add(id);
      tokenEnd = token.end;
      return token;
    });
    requireValue([...nodes.values()].filter(node => node.role === "token").length === tokens.length, "Incomplete token index");
    return { index, root, nodes, tokens, diagnostics: payload.diagnostics, status: payload.status };
  }

  class NavigationDocument {
    constructor({ uri, text, version = 1 }) {
      requireValue(typeof uri === "string" && uri.length > 0 && Number.isInteger(version), "Invalid source document");
      this.uri = uri;
      this.text = text;
      this.version = version;
      this.index = sourceIndex(text);
      this.structure = null;
      this.anchor = 0;
      this.focus = 0;
      this.activeId = null;
      this.status = "loading";
      this.message = "Loading document structure…";
      this.listeners = new Set();
    }

    subscribe(listener) {
      this.listeners.add(listener);
      listener(this.snapshot());
      return () => this.listeners.delete(listener);
    }

    emit() {
      const state = this.snapshot();
      for (const listener of this.listeners) listener(state);
    }

    setStructure(payload) {
      this.structure = validateStructure(payload, this);
      this.index = this.structure.index;
      this.activeId = null;
      this.status = this.structure.status;
      this.message = this.status === "ready" ? "Structure ready" :
        (this.structure.diagnostics[0]?.message || "Structure unavailable for this document");
      this.emit();
    }

    nodeAt(offset) {
      if (!this.structure?.root) return null;
      // At a token edge prefer the token beginning there, then the one ending there.
      const token = this.structure.tokens.find(item => item.start <= offset && offset < item.end) ||
        this.structure.tokens.find(item => item.end === offset);
      if (token) return token;
      let node = this.structure.root;
      for (;;) {
        const child = node.children.map(id => this.structure.nodes.get(id)).find(item => item.start <= offset && offset < item.end);
        if (!child) return node;
        node = child;
      }
    }

    selectOffsets(anchor, focus) {
      requireValue(this.index.boundary(anchor) && this.index.boundary(focus), "Invalid selection boundary");
      this.anchor = anchor;
      this.focus = focus;
      this.activeId = this.nodeAt(focus)?.id || null;
      this.emit();
    }

    navigate(direction, { extend = false } = {}) {
      if (this.status !== "ready" || !this.structure?.root) return false;
      const { nodes, tokens } = this.structure;
      const current = nodes.get(this.activeId);
      let target = null;
      if (direction === "prevToken" || direction === "nextToken") {
        const forward = direction === "nextToken";
        if (current?.role === "token") {
          target = tokens[tokens.findIndex(token => token.id === current.id) + (forward ? 1 : -1)];
        } else if (forward) {
          const edge = current ? current.end : this.focus;
          target = tokens.find(token => token.start >= edge);
        } else {
          const edge = current ? current.start : this.focus;
          target = tokens.findLast(token => token.end <= edge);
        }
      } else {
        const node = current || this.nodeAt(this.focus);
        if (direction === "parent") target = nodes.get(node?.parentId);
        else if (direction === "firstChild") target = nodes.get(node?.children[0]);
        else if (direction === "prevSibling" || direction === "nextSibling") {
          const siblings = nodes.get(node?.parentId)?.children || [];
          const offset = siblings.indexOf(node?.id) + (direction === "nextSibling" ? 1 : -1);
          target = nodes.get(siblings[offset]);
        } else throw new Error("Unknown navigation command");
      }
      if (!target) return false;
      this.activeId = target.id;
      const backward = direction === "prevToken" || direction === "prevSibling";
      if (!extend) this.anchor = target.start;
      this.focus = extend && backward ? target.start : target.end;
      this.emit();
      return true;
    }

    snapshot() {
      const start = Math.min(this.anchor, this.focus), end = Math.max(this.anchor, this.focus);
      return { uri: this.uri, text: this.text, version: this.version, status: this.status,
        message: this.message, activeId: this.activeId, anchor: this.anchor, focus: this.focus,
        selectionStart: start, selectionEnd: end, selectedText: this.text.slice(start, end),
        diagnostics: this.structure?.diagnostics || [] };
    }
  }

  // A draft is a server-owned editing state with a generic text presentation.
  // Never parse its presentation or write it into the original LSP document.
  function validateEditSnapshot(payload, source, expected = {}) {
    requireValue(payload && typeof payload.editorId === "string" && payload.editorId.length > 0, "Invalid draft ID");
    requireValue(Number.isInteger(payload.revision) && payload.revision >= 0 && payload.revision < 2 ** 31, "Invalid draft revision");
    requireValue(payload.source?.uri === source.uri && payload.source?.version === source.version, "Draft belongs to another source version");
    requireValue(typeof payload.text === "string" && typeof payload.complete === "boolean" && typeof payload.hint === "string", "Malformed draft presentation");
    if (expected.editorId !== undefined) requireValue(payload.editorId === expected.editorId, "Mismatched draft response");
    if (expected.revision !== undefined) requireValue(payload.revision === expected.revision, "Unexpected draft revision");
    if (expected.minRevision !== undefined) requireValue(payload.revision >= expected.minRevision, "Stale draft response");
    const draft = new NavigationDocument({ uri: "tylr-editor://" + payload.editorId, text: payload.text, version: payload.revision });
    draft.setStructure(payload.structure);
    requireValue(draft.status === "ready", "Draft structure is unavailable");
    requireValue(Array.isArray(payload.targets), "Missing draft targets");
    draft.targets = new Map();
    for (const target of payload.targets) {
      requireValue(target && typeof target.nodeId === "string" && draft.structure.nodes.has(target.nodeId) && !draft.targets.has(target.nodeId), "Invalid or duplicate draft target");
      requireValue(Array.isArray(target.actions), "Invalid draft actions");
      const ids = new Set();
      const actions = target.actions.map(action => {
        requireValue(action && typeof action.id === "string" && action.id.length > 0 && !ids.has(action.id) && typeof action.label === "string", "Invalid or duplicate draft action");
        ids.add(action.id);
        if (action.input !== undefined) requireValue(action.input && typeof action.input.label === "string" && typeof action.input.hint === "string", "Invalid draft input description");
        return { id: action.id, label: action.label,
          ...(action.input === undefined ? {} : { input: { label: action.input.label, hint: action.input.hint } }) };
      });
      draft.targets.set(target.nodeId, actions);
    }
    const selected = draft.structure.nodes.get(payload.selection?.nodeId);
    requireValue(selected, "Invalid draft selection");
    draft.editorId = payload.editorId;
    draft.complete = payload.complete;
    draft.hint = payload.hint;
    draft.activeId = selected.id;
    draft.anchor = selected.start;
    draft.focus = selected.end;
    return draft;
  }

  function selectedEditTarget(draft) {
    if (!draft) return null;
    const start = Math.min(draft.anchor, draft.focus), end = Math.max(draft.anchor, draft.focus);
    const exact = id => {
      const node = draft.structure.nodes.get(id);
      return node && node.start === start && node.end === end;
    };
    if (draft.targets.has(draft.activeId) && exact(draft.activeId)) return draft.activeId;
    const matches = [...draft.targets.keys()].filter(exact);
    return matches.length === 1 ? matches[0] : null;
  }

  class SourceSession extends NavigationDocument {
    constructor({ endpoint = "", languageId, fetch: fetcher, ...document }) {
      super(document);
      requireValue(typeof languageId === "string" && languageId.length > 0, "Missing language ID");
      const transport = fetcher === undefined ? globalThis.fetch : fetcher;
      requireValue(typeof transport === "function", "HTTP transport is unavailable");
      this.endpoint = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
      this.languageId = languageId;
      // Native Window.fetch requires its Window receiver. Keep injected
      // transports untouched, but do not call the browser method as a session.
      this.fetcher = fetcher === undefined ? transport.bind(globalThis) : transport;
      this.sessionId = null;
      this.sequence = 0;
      this.generation = 0;
      this.closed = false;
      this.initialized = false;
      this.serverReady = false;
      this.starting = null;
      this.ending = null;
      this.queue = Promise.resolve();
      this.editCapability = null;
      this.draft = null;
      this.editBusy = false;
      this.editRecoverable = false;
      this.editRecoveryMinRevision = 0;
      this.editMessage = "";
      this.editEpoch = 0;
      this.editPending = Promise.resolve();
      this.editStartRequestId = null;
      this.editStartSequence = 0;
    }

    async post(path, body) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15000);
      try {
        const response = await this.fetcher(this.endpoint + path, {
          method: "POST", headers: { "Content-Type": "application/json",
            ...(this.sessionId ? { "X-Tylr-Session": this.sessionId } : {}) },
          body: JSON.stringify(body), signal: abort.signal,
        });
        requireValue(response.ok, "Language server HTTP " + response.status);
        return response.status === 204 ? null : await response.json();
      } finally { clearTimeout(timer); }
    }

    async rpc(method, params, notification = false) {
      const id = notification ? undefined : ++this.sequence;
      const result = await this.post("/rpc", { jsonrpc: "2.0", ...(notification ? {} : { id }), method, params });
      if (notification) return;
      requireValue(result && result.jsonrpc === "2.0" && result.id === id, "Mismatched JSON-RPC response");
      if (result.error) {
        const error = new Error(typeof result.error.message === "string" ? result.error.message : "Language server error");
        error.rpcCode = result.error.code;
        throw error;
      }
      requireValue(Object.prototype.hasOwnProperty.call(result, "result"), "Missing JSON-RPC result");
      return result.result;
    }

    fail(error) {
      if (this.closed) return;
      this.status = "error";
      this.message = error.name === "AbortError" ? "Language server timed out" : error.message;
      this.structure = null;
      this.activeId = null;
      this.emit();
    }

    start() {
      requireValue(!this.closed && !this.starting, "Session already started or closed");
      this.starting = this.initialize();
      return this.starting;
    }

    async initialize() {
      this.status = "connecting";
      this.message = "Connecting to language server…";
      this.emit();
      try {
        const session = await this.post("/session", {});
        requireValue(session && typeof session.sessionId === "string" && session.sessionId.length > 0, "Invalid language server session");
        this.sessionId = session.sessionId;
        if (this.closed) return this;
        const result = await this.rpc("initialize", { processId: null,
          clientInfo: { name: "tylr-source", version: "1" }, rootUri: null,
          capabilities: { general: { positionEncodings: ["utf-16"] }, experimental: { tylrStructure: { version: 1 }, tylrEdit: { version: 1 } } } });
        requireValue((result.capabilities?.positionEncoding || "utf-16") === "utf-16", "Server must support UTF-16 positions");
        requireValue(result.capabilities?.experimental?.tylrStructure?.version === 1, "Server does not support tylr/structure version 1");
        const edit = result.capabilities?.experimental?.tylrEdit;
        if (edit?.version === 1 && typeof edit.label === "string" && typeof edit.description === "string") {
          this.editCapability = { label: edit.label, description: edit.description };
        }
        if (this.closed) return this;
        await this.rpc("initialized", {}, true);
        this.serverReady = true;
        if (this.closed) return this;
        await this.rpc("textDocument/didOpen", { textDocument: {
          uri: this.uri, languageId: this.languageId, version: this.version, text: this.text,
        } }, true);
        this.initialized = true;
        if (this.closed) return this;
        await this.refresh(this.generation);
        return this;
      } catch (error) {
        this.fail(error);
        await this.endSession().catch(() => {});
        throw error;
      }
    }

    async refresh(generation) {
      const document = { uri: this.uri, version: this.version };
      const sessionId = this.sessionId;
      const payload = await this.rpc("tylr/structure", { textDocument: document });
      // An older request must never replace the structure for newer source.
      if (this.closed || generation !== this.generation || sessionId !== this.sessionId) return;
      this.setStructure(payload);
    }

    update(text) {
      requireValue(this.initialized && !this.closed, "Session is not open");
      requireValue(!this.draft && !this.editBusy, "Discard the draft before changing its source document");
      this.editStartRequestId = null;
      this.text = text;
      this.index = sourceIndex(text);
      this.version += 1;
      const version = this.version, generation = ++this.generation;
      this.structure = null;
      this.activeId = null;
      this.anchor = this.focus = 0;
      this.status = "loading";
      this.message = "Refreshing document structure…";
      this.emit();
      const work = async () => {
        if (this.closed) return;
        await this.rpc("textDocument/didChange", { textDocument: { uri: this.uri, version }, contentChanges: [{ text }] }, true);
        // More recent queued changes need no intermediate structure response.
        if (generation === this.generation) await this.refresh(generation);
      };
      this.queue = this.queue.then(work, work).catch(error => {
        if (generation === this.generation) this.fail(error);
        throw error;
      });
      return this.queue;
    }

    currentDocument() { return this.draft || this; }

    editCurrent(epoch) { return !this.closed && epoch === this.editEpoch; }

    adoptDraft(draft, preserveSelection = false) {
      const previous = this.draft;
      if (preserveSelection && previous?.editorId === draft.editorId && previous.version === draft.version) {
        requireValue(previous.text === draft.text, "Draft text changed without a new revision");
        draft.anchor = previous.anchor;
        draft.focus = previous.focus;
        draft.activeId = draft.structure.nodes.has(previous.activeId) ? previous.activeId : null;
      }
      this.draft = draft;
      draft.subscribe(() => { if (this.draft === draft) this.emit(); });
    }

    startEdit() {
      if (!this.editCapability || this.status !== "ready" || this.closed || this.draft || this.editBusy) return Promise.resolve(false);
      const epoch = ++this.editEpoch;
      this.editBusy = true;
      this.editRecoverable = false;
      this.editRecoveryMinRevision = 0;
      this.editMessage = "Starting draft…";
      const requestId = this.editStartRequestId || "start:" + (++this.editStartSequence);
      this.editStartRequestId = requestId;
      this.emit();
      this.editPending = (async () => {
        let payload;
        try {
          payload = await this.rpc("tylr/edit/start", { textDocument: { uri: this.uri, version: this.version }, requestId });
          const draft = validateEditSnapshot(payload, this, { revision: 0 });
          if (!this.editCurrent(epoch)) {
            await this.rpc("tylr/edit/close", { editorId: draft.editorId }).catch(() => {});
            return false;
          }
          this.adoptDraft(draft);
          this.editStartRequestId = null;
          this.editMessage = "";
          return true;
        } catch (error) {
          if (payload?.editorId && typeof payload.editorId === "string") {
            await this.rpc("tylr/edit/close", { editorId: payload.editorId }).catch(() => {});
            if (this.editStartRequestId === requestId) this.editStartRequestId = null;
          }
          if (this.editCurrent(epoch)) this.editMessage = error.message;
          return false;
        } finally {
          if (this.editCurrent(epoch)) { this.editBusy = false; this.emit(); }
        }
      })();
      return this.editPending;
    }

    async readDraft(epoch, reason = "") {
      const previous = this.draft;
      if (!previous) return false;
      try {
        const payload = await this.rpc("tylr/edit/state", { editorId: previous.editorId });
        const draft = validateEditSnapshot(payload, this, {
          editorId: previous.editorId, minRevision: Math.max(previous.version, this.editRecoveryMinRevision),
        });
        if (!this.editCurrent(epoch)) return false;
        this.adoptDraft(draft, true);
        this.editRecoverable = false;
        this.editRecoveryMinRevision = 0;
        this.editMessage = reason ? reason + " Server draft refreshed." : "";
        return true;
      } catch (error) {
        if (this.editCurrent(epoch)) {
          this.editRecoverable = true;
          this.editMessage = "Cannot verify the draft state: " + error.message + ". Recover or discard the draft before editing.";
        }
        return false;
      }
    }

    applyEdit(actionId, input = "") {
      const current = this.draft;
      if (!current || this.closed || this.editBusy || this.editRecoverable) return Promise.resolve(false);
      const targetId = selectedEditTarget(current);
      const action = current.targets.get(targetId)?.find(item => item.id === actionId);
      if (!action) {
        this.editMessage = "Select exactly one editable node and use an offered action.";
        this.emit();
        return Promise.resolve(false);
      }
      if (action.input && typeof input !== "string") return Promise.resolve(false);
      const epoch = this.editEpoch;
      this.editBusy = true;
      this.editMessage = "Applying edit…";
      this.emit();
      this.editPending = (async () => {
        try {
          const payload = await this.rpc("tylr/edit/apply", { editorId: current.editorId,
            baseRevision: current.version, targetId, actionId,
            ...(action.input ? { input } : {}) });
          const draft = validateEditSnapshot(payload, this, { editorId: current.editorId, revision: current.version + 1 });
          if (!this.editCurrent(epoch)) return false;
          this.adoptDraft(draft);
          this.editMessage = "";
          return true;
        } catch (error) {
          // The server may have committed before a transport/validation failure.
          // Read its authoritative state; never retry the mutating request.
          if (this.editCurrent(epoch)) {
            // An old state read can arrive before a delayed mutating request.
            // Only an explicit precommit rejection makes the old revision safe.
            const rejected = error.rpcCode === -32602 || error.rpcCode === -32801;
            this.editRecoveryMinRevision = current.version + (rejected ? 0 : 1);
            await this.readDraft(epoch, error.message);
          }
          return false;
        } finally {
          if (this.editCurrent(epoch)) { this.editBusy = false; this.emit(); }
        }
      })();
      return this.editPending;
    }

    recoverEdit() {
      if (!this.draft || this.closed || this.editBusy) return Promise.resolve(false);
      const epoch = this.editEpoch;
      this.editBusy = true;
      this.editMessage = "Recovering server draft…";
      this.emit();
      this.editPending = this.readDraft(epoch).finally(() => {
        if (this.editCurrent(epoch)) { this.editBusy = false; this.emit(); }
      });
      return this.editPending;
    }

    async discardEdit() {
      const draft = this.draft;
      this.editEpoch += 1;
      this.draft = null;
      this.editBusy = false;
      this.editRecoverable = false;
      this.editRecoveryMinRevision = 0;
      this.editMessage = "";
      this.emit();
      if (draft) await this.rpc("tylr/edit/close", { editorId: draft.editorId }).catch(() => {});
    }

    exportDraft() {
      if (!this.draft?.complete || this.editBusy || this.editRecoverable || this.closed) return null;
      let name = "draft.txt";
      try { name = decodeURIComponent(new URL(this.uri).pathname.split("/").at(-1)) || name; } catch (_) { /* Generic fallback name. */ }
      return { name, text: this.draft.text };
    }

    async close() {
      if (this.closed) return;
      this.closed = true;
      this.generation += 1;
      this.editEpoch += 1;
      this.draft = null;
      this.editBusy = false;
      this.status = "closed";
      this.message = "Document closed";
      this.structure = null;
      this.emit();
      // Wait for the handshake boundary before sending shutdown/exit, so an
      // in-flight initialized/didOpen cannot arrive after the session was freed.
      if (this.starting) await this.starting.catch(() => {});
      await this.queue.catch(() => {});
      await this.editPending.catch(() => {});
      await this.endSession();
    }

    endSession() {
      if (!this.sessionId) return Promise.resolve();
      if (!this.ending) this.ending = (async () => {
        try {
          if (this.initialized) await this.rpc("textDocument/didClose", { textDocument: { uri: this.uri } }, true);
          if (this.serverReady) await this.rpc("shutdown", null);
        } finally {
          try { await this.rpc("exit", {}, true); }
          finally { this.initialized = false; this.serverReady = false; }
        }
      })();
      return this.ending;
    }
  }

  async function open(options) {
    const session = new SourceSession(options);
    await session.start();
    return session;
  }

  // The adapter feeds the existing Reason model and SVG/text rendering pipeline.
  // It creates no editor DOM and never rewrites the source into pretty-printed text.
  function renderSnapshot(document) {
    const owner = document instanceof SourceSession ? document : null;
    const draft = owner?.draft;
    const targetId = selectedEditTarget(draft);
    const edit = { editing: !!draft,
      edit_available: !!owner?.editCapability && owner.status === "ready" && !owner.closed && !draft,
      edit_label: owner?.editCapability?.label || "",
      edit_hint: owner?.editMessage || draft?.hint || owner?.editCapability?.description || "",
      edit_actions: (draft?.targets.get(targetId) || []).map(action => ({
        id: action.id, label: action.label, input_label: action.input?.label || "", input_hint: action.input?.hint || "",
      })), edit_complete: draft?.complete || false, edit_busy: owner?.editBusy || false,
      edit_recoverable: owner?.editRecoverable || false };
    document = draft || document;
    if (!document) return { uri: "", source: "", status: "closed", message: "", focus_label: "",
      selection_label: "", selected_text: "", lines: [], caret: { row: 0, col: 0 },
      anchor: { row: 0, col: 0 }, has_selection: false, ...edit };
    const state = document.snapshot(), index = document.index;
    const active = document.structure?.nodes.get(document.activeId);
    const tokens = document.structure?.tokens || [];
    let tokenCursor = 0;
    const lines = index.lines.map(line => {
      while (tokenCursor < tokens.length && tokens[tokenCursor].end <= line.start) tokenCursor += 1;
      const lineTokens = [];
      for (let i = tokenCursor; i < tokens.length && tokens[i].start < line.end; i += 1) lineTokens.push(tokens[i]);
      const edges = new Set([line.start, line.end]);
      for (const range of [...lineTokens, active, { start: state.selectionStart, end: state.selectionEnd }]) {
        if (!range) continue;
        if (range.start > line.start && range.start < line.end) edges.add(range.start);
        if (range.end > line.start && range.end < line.end) edges.add(range.end);
      }
      const boundaries = [...edges].sort((a, b) => a - b), segments = [];
      let col = 0, tokenIndex = 0;
      for (let i = 0; i < boundaries.length - 1; i += 1) {
        const start = boundaries[i], end = boundaries[i + 1], text = document.text.slice(start, end);
        const firstCol = col;
        for (const char of text) col += char === "\t" ? 4 - col % 4 : 1;
        while (tokenIndex < lineTokens.length && lineTokens[tokenIndex].end <= start) tokenIndex += 1;
        const token = lineTokens[tokenIndex];
        segments.push({ text, start, col: firstCol, width: col - firstCol,
          selected: start >= state.selectionStart && end <= state.selectionEnd && state.selectionStart !== state.selectionEnd,
          active: !!active && start >= active.start && end <= active.end,
          role: token && start >= token.start && end <= token.end ? "token" : "" });
      }
      if (segments.length === 0) segments.push({ text: "", start: line.start, col: 0, width: 0, selected: false, active: false, role: "" });
      return { segments };
    });
    const a = index.position(state.selectionStart), b = index.position(state.selectionEnd);
    return { uri: state.uri, source: state.text, status: state.status, message: state.message,
      focus_label: active?.label || "", selection_label: (a.line + 1) + ":" + (a.character + 1) + "–" + (b.line + 1) + ":" + (b.character + 1),
      selected_text: state.selectedText, lines, caret: index.displayPosition(state.focus),
      anchor: index.displayPosition(state.anchor), has_selection: state.selectionStart !== state.selectionEnd, ...edit };
  }

  let activeSession = null, callback = null, openGeneration = 0;
  function emitBridge() {
    if (callback) callback(JSON.stringify(renderSnapshot(activeSession)));
  }

  function start(listener) {
    requireValue(typeof listener === "function", "Missing source snapshot listener");
    callback = listener;
    if (activeSession) emitBridge();
  }

  function activateSession(session) {
    const previous = activeSession;
    activeSession = session;
    session.subscribe(() => { if (activeSession === session) emitBridge(); });
    if (previous) previous.close().catch(() => {});
  }

  async function openText(options) {
    const session = new SourceSession(options);
    openGeneration += 1;
    activateSession(session);
    // The session emits a visible error before rejecting. Keep that state in the UI.
    try { await session.start(); } catch (_) { /* Visible in the source pane. */ }
    return session;
  }

  function openFile(languageId) {
    requireValue(typeof document !== "undefined", "File picker requires a browser");
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      const generation = ++openGeneration;
      const uri = "file:///" + encodeURIComponent(file?.name || "source");
      try {
        if (file) {
          const text = await file.text();
          if (generation === openGeneration) await openText({ languageId, uri, text });
        }
      } catch (error) {
        if (generation === openGeneration) {
          const failed = new SourceSession({ languageId: languageId || "unknown", uri, text: "" });
          activateSession(failed);
          failed.fail(new Error("Could not open source file: " + (error?.message || String(error))));
        }
      } finally { input.remove(); }
    }, { once: true });
    document.body.append(input);
    input.click();
  }

  function command(direction, extend = false) {
    if (activeSession?.editBusy) return false;
    return activeSession?.currentDocument().navigate(direction, { extend }) || false;
  }

  function jump(row, col, extend = false) {
    if (!activeSession || activeSession.editBusy) return;
    const document = activeSession.currentDocument();
    row = Math.max(0, Math.min(row, document.index.lines.length - 1));
    col = Math.max(0, col);
    const offset = document.index.displayOffset(row, col);
    document.selectOffsets(extend ? document.anchor : offset, offset);
  }

  function selectAll() {
    if (activeSession && !activeSession.editBusy) {
      const document = activeSession.currentDocument();
      document.selectOffsets(0, document.text.length);
    }
  }

  function startEdit() { return activeSession?.startEdit(); }
  function applyEdit(actionId, input) { return activeSession?.applyEdit(actionId, input); }
  function discardEdit() { return activeSession?.discardEdit(); }
  function recoverEdit() { return activeSession?.recoverEdit(); }
  function exportEdit() {
    const exported = activeSession?.exportDraft();
    if (!exported || typeof document === "undefined") return exported;
    try {
      const link = document.createElement("a");
      const url = URL.createObjectURL(new Blob([exported.text], { type: "text/plain;charset=utf-8" }));
      link.href = url;
      link.download = exported.name;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
    } catch (error) {
      activeSession.editMessage = "Could not export draft: " + error.message;
      activeSession.emit();
    }
    return exported;
  }

  async function close() {
    openGeneration += 1;
    const session = activeSession;
    activeSession = null;
    emitBridge();
    if (session) await session.close().catch(() => {});
  }

  return { sourceIndex, validateStructure, validateEditSnapshot, selectedEditTarget, NavigationDocument, SourceSession, open, renderSnapshot,
    start, openText, openFile, command, jump, selectAll, close, startEdit, applyEdit, discardEdit, recoverEdit, exportEdit };
});
