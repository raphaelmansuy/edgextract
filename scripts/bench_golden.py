"""Time the Python pipeline on golden notes against a local fake SystemOne."""

from __future__ import annotations

import json
import time
from pathlib import Path

from tests.fake_handler import gazetteer_handler

from edgextract.cache import DecisionCache
from edgextract.candidates import DEFAULT_PROPOSERS, propose_mentions
from edgextract.markdown import split_sentences
from edgextract.ontology import load_ontology_named
from edgextract.pipeline import Extractor
from edgextract.systemone import SystemOneClient
from edgextract.testing import start_fake_systemone

ROOT = Path(__file__).resolve().parents[1]
DOCS = sorted((ROOT / "data/golden/docs").glob("*.md"))
REPEATS = 7


def main() -> None:
    ontology = load_ontology_named("tech_docs")
    url, stop = start_fake_systemone(gazetteer_handler(ontology))
    try:
        client = SystemOneClient(model="nimble", base_url=url, timeout=30)
        extractor = Extractor(ontology, client)

        cpu_rows = []
        for path in DOCS:
            text = path.read_text()
            t0 = time.perf_counter_ns()
            sents = split_sentences(text, doc_id=path.stem)
            mentions = 0
            for s in sents:
                mentions += len(propose_mentions(s, ontology, proposers=DEFAULT_PROPOSERS))
            ns = time.perf_counter_ns() - t0
            cpu_rows.append(
                {
                    "doc": path.name,
                    "bytes": len(text.encode()),
                    "sentences": len(sents),
                    "mentions": mentions,
                    "cpu_ns": ns,
                    "cpu_us": ns / 1000.0,
                }
            )

        cold = []
        for i in range(REPEATS):
            t0 = time.perf_counter()
            rows = []
            calls = pairs = sentences = entities = rels = 0
            for path in DOCS:
                text = path.read_text()
                result = extractor.extract_markdown(text, document_id=path.stem)
                stats = result.metadata["stats"]
                calls += stats["systemone_calls"]
                pairs += stats["pairs_considered"]
                sentences += stats["sentences"]
                entities += len(result.entities)
                rels += len(result.relationships)
                rows.append(
                    {
                        "doc": path.name,
                        "elapsed_ms": result.extraction_time_ms,
                        "systemone_calls": stats["systemone_calls"],
                        "pairs_considered": stats["pairs_considered"],
                        "sentences": stats["sentences"],
                        "entities": len(result.entities),
                        "relationships": len(result.relationships),
                    }
                )
            cold.append(
                {
                    "i": i,
                    "wall_ms": (time.perf_counter() - t0) * 1000.0,
                    "systemone_calls": calls,
                    "pairs_considered": pairs,
                    "sentences": sentences,
                    "entities": entities,
                    "relationships": rels,
                    "docs": rows,
                }
            )

        import tempfile

        tmp = Path(tempfile.mkdtemp()) / "c.sqlite"
        cache = DecisionCache(tmp)
        cached_ext = Extractor(ontology, client, cache=cache)
        cached_runs = []
        for i in range(REPEATS):
            t0 = time.perf_counter()
            calls = hits = 0
            for path in DOCS:
                text = path.read_text()
                result = cached_ext.extract_markdown(text, document_id=path.stem)
                stats = result.metadata["stats"]
                calls += stats["systemone_calls"]
                hits += stats["cache_hits"]
            cached_runs.append(
                {
                    "i": i,
                    "wall_ms": (time.perf_counter() - t0) * 1000.0,
                    "systemone_calls": calls,
                    "cache_hits": hits,
                }
            )

        scale_base = (ROOT / "data/golden/docs/01_edgequake.md").read_text()
        scale = []
        for copies in (1, 5, 10, 25):
            text = scale_base * copies
            t0 = time.perf_counter()
            result = extractor.extract_markdown(text, document_id=f"scale-{copies}")
            wall_ms = (time.perf_counter() - t0) * 1000.0
            stats = result.metadata["stats"]
            scale.append(
                {
                    "copies": copies,
                    "bytes": len(text.encode()),
                    "wall_ms": wall_ms,
                    "elapsed_ms": result.extraction_time_ms,
                    "sentences": stats["sentences"],
                    "systemone_calls": stats["systemone_calls"],
                    "pairs_considered": stats["pairs_considered"],
                }
            )

        print(
            json.dumps(
                {
                    "impl": "python",
                    "profile": "cpython",
                    "repeats": REPEATS,
                    "cpu_parse_propose": cpu_rows,
                    "cold": cold,
                    "cached": cached_runs,
                    "scale_edgequake": scale,
                },
                indent=2,
            )
        )
    finally:
        stop()


if __name__ == "__main__":
    main()
