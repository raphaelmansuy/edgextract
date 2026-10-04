//! Convert SpERT CoNLL04 JSON into span-labeled gold.

use crate::error::{Error, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const ENTITY_TYPE_MAP: &[(&str, &str)] = &[
    ("Peop", "PERSON"),
    ("Org", "ORGANIZATION"),
    ("Loc", "LOCATION"),
    ("Other", "OTHER"),
];

pub const RELATION_TYPE_MAP: &[(&str, &str)] = &[
    ("Work_For", "WORKS_FOR"),
    ("Kill", "KILL"),
    ("OrgBased_In", "ORG_BASED_IN"),
    ("Live_In", "LIVES_IN"),
    ("Located_In", "LOCATED_IN"),
];

pub const EXPECTED_DOMAIN_RANGE: &[(&str, &str, &str)] = &[
    ("WORKS_FOR", "PERSON", "ORGANIZATION"),
    ("KILL", "PERSON", "PERSON"),
    ("ORG_BASED_IN", "ORGANIZATION", "LOCATION"),
    ("LIVES_IN", "PERSON", "LOCATION"),
    ("LOCATED_IN", "LOCATION", "LOCATION"),
];

pub fn tokens_to_text(tokens: &[String]) -> String {
    tokens.join(" ")
}

pub fn token_char_spans(tokens: &[String]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut pos = 0;
    for (i, tok) in tokens.iter().enumerate() {
        let start = pos;
        let end = pos + tok.len();
        spans.push((start, end));
        pos = end + if i + 1 < tokens.len() { 1 } else { 0 };
    }
    spans
}

fn map_lookup(table: &[(&str, &str)], key: &str) -> Result<String> {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| (*v).to_string())
        .ok_or_else(|| Error::Io(format!("unknown CoNLL04 label {key}")))
}

pub fn load_raw_split(path: impl AsRef<Path>) -> Result<Vec<Value>> {
    let raw: Value = serde_json::from_str(&fs::read_to_string(path.as_ref())?)
        .map_err(|e| Error::Io(e.to_string()))?;
    raw.as_array()
        .cloned()
        .ok_or_else(|| Error::Io("expected a list of documents".into()))
}

pub fn convert_document(raw: &Value, doc_id: &str) -> Result<Value> {
    let tokens: Vec<String> = raw
        .get("tokens")
        .and_then(|v| v.as_array())
        .ok_or_else(|| Error::Io("missing tokens".into()))?
        .iter()
        .map(|t| t.as_str().unwrap_or("").to_string())
        .collect();
    let text = tokens_to_text(&tokens);
    let char_spans = token_char_spans(&tokens);
    let mut entities = Vec::new();
    for (idx, ent) in raw
        .get("entities")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .enumerate()
    {
        let t_start = ent.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let t_end = ent.get("end").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        if t_start >= t_end || t_end > tokens.len() {
            return Err(Error::Io(format!("bad entity token span in {doc_id}")));
        }
        let c_start = char_spans[t_start].0;
        let c_end = char_spans[t_end - 1].1;
        let surface = text[c_start..c_end].to_string();
        let etype = map_lookup(
            ENTITY_TYPE_MAP,
            ent.get("type").and_then(|v| v.as_str()).unwrap_or(""),
        )?;
        entities.push(json!({
            "name": surface,
            "type": etype,
            "start": c_start,
            "end": c_end,
            "token_start": t_start,
            "token_end": t_end,
            "index": idx,
        }));
    }
    let mut relations = Vec::new();
    for rel in raw
        .get("relations")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let head_i = rel.get("head").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let tail_i = rel.get("tail").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let head = entities
            .get(head_i)
            .ok_or_else(|| Error::Io(format!("bad relation head in {doc_id}")))?;
        let tail = entities
            .get(tail_i)
            .ok_or_else(|| Error::Io(format!("bad relation tail in {doc_id}")))?;
        let rtype = map_lookup(
            RELATION_TYPE_MAP,
            rel.get("type").and_then(|v| v.as_str()).unwrap_or(""),
        )?;
        let expected = EXPECTED_DOMAIN_RANGE
            .iter()
            .find(|(k, _, _)| *k == rtype)
            .map(|(_, d, r)| (*d, *r));
        let actual = (
            head.get("type").and_then(|v| v.as_str()).unwrap_or(""),
            tail.get("type").and_then(|v| v.as_str()).unwrap_or(""),
        );
        if expected != Some(actual) {
            return Err(Error::Io(format!(
                "domain/range violation for {rtype} in {doc_id}"
            )));
        }
        relations.push(json!({
            "source": head.get("name"),
            "target": tail.get("name"),
            "type": rtype,
            "source_start": head.get("start"),
            "source_end": head.get("end"),
            "target_start": tail.get("start"),
            "target_end": tail.get("end"),
            "head": head_i,
            "tail": tail_i,
        }));
    }
    Ok(json!({
        "id": doc_id,
        "text": text,
        "tokens": tokens,
        "entities": entities,
        "relations": relations,
        "orig_id": raw.get("orig_id"),
    }))
}

pub fn convert_split(raw_docs: &[Value], split: &str) -> Result<Vec<Value>> {
    raw_docs
        .iter()
        .enumerate()
        .map(|(i, raw)| convert_document(raw, &format!("{split}_{i:04}")))
        .collect()
}

pub fn load_converted_json(path: impl AsRef<Path>) -> Result<Vec<Value>> {
    let raw = load_raw_split(path.as_ref())?;
    if looks_converted(&raw) {
        Ok(raw)
    } else {
        convert_split(&raw, "split")
    }
}

fn looks_converted(docs: &[Value]) -> bool {
    let Some(ent) = docs
        .first()
        .and_then(|d| d.get("entities"))
        .and_then(|e| e.as_array())
        .and_then(|e| e.first())
    else {
        return false;
    };
    ent.get("name").is_some()
        && ent.get("start").is_some()
        && ent
            .get("type")
            .and_then(|t| t.as_str())
            .map(|s| s.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_char_spans_roundtrip() {
        let tokens = vec![
            "John".into(),
            "Wilkes".into(),
            "Booth".into(),
        ];
        let text = tokens_to_text(&tokens);
        let spans = token_char_spans(&tokens);
        assert_eq!(text, "John Wilkes Booth");
        assert_eq!(spans, vec![(0, 4), (5, 11), (12, 17)]);
        assert_eq!(&text[spans[0].0..spans[2].1], "John Wilkes Booth");
    }

    #[test]
    fn convert_fixture_domain_range() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/conll04_sample.json");
        let raw = load_raw_split(path).unwrap();
        let docs = convert_split(&raw, "sample").unwrap();
        assert_eq!(docs.len(), 3);
        for doc in &docs {
            assert!(crate::eval::gold_has_spans(doc));
            for rel in doc["relations"].as_array().unwrap() {
                let rtype = rel["type"].as_str().unwrap();
                let expected = EXPECTED_DOMAIN_RANGE
                    .iter()
                    .find(|(k, _, _)| *k == rtype)
                    .unwrap();
                let head = doc["entities"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["start"] == rel["source_start"])
                    .unwrap();
                let tail = doc["entities"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["start"] == rel["target_start"])
                    .unwrap();
                assert_eq!(
                    (head["type"].as_str().unwrap(), tail["type"].as_str().unwrap()),
                    (expected.1, expected.2)
                );
            }
        }
    }
}
