//! Merge typed mentions and relation hits into EdgeQuake-shaped records.

use crate::names::normalize_entity_name;
use crate::ontology::{Ontology, NO_RELATION, NOT_ENTITY};
use crate::types::{
    ExtractedEntity, ExtractedRelationship, ExtractionResult, GateBand, RelationHit, TypedMention,
};
use indexmap::IndexMap;
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub fn assemble(
    typed: Vec<TypedMention>,
    hits: Vec<RelationHit>,
    _ontology: &Ontology,
    document_id: &str,
    chunk_id: &str,
) -> ExtractionResult {
    let mut entities_acc: IndexMap<String, ExtractedEntity> = IndexMap::new();
    let mut descriptions: HashMap<String, Vec<String>> = HashMap::new();
    let mut review = Vec::new();
    let mut rejected = Vec::new();

    for t in &typed {
        let rec = json!({
            "text": t.mention.text,
            "type": t.entity_type,
            "band": t.band.as_str(),
            "prob": t.winner_prob,
            "confidence": t.confidence,
            "flipped": t.flipped,
            "span": [t.mention.start, t.mention.end],
            "sentence_id": t.mention.sentence_id,
        });
        if t.band == GateBand::Review {
            let mut obj = rec.as_object().cloned().unwrap_or_default();
            obj.insert("kind".into(), json!("entity"));
            review.push(serde_json::Value::Object(obj));
            continue;
        }
        if t.band == GateBand::Reject || t.entity_type == NOT_ENTITY {
            let mut obj = rec.as_object().cloned().unwrap_or_default();
            obj.insert("kind".into(), json!("entity"));
            rejected.push(serde_json::Value::Object(obj));
            continue;
        }
        let name = normalize_entity_name(&t.mention.text);
        if name.is_empty() {
            let mut obj = rec.as_object().cloned().unwrap_or_default();
            obj.insert("kind".into(), json!("entity"));
            obj.insert("reason".into(), json!("opaque_or_empty_name"));
            rejected.push(serde_json::Value::Object(obj));
            continue;
        }
        let evidence = t.mention.text.clone();
        descriptions.entry(name.clone()).or_default().push(evidence.clone());
        if let Some(existing) = entities_acc.get_mut(&name) {
            if !existing.source_spans.contains(&t.mention.text) {
                existing.source_spans.push(t.mention.text.clone());
            }
            if !existing.source_chunk_ids.iter().any(|c| c == chunk_id) {
                existing.source_chunk_ids.push(chunk_id.to_string());
            }
            existing.importance = existing.importance.max(t.winner_prob);
        } else {
            entities_acc.insert(
                name.clone(),
                ExtractedEntity {
                    name: name.clone(),
                    entity_type: t.entity_type.clone(),
                    description: evidence,
                    importance: t.winner_prob,
                    source_spans: vec![t.mention.text.clone()],
                    source_chunk_ids: vec![chunk_id.to_string()],
                    source_document_id: Some(document_id.to_string()),
                    display_name: Some(t.mention.text.clone()),
                },
            );
        }
    }

    for (name, entity) in entities_acc.iter_mut() {
        let mut seen = HashSet::new();
        let joined: Vec<&str> = descriptions
            .get(name)
            .map(|d| {
                d.iter()
                    .filter(|s| seen.insert((*s).as_str()))
                    .map(|s| s.as_str())
                    .collect()
            })
            .unwrap_or_default();
        let text = joined.join("; ");
        entity.description = text.chars().take(500).collect();
    }

    let mut rels = Vec::new();
    let mut seen_rel: HashSet<(String, String, String)> = HashSet::new();
    for h in &hits {
        let rec = json!({
            "source": h.source_text,
            "target": h.target_text,
            "type": h.relation_type,
            "asked": h.asked,
            "band": h.band.as_str(),
            "prob": h.winner_prob,
            "confidence": h.confidence,
            "flipped": h.flipped,
            "sentence_id": h.sentence_id,
        });
        if h.band == GateBand::Review {
            let mut obj = rec.as_object().cloned().unwrap_or_default();
            obj.insert("kind".into(), json!("relation"));
            review.push(serde_json::Value::Object(obj));
            continue;
        }
        if h.band == GateBand::Reject || h.relation_type == NO_RELATION {
            let mut obj = rec.as_object().cloned().unwrap_or_default();
            obj.insert("kind".into(), json!("relation"));
            rejected.push(serde_json::Value::Object(obj));
            continue;
        }
        let src = normalize_entity_name(&h.source_text);
        let tgt = normalize_entity_name(&h.target_text);
        if src.is_empty() || tgt.is_empty() || src == tgt {
            let mut obj = rec.as_object().cloned().unwrap_or_default();
            obj.insert("kind".into(), json!("relation"));
            obj.insert("reason".into(), json!("bad_endpoints"));
            rejected.push(serde_json::Value::Object(obj));
            continue;
        }
        if !entities_acc.contains_key(&src) || !entities_acc.contains_key(&tgt) {
            let mut obj = rec.as_object().cloned().unwrap_or_default();
            obj.insert("kind".into(), json!("relation"));
            obj.insert("reason".into(), json!("endpoint_not_accepted"));
            review.push(serde_json::Value::Object(obj));
            continue;
        }
        let key = (src.clone(), tgt.clone(), h.relation_type.clone());
        if !seen_rel.insert(key.clone()) {
            continue;
        }
        rels.push(ExtractedRelationship {
            source: src,
            target: tgt,
            relation_type: h.relation_type.clone(),
            description: h.evidence.clone(),
            weight: h.winner_prob,
            keywords: vec![h.relation_type.to_lowercase().replace('_', " ")],
            source_chunk_ids: vec![chunk_id.to_string()],
            source_document_id: Some(document_id.to_string()),
        });
    }

    let mut entities: Vec<_> = entities_acc.into_values().collect();
    entities.sort_by(|a, b| a.name.cmp(&b.name));

    ExtractionResult {
        entities,
        relationships: rels,
        source_chunk_id: chunk_id.to_string(),
        review,
        rejected,
        mentions: typed,
        relation_hits: hits,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::assemble;
    use crate::ontology::ontology_from_value;
    use crate::types::{GateBand, Mention, MentionSource, TypedMention};

    #[test]
    fn opaque_name_rejected() {
        let mention = Mention {
            text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            start: 0,
            end: 32,
            sentence_id: "s".into(),
            heading_path: vec![],
            source: MentionSource::Shape,
            skipped_reason: None,
        };
        let tm = TypedMention {
            mention,
            entity_type: "PERSON".into(),
            probabilities: [("PERSON".into(), 0.9)].into_iter().collect(),
            confidence: None,
            band: GateBand::Accept,
            winner_prob: 0.9,
            flipped: false,
            question_id: String::new(),
            decided_by: "model".into(),
        };
        let ont = ontology_from_value(&serde_json::json!({
            "id": "x",
            "types": [{"id": "PERSON", "description": "p"}, {"id": "ORG", "description": "o"}],
            "relations": [],
        }))
        .unwrap();
        let result = assemble(vec![tm], vec![], &ont, "d", "c");
        assert!(result.entities.is_empty());
        assert!(result
            .rejected
            .iter()
            .any(|x| x.get("reason").and_then(|v| v.as_str()) == Some("opaque_or_empty_name")));
    }
}
