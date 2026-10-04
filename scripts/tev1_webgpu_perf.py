#!/usr/bin/env python3
"""Time Ollama System One vs document the WebGPU Tev1 ceiling.

Ollama (this machine)::

    python scripts/tev1_webgpu_perf.py --host http://127.0.0.1:11434 --model tev1

WebGPU wall times come from the Playwright harness (see
``web/e2e/webgpu-perf.spec.ts``) which loads local ``tev1-0.8b-onnx`` and
extracts Northwind.

Writes ``docs/results/tev1-webgpu-perf.json``.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Packed POST matching the parity fixture (2 noul questions, shared state).
PACKED = {
    "model": "tev1",
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


def post(host: str, body: dict, timeout: float = 180.0) -> tuple[dict, float]:
    raw = json.dumps(body).encode()
    req = urllib.request.Request(
        host.rstrip("/") + "/v1/systemone",
        data=raw,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    ms = (time.perf_counter() - t0) * 1000
    return data, ms


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="tev1")
    ap.add_argument("--warmup", type=int, default=1)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument(
        "--out",
        type=Path,
        default=ROOT / "docs/results/tev1-webgpu-perf.json",
    )
    ap.add_argument(
        "--webgpu-json",
        type=Path,
        default=ROOT / "docs/results/tev1-webgpu-perf-browser.json",
        help="Optional Playwright WebGPU timings to merge",
    )
    args = ap.parse_args()

    body = dict(PACKED)
    body["model"] = args.model
    n_q = len(body["questions"])

    times: list[float] = []
    last: dict | None = None
    try:
        for i in range(args.warmup):
            _, ms = post(args.host, body)
            print(f"ollama warmup {i + 1}: {ms:.0f} ms ({ms / n_q:.0f} ms/q)", file=sys.stderr)
        for i in range(args.runs):
            last, ms = post(args.host, body)
            times.append(ms)
            print(f"ollama run {i + 1}: {ms:.0f} ms ({ms / n_q:.0f} ms/q)", file=sys.stderr)
    except urllib.error.URLError as e:
        print(f"cannot reach Ollama at {args.host}: {e}", file=sys.stderr)
        return 1

    report: dict = {
        "ollama": {
            "host": args.host,
            "model": args.model,
            "questions": n_q,
            "runs_ms": [round(t, 1) for t in times],
            "mean_ms": round(statistics.mean(times), 1),
            "median_ms": round(statistics.median(times), 1),
            "mean_ms_per_question": round(statistics.mean(times) / n_q, 1),
            "answers": (last or {}).get("answers", {}),
        },
        "webgpu": None,
        "notes": [
            "Ollama times are one packed POST /v1/systemone (native Metal/CUDA).",
            "WebGPU times come from docs/results/tev1-webgpu-perf-browser.json when present.",
            "Hub graph: raphaelmansuy/tev1-0.8b-onnx-webgpu (Tev1 transplant).",
        ],
    }

    if args.webgpu_json.is_file():
        report["webgpu"] = json.loads(args.webgpu_json.read_text())
        o = report["ollama"]["mean_ms_per_question"]
        w = report["webgpu"].get("mean_ms_per_call")
        if isinstance(w, (int, float)) and o > 0:
            report["ratio_webgpu_over_ollama"] = round(w / o, 2)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
