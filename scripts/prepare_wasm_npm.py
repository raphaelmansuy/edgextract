#!/usr/bin/env python3
"""Set npm package metadata after wasm-pack build."""

from __future__ import annotations

import json
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "rust" / "edgextract-wasm" / "pkg" / "package.json"


def main() -> int:
    if not PKG.is_file():
        print(f"missing {PKG} — run wasm-pack first", file=sys.stderr)
        return 1
    data = json.loads(PKG.read_text())
    data["name"] = "@raphael.mansuy/edgextract"
    data["repository"] = {
        "type": "git",
        "url": "git+https://github.com/raphaelmansuy/edgextract.git",
    }
    data["homepage"] = "https://github.com/raphaelmansuy/edgextract"
    data["license"] = "Apache-2.0"
    data["description"] = "edgextract compiled to WebAssembly for the browser."
    PKG.write_text(json.dumps(data, indent=2) + "\n")
    print("npm package", data["name"], data.get("version"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
