"""Merge typed mentions and relation hits into EdgeQuake-shaped records."""

from __future__ import annotations

from collections import defaultdict

from edgextract.names import normalize_entity_name
from edgextract.ontology import NO_RELATION, NOT_ENTITY, Ontology
from edgextract.types import (
    ExtractedEntity,
    ExtractedRelationship,
    ExtractionResult,
    GateBand,
    RelationHit,
    TypedMention,
)


def assemble(
    typed: list[TypedMention],
    hits: list[RelationHit],
    ontology: Ontology,
    *,
    document_id: str,
    chunk_id: str,
) -> ExtractionResult:
    del ontology
    entities_acc: dict[str, ExtractedEntity] = {}
    descriptions: dict[str, list[str]] = defaultdict(list)
    review: list[dict] = []
    rejected: list[dict] = []

    for t in typed:
        rec = {
            "text": t.mention.text,
            "type": t.entity_type,
            "band": t.band.value,
            "prob": t.winner_prob,
            "confidence": t.confidence,
            "flipped": t.flipped,
            "span": [t.mention.start, t.mention.end],
            "sentence_id": t.mention.sentence_id,
        }
        if t.band is GateBand.REVIEW:
            review.append({"kind": "entity", **rec})
            continue
        if t.band is GateBand.REJECT or t.entity_type == NOT_ENTITY:
            rejected.append({"kind": "entity", **rec})
            continue
        name = normalize_entity_name(t.mention.text)
        if not name:
            rejected.append({"kind": "entity", "reason": "opaque_or_empty_name", **rec})
            continue
        evidence = t.mention.text
        descriptions[name].append(evidence)
        existing = entities_acc.get(name)
        if existing is None:
            entities_acc[name] = ExtractedEntity(
                name=name,
                entity_type=t.entity_type,
                description=evidence,
                importance=min(1.0, 0.4 + t.winner_prob * 0.6),
                source_spans=[t.mention.text],
                source_chunk_ids=[chunk_id],
                source_document_id=document_id,
                display_name=t.mention.text,
            )
        else:
            if t.mention.text not in existing.source_spans:
                existing.source_spans.append(t.mention.text)
            if chunk_id not in existing.source_chunk_ids:
                existing.source_chunk_ids.append(chunk_id)
            existing.importance = max(existing.importance, min(1.0, 0.4 + t.winner_prob * 0.6))

    for name, entity in entities_acc.items():
        entity.description = "; ".join(dict.fromkeys(descriptions[name]))[:500]

    rels: list[ExtractedRelationship] = []
    seen_rel: set[tuple[str, str, str]] = set()
    for h in hits:
        rec = {
            "source": h.source_text,
            "target": h.target_text,
            "type": h.relation_type,
            "band": h.band.value,
            "prob": h.winner_prob,
            "confidence": h.confidence,
            "flipped": h.flipped,
            "sentence_id": h.sentence_id,
        }
        if h.band is GateBand.REVIEW:
            review.append({"kind": "relation", **rec})
            continue
        if h.band is GateBand.REJECT or h.relation_type == NO_RELATION:
            rejected.append({"kind": "relation", **rec})
            continue
        src = normalize_entity_name(h.source_text)
        tgt = normalize_entity_name(h.target_text)
        if not src or not tgt or src == tgt:
            rejected.append({"kind": "relation", "reason": "bad_endpoints", **rec})
            continue
        if src not in entities_acc or tgt not in entities_acc:
            review.append({"kind": "relation", "reason": "endpoint_not_accepted", **rec})
            continue
        key = (src, tgt, h.relation_type)
        if key in seen_rel:
            continue
        seen_rel.add(key)
        rels.append(
            ExtractedRelationship(
                source=src,
                target=tgt,
                relation_type=h.relation_type,
                description=h.evidence,
                weight=min(1.0, 0.4 + h.winner_prob * 0.6),
                keywords=[h.relation_type.lower().replace("_", " ")],
                source_chunk_ids=[chunk_id],
                source_document_id=document_id,
            )
        )

    return ExtractionResult(
        entities=sorted(entities_acc.values(), key=lambda e: e.name),
        relationships=rels,
        source_chunk_id=chunk_id,
        review=review,
        rejected=rejected,
        mentions=typed,
        relation_hits=hits,
    )
