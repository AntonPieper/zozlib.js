#!/usr/bin/env python3
import argparse
import os
from http.server import SimpleHTTPRequestHandler, test  # type: ignore


class COIHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Inject the Cross-Origin Isolation headers
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--bind",
        "-b",
        metavar="ADDRESS",
        help="Specify alternate bind address [default: all interfaces]",
    )
    parser.add_argument(
        "--directory",
        "-d",
        default=os.getcwd(),
        help="Specify alternate directory [default: current directory]",
    )
    parser.add_argument(
        "port",
        action="store",
        default=8000,
        type=int,
        nargs="?",
        help="Specify alternate port [default: 8000]",
    )

    args = parser.parse_args()

    # The test() function from http.server handles the server loop and binding
    # similar to how 'python -m http.server' is implemented internally.
    test(
        HandlerClass=lambda *a, **k: COIHandler(*a, directory=args.directory, **k),
        port=args.port,
        bind=args.bind,
    )
