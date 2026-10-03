"""Precision, recall, F1 on a golden set. Mentions match on canonical name + type."""

from __future__ import annotations

from edgextract.names import normalize_entity_name
from edgextract.ontology import NO_RELATION, NOT_ENTITY
from edgextract.types import ExtractionResult, GateBand


def entity_key(name: str, entity_type: str) -> tuple[str, str]:
    return (normalize_entity_name(name), entity_type.upper())


def relation_key(source: str, target: str, relation_type: str) -> tuple[str, str, str]:
    return (
        normalize_entity_name(source),
        normalize_entity_name(target),
        relation_type.upper(),
    )


def prf(predicted: set, gold: set) -> dict[str, float]:
    tp = len(predicted & gold)
    fp = len(predicted - gold)
    fn = len(gold - predicted)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return {
        "tp": float(tp),
        "fp": float(fp),
        "fn": float(fn),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "support": float(len(gold)),
    }


def score_result(pred: ExtractionResult, gold: dict) -> dict[str, dict[str, float]]:
    gold_ents = {entity_key(e["name"], e["type"]) for e in gold.get("entities") or []}
    gold_rels = {
        relation_key(r["source"], r["target"], r["type"])
        for r in gold.get("relations") or gold.get("relationships") or []
    }
    pred_ents = {entity_key(e.name, e.entity_type) for e in pred.entities}
    pred_rels = {relation_key(r.source, r.target, r.relation_type) for r in pred.relationships}
    return {"entities": prf(pred_ents, gold_ents), "relations": prf(pred_rels, gold_rels)}


def micro_average(rows: list[dict[str, dict[str, float]]], kind: str) -> dict[str, float]:
    tp = sum(r[kind]["tp"] for r in rows)
    fp = sum(r[kind]["fp"] for r in rows)
    fn = sum(r[kind]["fn"] for r in rows)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def gold_has_spans(gold: dict) -> bool:
    ents = gold.get("entities") or []
    return bool(ents) and all("start" in e and "end" in e for e in ents)


def score_spans(pred: ExtractionResult, gold: dict) -> dict[str, object]:
    """Exact character-span micro F1 for ACCEPT mentions and relation hits."""
    gold_ents = {
        (int(e["start"]), int(e["end"]), str(e["type"]).upper()) for e in gold.get("entities") or []
    }
    gold_spans = {(s, e) for s, e, _t in gold_ents}
    gold_rels = set()
    for r in gold.get("relations") or gold.get("relationships") or []:
        if "source_start" not in r:
            continue
        gold_rels.add(
            (
                int(r["source_start"]),
                int(r["source_end"]),
                int(r["target_start"]),
                int(r["target_end"]),
                str(r["type"]).upper(),
            )
        )

    pred_ents = set()
    for t in pred.mentions:
        if t.band is not GateBand.ACCEPT or t.entity_type == NOT_ENTITY:
            continue
        pred_ents.add((t.mention.start, t.mention.end, t.entity_type.upper()))

    pred_rels = set()
    for h in pred.relation_hits:
        if h.band is not GateBand.ACCEPT or h.relation_type == NO_RELATION:
            continue
        pred_rels.add(
            (
                h.source_start,
                h.source_end,
                h.target_start,
                h.target_end,
                h.relation_type.upper(),
            )
        )

    boundary_only = 0
    for s, e, typ in pred_ents:
        if (s, e) in gold_spans and (s, e, typ) not in gold_ents:
            boundary_only += 1

    direction_swaps = 0
    gold_undirected = {
        (min(a, c), max(a, c), min(b, d), max(b, d), t): (a, b, c, d, t)
        for a, b, c, d, t in gold_rels
    }
    for a, b, c, d, t in pred_rels:
        if (a, b, c, d, t) in gold_rels:
            continue
        swapped = (c, d, a, b, t)
        if swapped in gold_rels:
            direction_swaps += 1
            continue
        # also count if undirected key matches but endpoints reversed
        key = (min(a, c), max(a, c), min(b, d), max(b, d), t)
        if key in gold_undirected and gold_undirected[key] != (a, b, c, d, t):
            direction_swaps += 1

    return {
        "entities": prf(pred_ents, gold_ents),
        "relations": prf(pred_rels, gold_rels),
        "boundary_only": float(boundary_only),
        "direction_swaps": float(direction_swaps),
        "pred_entity_spans": float(len(pred_ents)),
        "gold_entity_spans": float(len(gold_ents)),
        "pred_relation_spans": float(len(pred_rels)),
        "gold_relation_spans": float(len(gold_rels)),
    }


def micro_average_spans(rows: list[dict[str, object]]) -> dict[str, object]:
    ent = micro_average(
        [{"entities": r["entities"], "relations": r["relations"]} for r in rows],  # type: ignore[arg-type]
        "entities",
    )
    rel = micro_average(
        [{"entities": r["entities"], "relations": r["relations"]} for r in rows],  # type: ignore[arg-type]
        "relations",
    )
    return {
        "entities": ent,
        "relations": rel,
        "boundary_only": sum(float(r["boundary_only"]) for r in rows),
        "direction_swaps": sum(float(r["direction_swaps"]) for r in rows),
    }
