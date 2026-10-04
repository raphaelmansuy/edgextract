//! Deterministic checks on a finished graph. No model judge.
//!
//! A kept triple must use an ontology label, a source sentence, and two
//! different accepted names. Anything else is a failed trace, not a graph.

use crate::error::Error;
use crate::ontology::{Ontology, NO_RELATION, NOT_ENTITY};
use crate::types::{ExtractionResult, GateBand, Sentence};
use serde_json::{json, Value};

pub fn audit_graph(
    result: &ExtractionResult,
    ontology: &Ontology,
    sentences: &[Sentence],
) -> Result<(), Error> {
    let type_ids = ontology.type_ids();
    let rel_ids = ontology.relations.iter().map(|r| r.id.as_str()).collect::<Vec<_>>();
    let sentence_text: Vec<&str> = sentences.iter().map(|s| s.text.as_str()).collect();
    let names: Vec<&str> = result.entities.iter().map(|e| e.name.as_str()).collect();

    for entity in &result.entities {
        if !type_ids.iter().any(|id| id == &entity.entity_type) {
            return Err(Error::Ontology(format!(
                "kept entity {} has type {}, which this ontology does not list",
                entity.name, entity.entity_type
            )));
        }
        if entity.description.is_empty() {
            return Err(Error::Ontology(format!(
                "kept entity {} has no source evidence",
                entity.name
            )));
        }
        if !(0.0..=1.0).contains(&entity.importance) {
            return Err(Error::Ontology(format!(
                "kept entity {} has importance {}",
                entity.name, entity.importance
            )));
        }
    }

    for rel in &result.relationships {
        if !rel_ids.contains(&rel.relation_type.as_str()) {
            return Err(Error::Ontology(format!(
                "kept link {} is not a relation in this ontology",
                rel.relation_type
            )));
        }
        if rel.source == rel.target {
            return Err(Error::Ontology(format!(
                "kept link {} has the same name on both ends",
                rel.relation_type
            )));
        }
        if !names.contains(&rel.source.as_str()) || !names.contains(&rel.target.as_str()) {
            return Err(Error::Ontology(format!(
                "kept link {} → {} is missing an accepted endpoint",
                rel.source, rel.target
            )));
        }
        if sentence_text.iter().all(|s| *s != rel.description) {
            return Err(Error::Ontology(format!(
                "kept link {} → {} is not backed by a source sentence",
                rel.source, rel.target
            )));
        }
        if !(0.0..=1.0).contains(&rel.weight) {
            return Err(Error::Ontology(format!(
                "kept link {} → {} has weight {}",
                rel.source, rel.target, rel.weight
            )));
        }
        let src_type = result
            .entities
            .iter()
            .find(|e| e.name == rel.source)
            .map(|e| e.entity_type.as_str());
        let tgt_type = result
            .entities
            .iter()
            .find(|e| e.name == rel.target)
            .map(|e| e.entity_type.as_str());
        if let (Some(src_type), Some(tgt_type)) = (src_type, tgt_type) {
            let allowed = ontology.allowed_pairs(src_type, tgt_type).unwrap_or_default();
            if !allowed.iter().any(|id| id == &rel.relation_type) {
                return Err(Error::Ontology(format!(
                    "kept link {src_type} -[{}]-> {tgt_type} is illegal for this ontology",
                    rel.relation_type
                )));
            }
        }
    }
    Ok(())
}

/// Accepted decisions only: label, probability, sentence, who decided.
pub fn lineage(result: &ExtractionResult) -> Value {
    let mut rows = Vec::new();
    for mention in &result.mentions {
        if mention.band != GateBand::Accept || mention.entity_type == NOT_ENTITY {
            continue;
        }
        rows.push(json!({
            "kind": "entity",
            "sentence_id": mention.mention.sentence_id,
            "surface": mention.mention.text,
            "label": mention.entity_type,
            "probability": mention.winner_prob,
            "decided_by": mention.decided_by,
            "question_id": mention.question_id,
        }));
    }
    for hit in &result.relation_hits {
        if hit.band != GateBand::Accept || hit.relation_type == NO_RELATION {
            continue;
        }
        rows.push(json!({
            "kind": "relation",
            "sentence_id": hit.sentence_id,
            "evidence": hit.evidence,
            "source": hit.source_text,
            "target": hit.target_text,
            "label": hit.relation_type,
            "probability": hit.winner_prob,
            "decided_by": "model",
        }));
    }
    Value::Array(rows)
}

#[cfg(test)]
mod tests {
    use super::audit_graph;
    use crate::ontology::load_ontology_named;
    use crate::types::{ExtractedEntity, ExtractedRelationship, ExtractionResult};

    #[test]
    fn illegal_kept_link_fails_closed() {
        let ontology = load_ontology_named("tech_docs").unwrap();
        let result = ExtractionResult {
            entities: vec![ExtractedEntity {
                name: "BERLIN".into(),
                entity_type: "LOCATION".into(),
                description: "Berlin".into(),
                importance: 1.0,
                source_spans: vec!["Berlin".into()],
                source_chunk_ids: vec!["c".into()],
                source_document_id: Some("d".into()),
                display_name: Some("Berlin".into()),
            }],
            relationships: vec![ExtractedRelationship {
                source: "BERLIN".into(),
                target: "BERLIN".into(),
                relation_type: "WORKS_AT".into(),
                description: "Berlin".into(),
                weight: 0.9,
                keywords: vec![],
                source_chunk_ids: vec!["c".into()],
                source_document_id: Some("d".into()),
            }],
            ..ExtractionResult::default()
        };
        let err = audit_graph(&result, &ontology, &[]).unwrap_err();
        assert!(err.to_string().contains("same name") || err.to_string().contains("illegal"));
    }
}
