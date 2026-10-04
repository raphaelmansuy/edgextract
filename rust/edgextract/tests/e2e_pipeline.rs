use edgextract::cache::DecisionCache;
use edgextract::error::SystemOneError;
use edgextract::gate::GateConfig;
use edgextract::ontology::load_ontology_named;
use edgextract::pipeline::Extractor;
use edgextract::systemone::SystemOneClient;
use edgextract::testing::{gazetteer_handler, start_fake_systemone};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn golden(name: &str) -> String {
    fs::read_to_string(repo_root().join("data/golden/docs").join(name)).unwrap()
}

#[test]
fn e2e_edgequake_doc() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("nimble", &server.base_url, 5.0);
    let dir = tempfile::tempdir().unwrap();
    let cache = DecisionCache::open(dir.path().join("c.sqlite")).unwrap();
    let ext = Extractor::new(ontology, client)
        .with_gate(GateConfig::default())
        .with_cache(cache);
    let text = golden("01_edgequake.md");
    let result = ext.extract_markdown(&text, "01_edgequake").unwrap();
    let names: Vec<_> = result.entities.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"ACME_INC"));
    assert!(names.contains(&"JANE_DOE"));
    assert!(names.contains(&"EDGEQUAKE"));
    let jane = result
        .entities
        .iter()
        .find(|e| e.name == "JANE_DOE")
        .unwrap();
    assert_eq!(jane.entity_type, "PERSON");
    let pg = result
        .entities
        .iter()
        .find(|e| e.name == "POSTGRESQL")
        .unwrap();
    assert_eq!(pg.entity_type, "TECHNOLOGY");
    let rels: Vec<_> = result
        .relationships
        .iter()
        .map(|r| (r.source.as_str(), r.relation_type.as_str(), r.target.as_str()))
        .collect();
    assert!(rels.contains(&("JANE_DOE", "WORKS_AT", "ACME_INC")));
    assert!(
        result.metadata["stats"]["systemone_calls"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    let result2 = ext.extract_markdown(&text, "01_edgequake").unwrap();
    assert!(
        result2.metadata["stats"]["cache_hits"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    assert!(result.entities.iter().all(|e| !e.source_chunk_ids.is_empty()));
        assert!(result
            .relationships
            .iter()
            .all(|r| !r.source_chunk_ids.is_empty()));
        assert_eq!(
            result.metadata["contract"].as_str(),
            Some(edgextract::DECISION_CONTRACT)
        );
        assert!(result.metadata["lineage"].as_array().unwrap().len() >= 1);
        assert!(!result.metadata["gate_fitted"].as_bool().unwrap());
        server.stop();
}

#[test]
fn e2e_negation_no_relation() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("nimble", &server.base_url, 5.0);
    let ext = Extractor::new(ontology, client);
    let result = ext
        .extract_markdown(&golden("05_negation.md"), "05")
        .unwrap();
    assert!(!result.entities.is_empty());
    assert!(result.relationships.is_empty());
    server.stop();
}

#[test]
fn e2e_pronouns_skipped() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("nimble", &server.base_url, 5.0);
    let ext = Extractor::new(ontology, client);
    let result = ext
        .extract_markdown(&golden("10_pronouns.md"), "10")
        .unwrap();
    let names: Vec<_> = result.entities.iter().map(|e| e.name.as_str()).collect();
    assert!(!names.contains(&"SHE"));
    assert!(!names.contains(&"THEY"));
    assert!(names.contains(&"JANE_DOE"));
    server.stop();
}

#[test]
fn e2e_empty_doc() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("nimble", &server.base_url, 5.0);
    let result = Extractor::new(ontology, client)
        .extract_markdown("   \n", "doc")
        .unwrap();
    assert!(result.entities.is_empty());
    assert!(result.relationships.is_empty());
    assert_eq!(
        result.metadata["stats"]["systemone_calls"]
            .as_u64()
            .unwrap_or(99),
        0
    );
    server.stop();
}

#[test]
fn e2e_self_loop_dropped() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("nimble", &server.base_url, 5.0);
    let result = Extractor::new(ontology, client)
        .extract_markdown(&golden("11_selfloop.md"), "doc")
        .unwrap();
    let loops: Vec<_> = result
        .relationships
        .iter()
        .filter(|r| r.source == r.target)
        .collect();
    assert!(loops.is_empty());
    server.stop();
}

#[test]
fn transport_404_fails_closed() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(Arc::new(|_body: Value| Err("nope".into())));
    let client = SystemOneClient::new("nimble", &server.base_url, 5.0);
    let err = Extractor::new(ontology, client)
        .extract_markdown("Jane Doe joined Acme Inc.", "doc")
        .unwrap_err();
    match err {
        edgextract::Error::SystemOne(SystemOneError(_)) => {}
        other => panic!("expected SystemOneError, got {other}"),
    }
    server.stop();
}

#[test]
fn atomic_noul_accepts_each_legal_predicate() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(Arc::new(|body: Value| {
        let questions = body["questions"].as_object().cloned().unwrap_or_default();
        let mut answers = serde_json::Map::new();
        for (qid, q) in questions {
            if q.get("type").and_then(|v| v.as_str()) != Some("noul") {
                return Err(format!("relation questions are noul, got {:?}", q.get("type")));
            }
            let text = q.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
            let yes = text.contains("USES") || text.contains("DEPENDS_ON");
            answers.insert(
                qid,
                serde_json::json!({"type": "noul", "noul": if yes { 0.95 } else { 0.05 }}),
            );
        }
        Ok(serde_json::json!({
            "model": "n",
            "answers": answers,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }))
    }));
    let client = SystemOneClient::new("n", &server.base_url, 5.0);
    let result = Extractor::new(ontology, client)
        .extract_markdown("EdgeQuake depends on PostgreSQL.", "doc")
        .unwrap();
    let rels: Vec<_> = result
        .relationships
        .iter()
        .map(|r| (r.source.as_str(), r.relation_type.as_str(), r.target.as_str()))
        .collect();
    assert!(rels.contains(&("EDGEQUAKE", "USES", "POSTGRESQL")));
    assert!(rels.contains(&("EDGEQUAKE", "DEPENDS_ON", "POSTGRESQL")));
    assert!(result.relationships.iter().all(|r| (r.weight - 0.95).abs() < 1e-9));
    assert!(!rels.contains(&("EDGEQUAKE", "PART_OF", "POSTGRESQL")));
    server.stop();
}

#[test]
fn pair_cap_reports_truncated() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("n", &server.base_url, 5.0);
    let ext = Extractor::new(ontology, client).with_max_pairs(1);
    let result = ext
        .extract_markdown(&golden("01_edgequake.md"), "doc")
        .unwrap();
    assert!(
        result.metadata["stats"]["pairs_truncated"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    server.stop();
}

#[test]
fn packed_questions_cut_systemone_calls() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let text = golden("01_edgequake.md");
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let split = Extractor::new(ontology.clone(), SystemOneClient::new("n", &server.base_url, 5.0))
        .with_max_questions(1)
        .extract_markdown(&text, "doc")
        .unwrap();
    let packed = Extractor::new(ontology, SystemOneClient::new("n", &server.base_url, 5.0))
        .with_max_questions(64)
        .extract_markdown(&text, "doc")
        .unwrap();
    let split_calls = split.metadata["stats"]["systemone_calls"]
        .as_u64()
        .unwrap();
    let packed_calls = packed.metadata["stats"]["systemone_calls"]
        .as_u64()
        .unwrap();
    assert!(
        packed_calls < split_calls,
        "packed {packed_calls} should be below one-question-per-call {split_calls}"
    );
    let names: Vec<_> = packed.entities.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"JANE_DOE"));
    server.stop();
}

#[test]
fn packed_negation_does_not_poison_other_sentence() {
    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("n", &server.base_url, 5.0);
    let result = Extractor::new(ontology, client)
        .extract_markdown(
            "Jane Doe joined Acme Inc in Berlin.\nJane Doe did not found Ollama.\n",
            "doc",
        )
        .unwrap();
    let rels: Vec<_> = result
        .relationships
        .iter()
        .map(|r| (r.source.as_str(), r.relation_type.as_str(), r.target.as_str()))
        .collect();
    assert!(
        rels.iter().any(|r| r.0 == "JANE_DOE" && r.2 == "ACME_INC"),
        "positive sentence should still keep a link, got {rels:?}"
    );
    assert!(
        !rels.iter().any(|r| r.2 == "OLLAMA"),
        "negated sentence should not keep a link to Ollama, got {rels:?}"
    );
    server.stop();
}

#[test]
fn pipeline_with_fixed_encoder() {
    use edgextract::benchmarks::{convert_document, load_raw_split};
    use edgextract::candidates::Proposer;
    use edgextract::eval::score_spans;
    use edgextract::span_encoder::{EncoderProposer, FixedSpanEncoder};
    use edgextract::types::Sentence;
    use std::sync::Arc;
    use std::time::Instant;

    let ontology = load_ontology_named("conll04").unwrap();
    let path = repo_root().join("tests/fixtures/conll04_sample.json");
    let raw = load_raw_split(&path).unwrap();
    let doc = convert_document(&raw[1], "sample").unwrap();
    let text = doc["text"].as_str().unwrap().to_string();
    let spans: Vec<_> = doc["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["start"].as_u64().unwrap() as usize,
                e["end"].as_u64().unwrap() as usize,
                0.99,
            )
        })
        .collect();
    let encoder = Arc::new(FixedSpanEncoder::new(spans));
    let proposers: Vec<Box<dyn Proposer>> =
        vec![Box::new(EncoderProposer::new(encoder, 0.5))];
    let server = start_fake_systemone(Arc::new(|body: Value| {
        let questions = body
            .get("questions")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let mut answers = serde_json::Map::new();
        for (qid, q) in questions {
            if q.get("type").and_then(|v| v.as_str()) == Some("noul") {
                answers.insert(qid, serde_json::json!({"type": "noul", "noul": 0.95}));
                continue;
            }
            let criteria: Vec<String> = q
                .get("criteria")
                .and_then(|v| v.as_object())
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            let pick = ["PERSON", "ORGANIZATION", "LOCATION", "WORKS_FOR", "OTHER"]
                .into_iter()
                .find(|k| criteria.iter().any(|c| c == k))
                .map(|s| s.to_string())
                .or_else(|| criteria.first().cloned())
                .unwrap_or_else(|| "OTHER".into());
            let n = criteria.len().max(1) as f64;
            let mut probs = serde_json::Map::new();
            for k in &criteria {
                probs.insert(
                    k.clone(),
                    serde_json::json!(if k == &pick { 0.9 } else { 0.1 / (n - 1.0).max(1.0) }),
                );
            }
            answers.insert(
                qid,
                serde_json::json!({
                    "type": "choice",
                    "choice": pick,
                    "probabilities": probs,
                    "confidence": 0.9
                }),
            );
        }
        Ok(serde_json::json!({
            "model": "fake",
            "answers": answers,
            "usage": {"input_tokens": 1, "output_tokens": 1}
        }))
    }));
    let client = SystemOneClient::new("fake", &server.base_url, 5.0);
    let extractor = Extractor::new(ontology, client).with_proposers(proposers);
    let sent = Sentence {
        id: "s0".into(),
        text: text.clone(),
        start: 0,
        end: text.len(),
        heading_path: vec![],
        index: 0,
    };
    let result = extractor
        .extract_sentences(
            &[sent],
            doc["id"].as_str().unwrap(),
            "sample-chunk-0",
            Instant::now(),
            0.0,
        )
        .unwrap();
    let scored = score_spans(&result, &doc);
    assert!(scored.entities.recall > 0.0);
    assert!(scored.pred_entity_spans >= 1.0);
    server.stop();
}
