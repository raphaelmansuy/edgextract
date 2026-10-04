#!/usr/bin/env python3
"""Compare Ollama tev1:0.8b against the browser letter-scoring contract on Northwind.

This script does not run WebGPU. It posts the same System One bodies Ollama sees,
prints the answers, and writes a JSON report the web unit tests can mirror.

    uv run python scripts/tev1_webgpu_parity.py --host http://localhost:11434 --model tev1:0.8b

When a WebGPU ONNX graph is available, run the page with ``?backend=webgpu`` on
``data/golden/docs/13_northwind.md`` and confirm gate bands match this report.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NORTHWIND = (ROOT / "data/golden/docs/13_northwind.md").read_text()

# One noul the extractor would ask about a kept link on this note.
SAMPLE = {
    "model": "tev1:0.8b",
    "state": ("Ada Lovelace founded Northwind in Paris.\nOnly the source sentence may be used."),
    "questions": {
        "founded": {
            "type": "noul",
            "instructions": (
                "In the source sentence, did Ada Lovelace found Northwind? "
                "Answer yes only if the sentence states that founding."
            ),
            "criteria": {
                "true": "Yes, the sentence says Ada Lovelace founded Northwind.",
                "false": "No, the sentence does not say that.",
            },
        },
        "acquired": {
            "type": "noul",
            "instructions": (
                "In the source sentence, did Acme Inc acquire Northwind? "
                "Answer yes only if the sentence states that acquisition."
            ),
            "criteria": {
                "true": "Yes, the sentence says Acme Inc acquired Northwind.",
                "false": "No, the sentence does not say that.",
            },
        },
    },
}


def post(host: str, body: dict) -> dict:
    req = urllib.request.Request(
        host.rstrip("/") + "/v1/systemone",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def band(p: float, yes: float = 0.8, no: float = 0.2) -> str:
    if p >= yes:
        return "ACCEPT"
    if p <= no:
        return "REJECT"
    return "REVIEW"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="http://localhost:11434")
    ap.add_argument("--model", default="tev1:0.8b")
    ap.add_argument(
        "--out",
        type=Path,
        default=ROOT / "docs/results/tev1-webgpu-parity-ollama.json",
    )
    args = ap.parse_args()
    body = dict(SAMPLE)
    body["model"] = args.model
    try:
        data = post(args.host, body)
    except urllib.error.URLError as e:
        print(f"cannot reach {args.host}: {e}", file=sys.stderr)
        return 1

    report = {
        "host": args.host,
        "model": args.model,
        "northwind_chars": len(NORTHWIND),
        "answers": data.get("answers", {}),
        "bands": {},
        "expect": {
            "founded": "ACCEPT",
            "acquired": "REJECT",
        },
    }
    ok = True
    for qid, ans in report["answers"].items():
        if ans.get("type") == "noul":
            b = band(float(ans["noul"]))
            report["bands"][qid] = b
            if qid in report["expect"] and b != report["expect"][qid]:
                ok = False
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"wrote {args.out}", file=sys.stderr)
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
