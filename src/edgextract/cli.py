"""CLI: extract, report, eval, calibrate, probe."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from edgextract.ontology import (
    describe_ontology,
    load_ontology_named,
    resolve_ontology_path,
    write_starter_ontology,
)
from edgextract.systemone import DEFAULT_BASE_URL, SystemOneClient, SystemOneError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="edgextract",
        description="Extract a knowledge graph from text using an ontology and a decision model.",
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model", default="nimble")
    parser.add_argument("--timeout", type=float, default=60.0)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_ex = sub.add_parser("extract", help="Run the pipeline on a markdown file")
    p_ex.add_argument("markdown")
    p_ex.add_argument("--ontology", default="tech_docs", help="Bundled name or YAML path")
    p_ex.add_argument("--out", default="-")
    p_ex.add_argument("--cache", default=".edgextract-cache/decisions.sqlite")
    p_ex.add_argument("--document-id", default=None)
    p_rep = sub.add_parser("report", help="Extract and write a self-contained HTML report")
    p_rep.add_argument("markdown")
    p_rep.add_argument("--ontology", default="tech_docs", help="Bundled name or YAML path")
    p_rep.add_argument("--out", required=True)
    p_rep.add_argument("--cache", default=".edgextract-cache/decisions.sqlite")
    p_rep.add_argument(
        "--graph",
        action="store_true",
        default=True,
        help="Include an interactive knowledge graph (default on)",
    )
    p_rep.add_argument("--no-graph", action="store_false", dest="graph")
    sub.add_parser("probe", help="Call /v1/systemone with the ticket sample")
    p_ev = sub.add_parser("eval", help="Score a directory of golden JSON against extracts")
    p_ev.add_argument("golden_dir")
    p_ev.add_argument("--ontology", default="tech_docs", help="Bundled name or YAML path")
    p_ev.add_argument("--docs-dir", required=True)
    p_ev.add_argument("--cache", default=".edgextract-cache/decisions.sqlite")
    p_cal = sub.add_parser("calibrate", help="Fit gate cutoffs from a golden set")
    p_cal.add_argument("golden_dir")
    p_cal.add_argument("--ontology", default="tech_docs", help="Bundled name or YAML path")
    p_cal.add_argument("--docs-dir", required=True)
    p_cal.add_argument("--cache", default=".edgextract-cache/decisions.sqlite")
    p_cal.add_argument("--max-error", type=float, default=0.15)
    p_bm = sub.add_parser(
        "eval-benchmark",
        help="Score CoNLL04 (SpERT split) with exact character-span micro F1",
    )
    p_bm.add_argument("--split", choices=["dev", "test", "train"], default="dev")
    p_bm.add_argument(
        "--method",
        choices=["decision", "llm"],
        default="decision",
        help="decision calls System One; llm is one chat JSON completion per sentence",
    )
    p_bm.add_argument("--limit", type=int, default=None)
    p_bm.add_argument("--ontology", default="conll04", help="Bundled name or YAML path")
    p_bm.add_argument(
        "--data-root",
        default=None,
        help="Directory with conll04_{split}.json (default: data/benchmarks/conll04)",
    )
    p_bm.add_argument("--cache", default=".edgextract-cache/conll04.sqlite")
    p_bm.add_argument(
        "--encoder-model",
        default="fastino/gliner2.5-base-v1",
        help="Span encoder. Base beat Small on CoNLL04 dev; pass gliner2.5-small-v1 for the lighter model.",
    )
    p_bm.add_argument(
        "--encoder-threshold",
        type=float,
        default=0.30,
        help="GLiNER span cutoff (fitted on CoNLL04 dev; library default stays 0.5)",
    )
    p_bm.add_argument("--device", default="mps", help="mps, cpu, or cuda")
    p_bm.add_argument("--out", default="-", help="Write full JSON report here")
    p_exp = sub.add_parser("export-cypher", help="Print Cypher from an extract JSON")
    p_exp.add_argument("extract_json")
    p_graph = sub.add_parser("graph", help="Write an interactive graph HTML from extract JSON")
    p_graph.add_argument("extract_json")
    p_graph.add_argument("--out", required=True)
    p_graph.add_argument("--ontology", default="tech_docs")
    p_graph.add_argument("--title", default=None)
    p_init = sub.add_parser("init-ontology", help="Write a starter ontology YAML")
    p_init.add_argument("path")
    p_val = sub.add_parser("validate-ontology", help="Load an ontology and print its legal links")
    p_val.add_argument("path")
    args = parser.parse_args(argv)

    if args.cmd == "probe":
        return _probe(args)
    if args.cmd == "extract":
        return _extract(args)
    if args.cmd == "report":
        return _report(args)
    if args.cmd == "eval":
        return _eval(args)
    if args.cmd == "calibrate":
        return _calibrate(args)
    if args.cmd == "eval-benchmark":
        return _eval_benchmark(args)
    if args.cmd == "export-cypher":
        return _export_cypher(args)
    if args.cmd == "graph":
        return _graph(args)
    if args.cmd == "init-ontology":
        return _init_ontology(args)
    if args.cmd == "validate-ontology":
        return _validate_ontology(args)
    return 2


def _client(args) -> SystemOneClient:
    return SystemOneClient(model=args.model, base_url=args.base_url, timeout=args.timeout)


def _probe(args) -> int:
    client = _client(args)
    try:
        resp = client.decide(
            "Our checkout has returned 500 errors since 9am.",
            {
                "label": {
                    "type": "choice",
                    "instructions": "Which label fits this ticket?",
                    "criteria": {
                        "billing": "Payments and refunds",
                        "bug": "Software errors",
                        "account": "Login and account access",
                    },
                }
            },
        )
    except SystemOneError as exc:
        print(f"probe failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(resp.model_dump(), indent=2))
    return 0


def _run_file(args, markdown_path: str):
    from edgextract.cache import DecisionCache
    from edgextract.pipeline import Extractor

    text = Path(markdown_path).read_text(encoding="utf-8")
    ontology = load_ontology_named(args.ontology)
    cache = DecisionCache(args.cache) if getattr(args, "cache", None) else None
    extractor = Extractor(ontology=ontology, client=_client(args), cache=cache)
    doc_id = getattr(args, "document_id", None) or Path(markdown_path).stem
    result = extractor.extract_markdown(text, document_id=doc_id)
    return text, ontology, result


def _extract(args) -> int:
    _text, _ont, result = _run_file(args, args.markdown)
    payload = result.model_dump(mode="json")
    dumped = json.dumps(payload, indent=2, ensure_ascii=False)
    if args.out == "-":
        print(dumped)
    else:
        Path(args.out).write_text(dumped, encoding="utf-8")
    return 0


def _report(args) -> int:
    from edgextract.report import write_report

    text, ont, result = _run_file(args, args.markdown)
    write_report(
        args.out,
        text,
        result,
        ont,
        title=Path(args.markdown).name,
        include_graph=bool(getattr(args, "graph", True)),
    )
    print(f"wrote {args.out}")
    return 0


def _load_golden(golden_dir: str) -> dict[str, dict]:
    out = {}
    for path in sorted(Path(golden_dir).glob("*.json")):
        out[path.stem] = json.loads(path.read_text(encoding="utf-8"))
    return out


def _eval(args) -> int:
    from edgextract.eval import micro_average, score_result

    golden = _load_golden(args.golden_dir)
    rows = []
    for stem, gold in golden.items():
        md = Path(args.docs_dir) / f"{stem}.md"
        if not md.exists():
            print(f"missing {md}", file=sys.stderr)
            continue
        args.markdown = str(md)
        args.document_id = stem
        _t, _o, result = _run_file(args, str(md))
        rows.append(score_result(result, gold))
        print(stem, json.dumps(rows[-1]))
    if not rows:
        return 1
    print("micro entities", json.dumps(micro_average(rows, "entities")))
    print("micro relations", json.dumps(micro_average(rows, "relations")))
    return 0


def _calibrate(args) -> int:
    from edgextract.calibrate import fit_gate, precision_coverage_curve

    golden = _load_golden(args.golden_dir)
    pairs = []
    for stem, gold in golden.items():
        md = Path(args.docs_dir) / f"{stem}.md"
        args.document_id = stem
        _t, _o, result = _run_file(args, str(md))
        pairs.append((result, gold))
    gate = fit_gate(pairs, max_error=args.max_error)
    curve = precision_coverage_curve(pairs, kind="entity")
    print(json.dumps({"gate": gate.model_dump(), "curve_points": len(curve)}, indent=2))
    return 0


def _eval_benchmark(args) -> int:
    if args.method == "llm":
        from edgextract.baseline_llm import LLMBaseline
        from edgextract.benchmarks.llm_run import run_llm_split

        base_url = args.base_url
        if args.model.startswith("mistral") and base_url.rstrip("/") in {
            "http://localhost:11434",
            "http://127.0.0.1:11434",
        }:
            base_url = "https://api.mistral.ai"
        report = run_llm_split(
            split=args.split,
            baseline=LLMBaseline(model=args.model, base_url=base_url, timeout=args.timeout),
            ontology_path=resolve_ontology_path(args.ontology),
            raw_root=args.data_root,
            cache_path=args.cache,
            limit=args.limit,
        )
        summary = {
            "split": report["split"],
            "n_docs": report["n_docs"],
            "method": report["method"],
            "model": report.get("model"),
            "failures": report["failures"],
            "summary": report["summary"],
            "ceiling": report["ceiling"],
        }
        print(json.dumps(summary, indent=2))
        if args.out != "-":
            Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"wrote {args.out}", file=sys.stderr)
        return 0

    from edgextract.benchmarks.run import run_split
    from edgextract.span_encoder import Gliner2Encoder

    encoder = Gliner2Encoder(args.encoder_model, map_location=args.device)
    report = run_split(
        split=args.split,
        client=_client(args),
        encoder=encoder,
        ontology_path=resolve_ontology_path(args.ontology),
        raw_root=args.data_root,
        cache_path=args.cache,
        limit=args.limit,
        encoder_threshold=args.encoder_threshold,
    )
    summary = {
        "split": report["split"],
        "n_docs": report["n_docs"],
        "model": report.get("model"),
        "encoder_threshold": report.get("encoder_threshold"),
        "summary": report["summary"],
        "ceiling": report["ceiling"],
    }
    print(json.dumps(summary, indent=2))
    if args.out != "-":
        Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
    return 0


def _export_cypher(args) -> int:
    data = json.loads(Path(args.extract_json).read_text(encoding="utf-8"))
    for e in data.get("entities") or []:
        print(
            f"MERGE (n:Node {{id: {json.dumps(e['name'])}}}) "
            f"SET n.entity_type = {json.dumps(e['entity_type'])}, "
            f"n.description = {json.dumps(e['description'])};"
        )
    for r in data.get("relationships") or []:
        print(
            f"MATCH (a:Node {{id: {json.dumps(r['source'])}}}), "
            f"(b:Node {{id: {json.dumps(r['target'])}}}) "
            f"MERGE (a)-[e:EDGE {{relation_type: {json.dumps(r['relation_type'])}}}]->(b) "
            f"SET e.description = {json.dumps(r['description'])};"
        )
    return 0


def _graph(args) -> int:
    from edgextract.graph_html import write_graph
    from edgextract.types import ExtractionResult

    payload = json.loads(Path(args.extract_json).read_text(encoding="utf-8"))
    result = ExtractionResult.model_validate(payload)
    ont = load_ontology_named(args.ontology)
    title = args.title or Path(args.extract_json).name
    write_graph(args.out, result, ont, title=title)
    print(f"wrote {args.out}")
    return 0


def _init_ontology(args) -> int:
    try:
        path = write_starter_ontology(args.path)
    except FileExistsError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"wrote {path}")
    print("Edit the kinds and links, then run: edgextract validate-ontology", path)
    return 0


def _validate_ontology(args) -> int:
    try:
        ont = load_ontology_named(args.path)
    except (OSError, ValueError, ValidationError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    info = describe_ontology(ont)
    print(f"{info['title']} ({info['id']})")
    print("Kinds of name:")
    for item in info["types"]:
        print(f"  {item['id']}: {item['description']}")
    print("Links:")
    for item in info["relations"]:
        print(f"  {item['id']}: {item['description']}")
    print("Legal pairs:")
    for pair in info["legal_pairs"]:
        print(f"  {pair}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
