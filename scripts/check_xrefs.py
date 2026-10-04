#!/usr/bin/env python3
"""Fail if spec IDs dangle or if a REQ/EC has no test mention."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPECS = ROOT / "specs" / "0001-implementation"
TESTS = ROOT / "tests"
ID_RE = re.compile(r"\b((?:WHY|FP|REQ|EC|T|M)-\d+)\b")

REQUIRED_DOCS = [
    "README.md",
    "00-why.md",
    "01-first-principles.md",
    "02-contract-systemone.md",
    "03-ontology.md",
    "04-architecture.md",
    "05-lens-product-owner.md",
    "06-lens-fullstack.md",
    "07-lens-database.md",
    "08-lens-ux-ui.md",
    "09-lens-front-design.md",
    "10-lens-ai-kg-complexity.md",
    "11-edge-cases.md",
    "12-implementation-plan.md",
    "13-test-plan.md",
    "14-evaluation.md",
    "15-traceability.md",
]


def main() -> int:
    missing_docs = [n for n in REQUIRED_DOCS if not (SPECS / n).exists()]
    if missing_docs:
        print("missing spec docs:", ", ".join(missing_docs))
        return 1
    spec_text = []
    for path in sorted(SPECS.glob("*.md")):
        spec_text.append(path.read_text(encoding="utf-8"))
    specs = "\n".join(spec_text)
    tests = "\n".join(p.read_text(encoding="utf-8") for p in TESTS.glob("test_*.py"))
    spec_ids = set(ID_RE.findall(specs))
    test_ids = set(ID_RE.findall(tests))
    trace = (SPECS / "15-traceability.md").read_text(encoding="utf-8")
    reqs = {i for i in spec_ids if i.startswith("REQ-")}
    ecs = {i for i in spec_ids if i.startswith("EC-")}
    errors = []
    for ident in sorted(reqs | ecs):
        if ident not in trace:
            errors.append(f"{ident} missing from 15-traceability.md")
        if ident not in tests:
            errors.append(f"{ident} not mentioned in tests/")
    if not reqs or not ecs:
        errors.append("no REQ or EC ids found in specs")
    rust_ont = ROOT / "rust" / "edgextract" / "ontologies"
    data_ont = ROOT / "data" / "ontology"
    for name in ("tech_docs.yaml", "company_news.yaml", "conll04.yaml"):
        src = (data_ont / name).read_bytes()
        dst = (rust_ont / name).read_bytes()
        if src != dst:
            errors.append(f"{name} differs between data/ontology and rust/edgextract/ontologies")
    if errors:
        print("\n".join(errors))
        print(f"spec ids: {len(spec_ids)} test ids: {len(test_ids)}")
        return 1
    print(f"ok: {len(spec_ids)} spec ids, {len(reqs)} REQ, {len(ecs)} EC, all tested")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
