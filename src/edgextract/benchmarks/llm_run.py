"""Score the chat-JSON extractor on a span benchmark.

The model returns names, not character offsets. Each name is placed on the
first unused whole-word occurrence in the sentence. A name that does not
occur is still counted, so a made-up string hurts precision.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from edgextract.baseline_llm import LLMBaseline, LLMBaselineError, parse_llm_json, to_result
from edgextract.benchmarks.conll04 import load_converted_split
from edgextract.eval import micro_average_spans, score_spans
from edgextract.names import normalize_entity_name
from edgextract.ontology import Ontology, bundled_ontology_path, load_ontology
from edgextract.types import (
    ExtractionResult,
    GateBand,
    Mention,
    MentionSource,
    RelationHit,
    TypedMention,
)


def find_occurrences(text: str, needle: str) -> list[tuple[int, int]]:
    """Whole-word matches. Case folds only when that does not change length."""
    needle = needle.strip()
    if not needle:
        return []
    if len(needle.casefold()) == len(needle):
        hay = text.casefold()
        key = needle.casefold()
    else:
        hay = text
        key = needle
    found: list[tuple[int, int]] = []
    start = 0
    while True:
        i = hay.find(key, start)
        if i < 0:
            break
        end = i + len(key)
        left_ok = i == 0 or not text[i - 1].isalnum()
        right_ok = end == len(text) or not text[end].isalnum()
        if left_ok and right_ok:
            found.append((i, end))
        start = i + 1
    return found


def _overlaps(start: int, end: int, used: list[tuple[int, int]]) -> bool:
    return any(not (end <= u0 or start >= u1) for u0, u1 in used)


def attach_spans(result: ExtractionResult, text: str, *, document_id: str) -> ExtractionResult:
    """Fill mentions and relation hits so score_spans can read the chat JSON."""
    used: list[tuple[int, int]] = []
    placed: dict[str, tuple[int, int, str, str]] = {}
    mentions: list[TypedMention] = []
    for index, entity in enumerate(result.entities):
        surface = entity.display_name or entity.description or entity.name
        span = next(
            (
                pair
                for pair in find_occurrences(text, surface)
                if not _overlaps(pair[0], pair[1], used)
            ),
            None,
        )
        if span is None:
            start, end = -1, -1 - index
            shown = surface
        else:
            start, end = span
            used.append(span)
            shown = text[start:end]
        key = normalize_entity_name(surface)
        if key and key not in placed and start >= 0:
            placed[key] = (start, end, entity.entity_type, shown)
        mentions.append(
            TypedMention(
                mention=Mention(
                    text=shown,
                    start=start,
                    end=end,
                    sentence_id=f"{document_id}-s0",
                    source=MentionSource.GAZETTEER,
                ),
                entity_type=entity.entity_type,
                band=GateBand.ACCEPT,
                winner_prob=1.0,
                decided_by="llm-json",
            )
        )

    hits: list[RelationHit] = []
    missing = 0
    for rel in result.relationships:
        src = placed.get(rel.source)
        tgt = placed.get(rel.target)
        if src is None or tgt is None:
            missing += 1
            hits.append(
                RelationHit(
                    source_text=rel.source,
                    source_type="",
                    source_start=-1,
                    source_end=-1 - missing,
                    target_text=rel.target,
                    target_type="",
                    target_start=-2,
                    target_end=-2 - missing,
                    relation_type=rel.relation_type,
                    band=GateBand.ACCEPT,
                    winner_prob=1.0,
                    sentence_id=f"{document_id}-s0",
                    evidence=rel.description,
                )
            )
            continue
        hits.append(
            RelationHit(
                source_text=src[3],
                source_type=src[2],
                source_start=src[0],
                source_end=src[1],
                target_text=tgt[3],
                target_type=tgt[2],
                target_start=tgt[0],
                target_end=tgt[1],
                relation_type=rel.relation_type,
                band=GateBand.ACCEPT,
                winner_prob=1.0,
                sentence_id=f"{document_id}-s0",
                evidence=rel.description,
            )
        )
    result.mentions = mentions
    result.relation_hits = hits
    return result


def _load_cache(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    rows: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        rows[str(row["id"])] = row
    return rows


def _append_cache(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def _from_cache(
    row: dict[str, Any], ontology: Ontology, text: str, document_id: str
) -> ExtractionResult:
    data = parse_llm_json(row["content"])
    result = to_result(data, ontology, document_id=document_id, chunk_id=f"{document_id}-chunk-0")
    result.extraction_time_ms = int(row.get("ms") or 0)
    result.output_tokens = int(row.get("output_tokens") or 0)
    result.input_tokens = int(row.get("input_tokens") or 0)
    result.metadata["model"] = row.get("model") or ""
    return attach_spans(result, text, document_id=document_id)


def run_llm_split(
    *,
    split: str,
    baseline: LLMBaseline,
    ontology_path: str | Path | None = None,
    raw_root: str | Path | None = None,
    cache_path: str | Path | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    ontology = load_ontology(ontology_path or bundled_ontology_path("conll04"))
    docs = load_converted_split(split, root=raw_root)
    if limit is not None:
        docs = docs[:limit]
    cache_file = Path(cache_path) if cache_path else None
    cached = _load_cache(cache_file) if cache_file else {}
    rows: list[dict[str, object]] = []
    per_doc: list[dict[str, Any]] = []
    failures = 0
    served_model = baseline.model
    for index, doc in enumerate(docs, start=1):
        doc_id = str(doc["id"])
        text = str(doc["text"])
        row = cached.get(doc_id)
        if row is None:
            try:
                result = baseline.extract(text, ontology, document_id=doc_id, exact_spans=True)
            except LLMBaselineError as exc:
                failures += 1
                print(f"llm-progress {index}/{len(docs)} {doc_id} failed: {exc}", file=sys.stderr)
                result = ExtractionResult(metadata={"model": baseline.model, "error": str(exc)})
            else:
                if cache_file is not None:
                    # Re-read the content we just parsed by calling extract already consumed it.
                    # Store the grounded result's source via a second field on metadata.
                    content = result.metadata.get("raw_content")
                    if isinstance(content, str):
                        _append_cache(
                            cache_file,
                            {
                                "id": doc_id,
                                "content": content,
                                "ms": result.extraction_time_ms,
                                "input_tokens": result.input_tokens,
                                "output_tokens": result.output_tokens,
                                "model": result.metadata.get("model") or baseline.model,
                            },
                        )
                result = attach_spans(result, text, document_id=doc_id)
        else:
            result = _from_cache(row, ontology, text, doc_id)
        served_model = str(result.metadata.get("model") or served_model)
        scored = score_spans(result, doc)
        rows.append(scored)
        per_doc.append(
            {
                "id": doc_id,
                "orig_id": doc.get("orig_id"),
                "entities": scored["entities"],
                "relations": scored["relations"],
                "boundary_only": scored["boundary_only"],
                "direction_swaps": scored["direction_swaps"],
            }
        )
        if index % 10 == 0 or index == len(docs):
            print(f"llm-progress {index}/{len(docs)} {doc_id}", file=sys.stderr, flush=True)
    summary = micro_average_spans(rows) if rows else {}
    return {
        "split": split,
        "n_docs": len(docs),
        "method": "llm-json",
        "model": served_model,
        "failures": failures,
        "summary": summary,
        "documents": per_doc,
        "ceiling": {
            "source": "SpERT (Eberts and Ulges, ECAI 2020), supervised on train",
            "entity_f1": 0.8894,
            "relation_f1": 0.7147,
        },
    }
