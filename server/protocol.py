"""JSON-RPC/LSP lifecycle and versioned document ownership; no file execution."""

import logging
from urllib.parse import urlsplit

from .edit_service import EditError, EditService
from .structure import snapshot


EDIT_REQUESTS = {"tylr/edit/start", "tylr/edit/apply", "tylr/edit/state", "tylr/edit/close"}


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, message):
    if not condition:
        raise RpcError(-32602, message)


def document_id(value):
    require(isinstance(value, dict), "textDocument must be an object")
    uri, version = value.get("uri"), value.get("version")
    require(isinstance(uri, str) and bool(uri), "uri must be an absolute document URI")
    try:
        require(bool(urlsplit(uri).scheme), "uri must be an absolute document URI")
    except ValueError as error:
        raise RpcError(-32602, "invalid document URI") from error
    require(type(version) is int and -(2**31) <= version < 2**31, "version must be an integer")
    return uri, version


def source_text(value):
    require(isinstance(value, str), "text must be a string")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise RpcError(-32602, "text must contain valid Unicode") from error
    return value


class LanguageServer:
    def __init__(self):
        self.state = "new"
        self.documents = {}
        self.edits = EditService()
        self.exited = False
        self.exit_code = 1

    def dispatch(self, message):
        """Return a JSON-RPC response or None for a notification."""
        request_id = message.get("id") if isinstance(message, dict) else None
        is_request = isinstance(message, dict) and "id" in message
        try:
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
                raise RpcError(-32600, "Invalid Request")
            if is_request and (type(request_id) not in (int, str)):
                raise RpcError(-32600, "request id must be an integer or string")
            method = message["method"]
            params = message.get("params", {})
            if params is None and method in {"shutdown", "exit", "initialized"}:
                params = {}
            require(isinstance(params, dict), "params must be an object")
            if is_request and method in {"initialized", "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose", "exit", "$/cancelRequest"}:
                raise RpcError(-32600, "method is a notification")
            if not is_request and method in {"initialize", "shutdown", "tylr/structure"} | EDIT_REQUESTS:
                return None
            result = self.handle(method, params)
            return {"jsonrpc": "2.0", "id": request_id, "result": result} if is_request else None
        except (RpcError, EditError) as error:
            if not is_request and isinstance(message, dict) and isinstance(message.get("method"), str):
                logging.warning("Ignored %s notification: %s", message["method"], error)
                return None
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": error.code, "message": str(error)}}
        except Exception:
            logging.exception("Language-server request failed")
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": "Internal error"}} if is_request else None

    def handle(self, method, params):
        if method == "exit":
            self.exit_code = 0 if self.state == "shutdown" else 1
            self.exited = True
            self.documents.clear()
            self.edits.clear()
            return None
        if self.exited or self.state == "shutdown":
            raise RpcError(-32600, "server is shut down")
        if method == "initialize":
            require(self.state == "new", "server is already initialized")
            require(isinstance(params.get("capabilities", {}), dict), "capabilities must be an object")
            self.state = "initializing"
            return {"capabilities": {
                "positionEncoding": "utf-16",
                "textDocumentSync": {"openClose": True, "change": 1},
                "experimental": {
                    "tylrStructure": {"version": 1},
                    "tylrEdit": {"version": 1, "label": "Edit expression draft",
                                 "description": "Edit a small expression subset in a separate, canonically formatted draft."},
                },
            }, "serverInfo": {"name": "tylr-python", "version": "0.2.0"}}
        if method == "initialized" and self.state == "initializing":
            self.state = "ready"
            return None
        if self.state != "ready":
            raise RpcError(-32002, "Server not initialized")
        if method == "shutdown":
            self.state = "shutdown"
            self.edits.clear()
            return None
        if method == "$/cancelRequest":
            return None  # Requests are processed synchronously in each session.
        if method in EDIT_REQUESTS:
            if method == "tylr/edit/start":
                uri, version = document_id(params.get("textDocument"))
                require(uri in self.documents, "document is not open")
                actual_version, text = self.documents[uri]
                if version != actual_version:
                    raise RpcError(-32801, "Content modified: document version does not match")
                return self.edits.start(uri, version, text, params.get("requestId"))
            if method == "tylr/edit/apply":
                return self.edits.apply(params)
            if method == "tylr/edit/state":
                return self.edits.read(params)
            return self.edits.close(params)
        if method == "textDocument/didOpen":
            document = params.get("textDocument")
            uri, version = document_id(document)
            require(uri not in self.documents, "document is already open")
            require(document.get("languageId") == "python", "this server supports languageId python")
            self.documents[uri] = (version, source_text(document.get("text")))
            return None
        if method == "textDocument/didChange":
            uri, version = document_id(params.get("textDocument"))
            require(uri in self.documents, "document is not open")
            require(version > self.documents[uri][0], "document version must increase")
            changes = params.get("contentChanges")
            require(isinstance(changes, list) and bool(changes), "contentChanges must not be empty")
            for change in changes:
                require(isinstance(change, dict) and set(change) == {"text"}, "full text synchronization is required")
                text = source_text(change["text"])
            self.documents[uri] = (version, text)
            self.edits.close_document(uri)
            return None
        if method == "textDocument/didClose":
            document = params.get("textDocument")
            require(isinstance(document, dict) and isinstance(document.get("uri"), str), "textDocument.uri is required")
            self.documents.pop(document["uri"], None)
            self.edits.close_document(document["uri"])
            return None
        if method == "tylr/structure":
            uri, version = document_id(params.get("textDocument"))
            require(uri in self.documents, "document is not open")
            actual_version, text = self.documents[uri]
            if version != actual_version:
                raise RpcError(-32801, "Content modified: document version does not match")
            return snapshot(uri, version, text)
        raise RpcError(-32601, "Method not found")
