"""LSP Content-Length framing over binary streams."""

import json

from .protocol import LanguageServer


MAX_MESSAGE_BYTES = 2 * 1024 * 1024


def parse_error(message="Parse error"):
    return {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": message}}


def read_frame(stream):
    length = None
    header_size = 0
    while True:
        line = stream.readline(8193)
        if not line and header_size == 0:
            return None
        header_size += len(line)
        if not line or header_size > 8192 or not line.endswith(b"\r\n"):
            raise ValueError("invalid LSP header")
        if line == b"\r\n":
            break
        key, separator, value = line.partition(b":")
        if not separator:
            raise ValueError("invalid LSP header")
        if key.lower() == b"content-length":
            if length is not None:
                raise ValueError("duplicate Content-Length")
            length = int(value.strip())
    if length is None or not 0 <= length <= MAX_MESSAGE_BYTES:
        raise ValueError("invalid Content-Length")
    parts = []
    remaining = length
    while remaining:
        part = stream.read(remaining)
        if not part:
            raise ValueError("truncated LSP message")
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


def write_frame(stream, message):
    body = json.dumps(message, separators=(",", ":")).encode("utf-8")
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
    stream.flush()


def serve_stdio(input_stream, output_stream):
    server = LanguageServer()
    while not server.exited:
        try:
            body = read_frame(input_stream)
        except ValueError as error:
            write_frame(output_stream, parse_error(str(error)))
            return 1
        if body is None:
            break
        try:
            message = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeError):
            write_frame(output_stream, parse_error())
            continue
        response = server.dispatch(message)
        if response is not None:
            write_frame(output_stream, response)
    return server.exit_code
