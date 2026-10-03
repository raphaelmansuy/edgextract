"""Run the extractor on a converted CoNLL04 split and score exact spans."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from edgextract.benchmarks.conll04 import load_converted_split
from edgextract.cache import DecisionCache
from edgextract.candidates import GazetteerProposer
from edgextract.eval import micro_average_spans, score_spans
from edgextract.gate import GateConfig
from edgextract.ontology import Ontology, bundled_ontology_path, load_ontology
from edgextract.pipeline import Extractor
from edgextract.span_encoder import EncoderProposer, SpanEncoder
from edgextract.systemone import SystemOneClient
from edgextract.types import Sentence


def build_benchmark_extractor(
    ontology: Ontology,
    client: SystemOneClient,
    encoder: SpanEncoder,
    *,
    gate: GateConfig | None = None,
    cache: DecisionCache | None = None,
    encoder_threshold: float = 0.5,
) -> Extractor:
    proposers = (
        GazetteerProposer(),
        EncoderProposer(encoder, threshold=encoder_threshold),
    )
    return Extractor(
        ontology=ontology,
        client=client,
        gate=gate,
        cache=cache,
        proposers=proposers,
    )


def extract_document(extractor: Extractor, doc: dict[str, Any]):
    text = doc["text"]
    sent = Sentence(id=f"{doc['id']}-s0", text=text, start=0, end=len(text), index=0)
    return extractor.extract_sentences(
        [sent],
        document_id=doc["id"],
        chunk_id=f"{doc['id']}-chunk-0",
    )


def run_split(
    *,
    split: str,
    client: SystemOneClient,
    encoder: SpanEncoder,
    ontology_path: str | Path | None = None,
    raw_root: str | Path | None = None,
    cache_path: str | Path | None = None,
    limit: int | None = None,
    encoder_threshold: float = 0.30,
    gate: GateConfig | None = None,
) -> dict[str, Any]:
    ontology = load_ontology(ontology_path or bundled_ontology_path("conll04"))
    docs = load_converted_split(split, root=raw_root)
    if limit is not None:
        docs = docs[:limit]
    cache = DecisionCache(cache_path) if cache_path else None
    extractor = build_benchmark_extractor(
        ontology,
        client,
        encoder,
        gate=gate,
        cache=cache,
        encoder_threshold=encoder_threshold,
    )
    rows: list[dict[str, object]] = []
    per_doc: list[dict[str, Any]] = []
    for doc in docs:
        result = extract_document(extractor, doc)
        scored = score_spans(result, doc)
        rows.append(scored)
        per_doc.append(
            {
                "id": doc["id"],
                "orig_id": doc.get("orig_id"),
                "entities": scored["entities"],
                "relations": scored["relations"],
                "boundary_only": scored["boundary_only"],
                "direction_swaps": scored["direction_swaps"],
                "stats": result.metadata.get("stats"),
            }
        )
    summary = micro_average_spans(rows)
    return {
        "split": split,
        "n_docs": len(docs),
        "encoder_threshold": encoder_threshold,
        "model": client.model,
        "summary": summary,
        "documents": per_doc,
        "ceiling": {
            "source": "SpERT (Eberts and Ulges, ECAI 2020), supervised on train",
            "entity_f1": 0.8894,
            "relation_f1": 0.7147,
        },
    }
