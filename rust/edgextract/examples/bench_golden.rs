//! Time the wired pipeline on golden notes against a local fake SystemOne.

use edgextract::cache::DecisionCache;
use edgextract::candidates::{default_proposers, propose_mentions};
use edgextract::markdown::split_sentences;
use edgextract::ontology::load_ontology_named;
use edgextract::pipeline::Extractor;
use edgextract::systemone::SystemOneClient;
use edgextract::testing::{gazetteer_handler, start_fake_systemone};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn main() {
    let docs_dir = repo_root().join("data/golden/docs");
    let mut docs: Vec<(String, String)> = fs::read_dir(&docs_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        .map(|e| {
            let path = e.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let text = fs::read_to_string(&path).unwrap();
            (name, text)
        })
        .collect();
    docs.sort_by(|a, b| a.0.cmp(&b.0));

    let ontology = load_ontology_named("tech_docs").unwrap();
    let server = start_fake_systemone(gazetteer_handler(&ontology));
    let client = SystemOneClient::new("nimble", &server.base_url, 30.0);
    let extractor = Extractor::new(ontology.clone(), client);

    let proposers = default_proposers();
    let mut cpu_rows = Vec::new();
    for (name, text) in &docs {
        let t0 = Instant::now();
        let sents = split_sentences(text, name);
        let mut mentions = 0usize;
        for s in &sents {
            mentions += propose_mentions(s, &ontology, &proposers).len();
        }
        let ns = t0.elapsed().as_nanos();
        cpu_rows.push(json!({
            "doc": name,
            "bytes": text.len(),
            "sentences": sents.len(),
            "mentions": mentions,
            "cpu_ns": ns,
            "cpu_us": ns as f64 / 1000.0,
        }));
    }

    let repeats = 7usize;
    let mut cold_runs: Vec<Value> = Vec::new();
    for i in 0..repeats {
        let t0 = Instant::now();
        let mut rows = Vec::new();
        let mut calls = 0u64;
        let mut pairs = 0u64;
        let mut sentences = 0u64;
        let mut entities = 0u64;
        let mut rels = 0u64;
        for (name, text) in &docs {
            let result = extractor.extract_markdown(text, name).unwrap();
            let stats = &result.metadata["stats"];
            let c = stats["systemone_calls"].as_u64().unwrap_or(0);
            let p = stats["pairs_considered"].as_u64().unwrap_or(0);
            let s = stats["sentences"].as_u64().unwrap_or(0);
            calls += c;
            pairs += p;
            sentences += s;
            entities += result.entities.len() as u64;
            rels += result.relationships.len() as u64;
            rows.push(json!({
                "doc": name,
                "elapsed_ms": result.extraction_time_ms,
                "systemone_calls": c,
                "pairs_considered": p,
                "sentences": s,
                "entities": result.entities.len(),
                "relationships": result.relationships.len(),
            }));
        }
        let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
        cold_runs.push(json!({
            "i": i,
            "wall_ms": wall_ms,
            "systemone_calls": calls,
            "pairs_considered": pairs,
            "sentences": sentences,
            "entities": entities,
            "relationships": rels,
            "docs": rows,
        }));
    }

    let tmp = tempfile::tempdir().unwrap();
    let cache = DecisionCache::open(tmp.path().join("c.sqlite")).unwrap();
    let client2 = SystemOneClient::new("nimble", &server.base_url, 30.0);
    let cached_ext = Extractor::new(ontology.clone(), client2).with_cache(cache);
    let mut cache_runs: Vec<Value> = Vec::new();
    for i in 0..repeats {
        let t0 = Instant::now();
        let mut calls = 0u64;
        let mut hits = 0u64;
        for (name, text) in &docs {
            let result = cached_ext.extract_markdown(text, name).unwrap();
            let stats = &result.metadata["stats"];
            calls += stats["systemone_calls"].as_u64().unwrap_or(0);
            hits += stats["cache_hits"].as_u64().unwrap_or(0);
        }
        let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
        cache_runs.push(json!({
            "i": i,
            "wall_ms": wall_ms,
            "systemone_calls": calls,
            "cache_hits": hits,
        }));
    }

    let scale_base = fs::read_to_string(docs_dir.join("01_edgequake.md")).unwrap();
    let mut scale = Vec::new();
    for copies in [1usize, 5, 10, 25] {
        let text = scale_base.repeat(copies);
        let t0 = Instant::now();
        let result = extractor
            .extract_markdown(&text, &format!("scale-{copies}"))
            .unwrap();
        let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let stats = &result.metadata["stats"];
        scale.push(json!({
            "copies": copies,
            "bytes": text.len(),
            "wall_ms": wall_ms,
            "elapsed_ms": result.extraction_time_ms,
            "sentences": stats["sentences"],
            "systemone_calls": stats["systemone_calls"],
            "pairs_considered": stats["pairs_considered"],
        }));
    }

    server.stop();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "impl": "rust",
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "repeats": repeats,
            "cpu_parse_propose": cpu_rows,
            "cold": cold_runs,
            "cached": cache_runs,
            "scale_edgequake": scale,
        }))
        .unwrap()
    );
}
