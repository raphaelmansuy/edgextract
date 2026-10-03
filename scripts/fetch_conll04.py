#!/usr/bin/env python3
"""Download the SpERT CoNLL04 split into data/benchmarks/conll04/."""

from __future__ import annotations

import urllib.request
from pathlib import Path

BASE = "http://lavis.cs.hs-rm.de/storage/spert/public/datasets/conll04"
FILES = (
    "conll04_train.json",
    "conll04_dev.json",
    "conll04_test.json",
    "conll04_types.json",
)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    out = root / "data" / "benchmarks" / "conll04"
    out.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        dest = out / name
        url = f"{BASE}/{name}"
        print(f"fetch {url} -> {dest}")
        urllib.request.urlretrieve(url, dest)
    print("ok", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
