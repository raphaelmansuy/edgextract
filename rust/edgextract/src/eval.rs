//! Offline scores against a golden set. Deterministic. No model judge.

use crate::names::normalize_entity_name;
use crate::ontology::{NO_RELATION, NOT_ENTITY};
use crate::types::{ExtractionResult, GateBand};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug, Default)]
pub struct Prf {
    pub tp: f64,
    pub fp: f64,
    pub fn_: f64,
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
    pub support: f64,
}

pub fn entity_key(name: &str, entity_type: &str) -> (String, String) {
    (normalize_entity_name(name), entity_type.to_uppercase())
}

pub fn relation_key(source: &str, target: &str, relation_type: &str) -> (String, String, String) {
    (
        normalize_entity_name(source),
        normalize_entity_name(target),
        relation_type.to_uppercase(),
    )
}

pub fn prf(predicted: &HashSet<Vec<String>>, gold: &HashSet<Vec<String>>) -> Prf {
    let tp = predicted.intersection(gold).count() as f64;
    let fp = predicted.difference(gold).count() as f64;
    let fn_ = gold.difference(predicted).count() as f64;
    let precision = if tp + fp > 0.0 { tp / (tp + fp) } else { 0.0 };
    let recall = if tp + fn_ > 0.0 { tp / (tp + fn_) } else { 0.0 };
    let f1 = if precision + recall > 0.0 {
        2.0 * precision * recall / (precision + recall)
    } else {
        0.0
    };
    Prf {
        tp,
        fp,
        fn_,
        precision,
        recall,
        f1,
        support: gold.len() as f64,
    }
}

pub fn score_result(pred: &ExtractionResult, gold: &Value) -> (Prf, Prf) {
    let mut gold_ents = HashSet::new();
    for e in gold.get("entities").and_then(|v| v.as_array()).into_iter().flatten() {
        let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let typ = e.get("type").or_else(|| e.get("entity_type")).and_then(|v| v.as_str()).unwrap_or("");
        let key = entity_key(name, typ);
        gold_ents.insert(vec![key.0, key.1]);
    }
    let mut gold_rels = HashSet::new();
    let rels = gold
        .get("relations")
        .or_else(|| gold.get("relationships"))
        .and_then(|v| v.as_array());
    for r in rels.into_iter().flatten() {
        let key = relation_key(
            r.get("source").and_then(|v| v.as_str()).unwrap_or(""),
            r.get("target").and_then(|v| v.as_str()).unwrap_or(""),
            r.get("type")
                .or_else(|| r.get("relation_type"))
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        );
        gold_rels.insert(vec![key.0, key.1, key.2]);
    }
    let pred_ents: HashSet<_> = pred
        .entities
        .iter()
        .map(|e| {
            let key = entity_key(&e.name, &e.entity_type);
            vec![key.0, key.1]
        })
        .collect();
    let pred_rels: HashSet<_> = pred
        .relationships
        .iter()
        .map(|r| {
            let key = relation_key(&r.source, &r.target, &r.relation_type);
            vec![key.0, key.1, key.2]
        })
        .collect();
    (prf(&pred_ents, &gold_ents), prf(&pred_rels, &gold_rels))
}

pub fn micro_average(rows: &[Prf]) -> Prf {
    let tp: f64 = rows.iter().map(|r| r.tp).sum();
    let fp: f64 = rows.iter().map(|r| r.fp).sum();
    let fn_: f64 = rows.iter().map(|r| r.fn_).sum();
    prf_counts(tp, fp, fn_)
}

pub fn gold_has_spans(gold: &Value) -> bool {
    let Some(ents) = gold.get("entities").and_then(|v| v.as_array()) else {
        return false;
    };
    !ents.is_empty()
        && ents
            .iter()
            .all(|e| e.get("start").is_some() && e.get("end").is_some())
}

#[derive(Clone, Debug, Default)]
pub struct SpanScore {
    pub entities: Prf,
    pub relations: Prf,
    pub boundary_only: f64,
    pub direction_swaps: f64,
    pub pred_entity_spans: f64,
    pub gold_entity_spans: f64,
    pub pred_relation_spans: f64,
    pub gold_relation_spans: f64,
}

pub fn score_spans(pred: &ExtractionResult, gold: &Value) -> SpanScore {
    let mut gold_ents = HashSet::new();
    for e in gold.get("entities").and_then(|v| v.as_array()).into_iter().flatten() {
        let start = e.get("start").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = e.get("end").and_then(|v| v.as_u64()).unwrap_or(0);
        let typ = e
            .get("type")
            .or_else(|| e.get("entity_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_uppercase();
        gold_ents.insert((start, end, typ));
    }
    let gold_spans: HashSet<_> = gold_ents.iter().map(|(s, e, _)| (*s, *e)).collect();
    let mut gold_rels = HashSet::new();
    let rels = gold
        .get("relations")
        .or_else(|| gold.get("relationships"))
        .and_then(|v| v.as_array());
    for r in rels.into_iter().flatten() {
        if r.get("source_start").is_none() {
            continue;
        }
        gold_rels.insert((
            r.get("source_start").and_then(|v| v.as_u64()).unwrap_or(0),
            r.get("source_end").and_then(|v| v.as_u64()).unwrap_or(0),
            r.get("target_start").and_then(|v| v.as_u64()).unwrap_or(0),
            r.get("target_end").and_then(|v| v.as_u64()).unwrap_or(0),
            r.get("type")
                .or_else(|| r.get("relation_type"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_uppercase(),
        ));
    }
    let mut pred_ents = HashSet::new();
    for t in &pred.mentions {
        if t.band != GateBand::Accept || t.entity_type == NOT_ENTITY {
            continue;
        }
        pred_ents.insert((
            t.mention.start as u64,
            t.mention.end as u64,
            t.entity_type.to_uppercase(),
        ));
    }
    let mut pred_rels = HashSet::new();
    for h in &pred.relation_hits {
        if h.band != GateBand::Accept || h.relation_type == NO_RELATION {
            continue;
        }
        pred_rels.insert((
            h.source_start as u64,
            h.source_end as u64,
            h.target_start as u64,
            h.target_end as u64,
            h.relation_type.to_uppercase(),
        ));
    }
    let mut boundary_only = 0.0;
    for (s, e, typ) in &pred_ents {
        if gold_spans.contains(&(*s, *e)) && !gold_ents.contains(&(*s, *e, typ.clone())) {
            boundary_only += 1.0;
        }
    }
    let mut direction_swaps = 0.0;
    for (a, b, c, d, t) in &pred_rels {
        if gold_rels.contains(&(*a, *b, *c, *d, t.clone())) {
            continue;
        }
        if gold_rels.contains(&(*c, *d, *a, *b, t.clone())) {
            direction_swaps += 1.0;
        }
    }
    let pred_e: HashSet<Vec<String>> = pred_ents
        .iter()
        .map(|(s, e, t)| vec![s.to_string(), e.to_string(), t.clone()])
        .collect();
    let gold_e: HashSet<Vec<String>> = gold_ents
        .iter()
        .map(|(s, e, t)| vec![s.to_string(), e.to_string(), t.clone()])
        .collect();
    let pred_r: HashSet<Vec<String>> = pred_rels
        .iter()
        .map(|(a, b, c, d, t)| vec![a.to_string(), b.to_string(), c.to_string(), d.to_string(), t.clone()])
        .collect();
    let gold_r: HashSet<Vec<String>> = gold_rels
        .iter()
        .map(|(a, b, c, d, t)| vec![a.to_string(), b.to_string(), c.to_string(), d.to_string(), t.clone()])
        .collect();
    SpanScore {
        entities: prf(&pred_e, &gold_e),
        relations: prf(&pred_r, &gold_r),
        boundary_only,
        direction_swaps,
        pred_entity_spans: pred_ents.len() as f64,
        gold_entity_spans: gold_ents.len() as f64,
        pred_relation_spans: pred_rels.len() as f64,
        gold_relation_spans: gold_rels.len() as f64,
    }
}

fn prf_counts(tp: f64, fp: f64, fn_: f64) -> Prf {
    let precision = if tp + fp > 0.0 { tp / (tp + fp) } else { 0.0 };
    let recall = if tp + fn_ > 0.0 { tp / (tp + fn_) } else { 0.0 };
    let f1 = if precision + recall > 0.0 {
        2.0 * precision * recall / (precision + recall)
    } else {
        0.0
    };
    Prf {
        tp,
        fp,
        fn_,
        precision,
        recall,
        f1,
        support: tp + fn_,
    }
}

#[cfg(test)]
mod tests {
    use super::{micro_average, score_result};
    use crate::types::{ExtractedEntity, ExtractedRelationship, ExtractionResult};
    use serde_json::json;

    #[test]
    fn score_spans_exact_and_boundary() {
        use crate::types::{GateBand, Mention, MentionSource, RelationHit, TypedMention};
        let gold = json!({
            "entities": [
                {"name": "Jane Doe", "type": "PERSON", "start": 0, "end": 8},
                {"name": "Berlin", "type": "LOCATION", "start": 20, "end": 26},
            ],
            "relations": [{
                "source": "Jane Doe",
                "target": "Berlin",
                "type": "LIVES_IN",
                "source_start": 0,
                "source_end": 8,
                "target_start": 20,
                "target_end": 26,
            }]
        });
        let pred = ExtractionResult {
            mentions: vec![
                TypedMention {
                    mention: Mention {
                        text: "Jane Doe".into(),
                        start: 0,
                        end: 8,
                        sentence_id: "s0".into(),
                        heading_path: vec![],
                        source: MentionSource::Encoder,
                        skipped_reason: None,
                    },
                    entity_type: "PERSON".into(),
                    probabilities: Default::default(),
                    confidence: None,
                    band: GateBand::Accept,
                    winner_prob: 1.0,
                    flipped: false,
                    question_id: String::new(),
                    decided_by: "model".into(),
                },
                TypedMention {
                    mention: Mention {
                        text: "Berlin".into(),
                        start: 20,
                        end: 26,
                        sentence_id: "s0".into(),
                        heading_path: vec![],
                        source: MentionSource::Encoder,
                        skipped_reason: None,
                    },
                    entity_type: "ORGANIZATION".into(),
                    probabilities: Default::default(),
                    confidence: None,
                    band: GateBand::Accept,
                    winner_prob: 0.9,
                    flipped: false,
                    question_id: String::new(),
                    decided_by: "model".into(),
                },
            ],
            relation_hits: vec![RelationHit {
                source_text: "Jane Doe".into(),
                source_type: "PERSON".into(),
                source_start: 0,
                source_end: 8,
                target_text: "Berlin".into(),
                target_type: "ORGANIZATION".into(),
                target_start: 20,
                target_end: 26,
                relation_type: "LIVES_IN".into(),
                asked: "LIVES_IN".into(),
                probabilities: Default::default(),
                confidence: None,
                band: GateBand::Accept,
                winner_prob: 0.8,
                flipped: false,
                sentence_id: "s0".into(),
                heading_path: vec![],
                evidence: String::new(),
            }],
            ..ExtractionResult::default()
        };
        let scored = crate::eval::score_spans(&pred, &gold);
        assert!((scored.entities.tp - 1.0).abs() < 1e-9);
        assert!((scored.entities.fp - 1.0).abs() < 1e-9);
        assert!((scored.boundary_only - 1.0).abs() < 1e-9);
        assert!((scored.relations.tp - 1.0).abs() < 1e-9);
    }

    #[test]
    fn scores_name_and_type_not_surface_spelling() {
        let pred = ExtractionResult {
            entities: vec![ExtractedEntity {
                name: "JANE_DOE".into(),
                entity_type: "PERSON".into(),
                description: "Jane Doe joined.".into(),
                importance: 1.0,
                source_spans: vec![],
                source_chunk_ids: vec![],
                source_document_id: None,
                display_name: None,
            }],
            relationships: vec![ExtractedRelationship {
                source: "JANE_DOE".into(),
                target: "ACME_INC".into(),
                relation_type: "WORKS_AT".into(),
                description: "Jane Doe joined Acme Inc.".into(),
                weight: 0.9,
                keywords: vec![],
                source_chunk_ids: vec![],
                source_document_id: None,
            }],
            ..ExtractionResult::default()
        };
        let gold = json!({
            "entities": [{"name": "Jane Doe", "type": "PERSON"}, {"name": "Acme Inc", "type": "ORGANIZATION"}],
            "relations": [{"source": "Jane Doe", "target": "Acme Inc", "type": "WORKS_AT"}]
        });
        let (ents, rels) = score_result(&pred, &gold);
        assert!((ents.precision - 1.0).abs() < 1e-9);
        assert!((ents.recall - 0.5).abs() < 1e-9);
        assert!((rels.f1 - 1.0).abs() < 1e-9);
        let micro = micro_average(&[ents]);
        assert!((micro.tp - 1.0).abs() < 1e-9);
        assert!((micro.fn_ - 1.0).abs() < 1e-9);
    }
}
