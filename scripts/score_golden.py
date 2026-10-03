#!/usr/bin/env python3
"""Score the golden notes with a closed-decision model or a chat model.

    uv run python scripts/score_golden.py --method closed --model tev1
    uv run python scripts/score_golden.py --method chat --model mistral-small-latest \
        --base-url https://api.mistral.ai

Notes 13 and 14 use the company_news ontology; the rest use tech_docs. Names and links
match on canonical name and kind, the same as `edgextract eval`.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from edgextract.baseline_llm import LLMBaseline
from edgextract.eval import micro_average, score_result
from edgextract.ontology import load_ontology_named
from edgextract.pipeline import Extractor
from edgextract.systemone import SystemOneClient

ROOT = Path(__file__).resolve().parent.parent / "data" / "golden"
NEWS = {"13_northwind", "14_acquired"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--method", choices=["closed", "chat"], required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--base-url", default="http://localhost:11434")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--out", help="write the summary JSON here")
    args = ap.parse_args()

    groups: dict[str, list] = {"tech_docs": [], "company_news": []}
    seconds: dict[str, float] = {}
    for label_path in sorted((ROOT / "labels").glob("*.json")):
        stem = label_path.stem
        md = ROOT / "docs" / f"{stem}.md"
        if not md.exists():
            continue
        name = "company_news" if stem in NEWS else "tech_docs"
        ont = load_ontology_named(name)
        text = md.read_text(encoding="utf-8")
        gold = json.loads(label_path.read_text(encoding="utf-8"))
        t0 = time.perf_counter()
        if args.method == "closed":
            client = SystemOneClient(model=args.model, base_url=args.base_url, timeout=args.timeout)
            result = Extractor(ont, client).extract_markdown(text, document_id=stem)
        else:
            llm = LLMBaseline(model=args.model, base_url=args.base_url, timeout=args.timeout)
            result = llm.extract(text, ont, document_id=stem)
        seconds[stem] = round(time.perf_counter() - t0, 2)
        scored = score_result(result, gold)
        groups[name].append(scored)
        print(
            f"{stem:14s} {seconds[stem]:6.1f}s  names {scored['entities']['f1']:.2f}  "
            f"links {scored['relations']['f1']:.2f}",
            flush=True,
        )

    summary: dict[str, object] = {"method": args.method, "model": args.model, "seconds": seconds}
    for name, rows in groups.items():
        if rows:
            summary[name] = {
                "notes": len(rows),
                "names": micro_average(rows, "entities"),
                "links": micro_average(rows, "relations"),
            }
    print(json.dumps(summary, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
