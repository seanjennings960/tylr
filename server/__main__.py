"""Run the navigation server using stdio or the local browser bridge."""

import argparse
import sys

from .http import NavigationHTTPServer
from .stdio import serve_stdio


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    transport = parser.add_mutually_exclusive_group()
    transport.add_argument("--stdio", action="store_true", help="LSP over stdin/stdout (default)")
    transport.add_argument("--http", action="store_true", help="local browser JSON-RPC bridge")
    parser.add_argument("--port", type=int, default=8765, help="loopback HTTP port")
    parser.add_argument("--www", help="serve the built editor from this directory over HTTP")
    args = parser.parse_args()
    if not args.http:
        return serve_stdio(sys.stdin.buffer, sys.stdout.buffer)
    with NavigationHTTPServer(args.port, args.www) as server:
        print(f"tylr language server: http://127.0.0.1:{server.server_port}", file=sys.stderr)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
