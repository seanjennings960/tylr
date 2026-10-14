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
      if (result.error) throw new Error(typeof result.error.message === "string" ? result.error.message : "Language server error");
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
          capabilities: { general: { positionEncodings: ["utf-16"] }, experimental: { tylrStructure: { version: 1 } } } });
        requireValue((result.capabilities?.positionEncoding || "utf-16") === "utf-16", "Server must support UTF-16 positions");
        requireValue(result.capabilities?.experimental?.tylrStructure?.version === 1, "Server does not support tylr/structure version 1");
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

    async close() {
      if (this.closed) return;
      this.closed = true;
      this.generation += 1;
      this.status = "closed";
      this.message = "Document closed";
      this.structure = null;
      this.emit();
      // Wait for the handshake boundary before sending shutdown/exit, so an
      // in-flight initialized/didOpen cannot arrive after the session was freed.
      if (this.starting) await this.starting.catch(() => {});
      await this.queue.catch(() => {});
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
    if (!document) return { uri: "", source: "", status: "closed", message: "", focus_label: "",
      selection_label: "", selected_text: "", lines: [], caret: { row: 0, col: 0 },
      anchor: { row: 0, col: 0 }, has_selection: false };
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
      anchor: index.displayPosition(state.anchor), has_selection: state.selectionStart !== state.selectionEnd };
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
    return activeSession?.navigate(direction, { extend }) || false;
  }

  function jump(row, col, extend = false) {
    if (!activeSession) return;
    row = Math.max(0, Math.min(row, activeSession.index.lines.length - 1));
    col = Math.max(0, col);
    const offset = activeSession.index.displayOffset(row, col);
    activeSession.selectOffsets(extend ? activeSession.anchor : offset, offset);
  }

  function selectAll() {
    if (activeSession) activeSession.selectOffsets(0, activeSession.text.length);
  }

  async function close() {
    openGeneration += 1;
    const session = activeSession;
    activeSession = null;
    emitBridge();
    if (session) await session.close().catch(() => {});
  }

  return { sourceIndex, validateStructure, NavigationDocument, SourceSession, open, renderSnapshot,
    start, openText, openFile, command, jump, selectAll, close };
});
