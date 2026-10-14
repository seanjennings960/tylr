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

  return { sourceIndex, validateStructure, NavigationDocument };
});
