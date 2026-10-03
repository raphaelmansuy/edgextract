"""Fit accept/reject cutoffs on a labeled set. Do not copy someone else's threshold."""

from __future__ import annotations

from edgextract.gate import GateConfig
from edgextract.ontology import NO_RELATION, NOT_ENTITY
from edgextract.types import ExtractionResult, GateBand


def _entity_correct(tm, gold_keys: set[tuple[str, str]]) -> bool:
    from edgextract.names import normalize_entity_name

    if tm.entity_type == NOT_ENTITY:
        return (normalize_entity_name(tm.mention.text),) not in {k[0:1] for k in gold_keys}
    key = (normalize_entity_name(tm.mention.text), tm.entity_type)
    return key in gold_keys


def precision_coverage_curve(
    results: list[tuple[ExtractionResult, dict]],
    kind: str = "entity",
) -> list[dict[str, float]]:
    """Sweep winner_prob. Coverage = share kept. Error = 1 - precision on kept."""
    scored: list[tuple[float, bool]] = []
    for pred, gold in results:
        if kind == "entity":
            gold_keys = {
                (e["name"].upper().replace(" ", "_"), e["type"].upper())
                for e in gold.get("entities") or []
            }
            # rebuild with normalize
            from edgextract.eval import entity_key

            gold_keys = {entity_key(e["name"], e["type"]) for e in gold.get("entities") or []}
            for tm in pred.mentions:
                if tm.entity_type == NOT_ENTITY:
                    continue
                from edgextract.eval import entity_key as ek

                ok = ek(tm.mention.text, tm.entity_type) in gold_keys
                scored.append((tm.winner_prob, ok))
        else:
            from edgextract.eval import relation_key

            gold_keys = {
                relation_key(r["source"], r["target"], r["type"])
                for r in gold.get("relations") or gold.get("relationships") or []
            }
            for h in pred.relation_hits:
                if h.relation_type == NO_RELATION:
                    continue
                ok = relation_key(h.source_text, h.target_text, h.relation_type) in gold_keys
                scored.append((h.winner_prob, ok))
    scored.sort(key=lambda x: -x[0])
    curve = []
    tp = fp = 0
    n = len(scored)
    for i, (p, ok) in enumerate(scored, start=1):
        if ok:
            tp += 1
        else:
            fp += 1
        prec = tp / (tp + fp)
        curve.append(
            {
                "threshold": p,
                "coverage": i / n if n else 0.0,
                "precision": prec,
                "error": 1.0 - prec,
                "kept": float(i),
            }
        )
    return curve


def fit_gate(
    results: list[tuple[ExtractionResult, dict]],
    *,
    max_error: float = 0.15,
    kind: str = "entity",
) -> GateConfig:
    curve = precision_coverage_curve(results, kind=kind)
    chosen = 0.70
    for row in reversed(curve):
        if row["error"] <= max_error:
            chosen = row["threshold"]
            break
    return GateConfig(
        fitted=True,
        accept_prob=max(0.5, min(0.95, chosen)),
        accept_confidence=0.45,
        reject_prob=min(0.4, chosen * 0.5),
    )


def band_counts(result: ExtractionResult) -> dict[str, int]:
    counts = {b.value: 0 for b in GateBand}
    for tm in result.mentions:
        counts[tm.band.value] += 1
    return counts
