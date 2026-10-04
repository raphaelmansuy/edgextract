//! HTTP client for Ollama POST /v1/systemone. Fail closed on a bad answer.

use crate::error::SystemOneError;
use crate::types::{SystemOneResponse, Usage};
use indexmap::IndexMap;
use serde_json::{Map, Value};
#[cfg(feature = "native")]
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";
pub const SYSTEMONE_PATH: &str = "/v1/systemone";
pub const PROB_SUM_TOLERANCE: f64 = 0.05;

pub trait Transport: Send + Sync {
    fn post_json(&self, path: &str, body: &Value) -> Result<Value, SystemOneError>;
}

/// Blocking HTTP transport (native builds only; wasm callers supply their own `Transport`).
#[cfg(feature = "native")]
pub struct HttpTransport {
    base_url: String,
    client: reqwest::blocking::Client,
}

#[cfg(feature = "native")]
impl HttpTransport {
    pub fn new(base_url: &str, timeout_secs: f64) -> Self {
        let timeout = Duration::from_secs_f64(timeout_secs.max(0.001));
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(5).min(timeout))
            .tcp_nodelay(true)
            .pool_max_idle_per_host(4)
            .pool_idle_timeout(Duration::from_secs(90))
            .http1_only()
            .build()
            .expect("http client");
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client,
        }
    }
}

#[cfg(feature = "native")]
impl Transport for HttpTransport {
    fn post_json(&self, path: &str, body: &Value) -> Result<Value, SystemOneError> {
        let url = format!("{}{path}", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(body)
            .send()
            .map_err(|e| SystemOneError::new(format!("transport: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let snippet: String = resp.text().unwrap_or_default().chars().take(400).collect();
            return Err(SystemOneError::new(format!("http {status}: {snippet}")));
        }
        let data: Value = resp
            .json()
            .map_err(|e| SystemOneError::new(format!("non-json body: {e}")))?;
        if !data.is_object() {
            return Err(SystemOneError::new("response is not an object"));
        }
        Ok(data)
    }
}

pub fn build_choice_question(instructions: &str, criteria: &IndexMap<String, String>) -> Result<Value, SystemOneError> {
    if !(2..=26).contains(&criteria.len()) {
        return Err(SystemOneError::new(format!(
            "choice needs 2..26 options, got {}",
            criteria.len()
        )));
    }
    Ok(serde_json::json!({
        "type": "choice",
        "instructions": instructions,
        "criteria": criteria,
    }))
}

pub fn build_noul_question(
    instructions: &str,
    false_desc: Option<&str>,
    true_desc: Option<&str>,
) -> Value {
    let mut q = serde_json::json!({
        "type": "noul",
        "instructions": instructions,
    });
    if false_desc.is_some() || true_desc.is_some() {
        q["criteria"] = serde_json::json!({
            "false": false_desc.unwrap_or("No"),
            "true": true_desc.unwrap_or("Yes"),
        });
    }
    q
}

pub fn build_score_question(instructions: &str, levels: &[String]) -> Result<Value, SystemOneError> {
    if !(2..=26).contains(&levels.len()) {
        return Err(SystemOneError::new(format!(
            "score needs 2..26 levels, got {}",
            levels.len()
        )));
    }
    Ok(serde_json::json!({
        "type": "score",
        "instructions": instructions,
        "criteria": levels,
    }))
}

pub fn reverse_criteria(criteria: &IndexMap<String, String>) -> IndexMap<String, String> {
    criteria.iter().rev().map(|(k, v)| (k.clone(), v.clone())).collect()
}

pub fn validate_response(
    data: &Value,
    expected_ids: Option<&[String]>,
) -> Result<SystemOneResponse, SystemOneError> {
    if data.get("error").is_some() && data.get("answers").is_none() {
        return Err(SystemOneError::new(format!(
            "server error: {}",
            data.get("error").unwrap()
        )));
    }
    let model = data
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| SystemOneError::new("missing model"))?;
    let answers = data
        .get("answers")
        .and_then(|v| v.as_object())
        .ok_or_else(|| SystemOneError::new("missing answers object"))?;
    if let Some(ids) = expected_ids {
        let missing: Vec<&String> = ids.iter().filter(|i| !answers.contains_key(*i)).collect();
        if !missing.is_empty() {
            return Err(SystemOneError::new(format!("missing answers: {missing:?}")));
        }
    }
    for (qid, ans) in answers {
        let obj = ans
            .as_object()
            .ok_or_else(|| SystemOneError::new(format!("answer {qid} is not an object")))?;
        match obj.get("type").and_then(|v| v.as_str()) {
            Some("choice") => validate_choice(qid, obj)?,
            Some("noul") => validate_noul(qid, obj)?,
            Some("score") => validate_score(qid, obj)?,
            kind => {
                return Err(SystemOneError::new(format!(
                    "answer {qid} has unknown type {kind:?}"
                )))
            }
        }
    }
    let usage_raw = data.get("usage").cloned().unwrap_or(Value::Object(Map::new()));
    let usage = Usage {
        input_tokens: usage_raw
            .get("input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        output_tokens: usage_raw
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
    };
    Ok(SystemOneResponse {
        model: model.to_string(),
        answers: answers.clone(),
        usage,
    })
}

fn as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|i| i as f64))
        .or_else(|| v.as_u64().map(|i| i as f64))
}

fn validate_choice(qid: &str, ans: &Map<String, Value>) -> Result<(), SystemOneError> {
    let choice = ans
        .get("choice")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| SystemOneError::new(format!("{qid}: missing choice")))?;
    let probs = ans
        .get("probabilities")
        .and_then(|v| v.as_object())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SystemOneError::new(format!("{qid}: missing probabilities")))?;
    if !probs.contains_key(choice) {
        return Err(SystemOneError::new(format!(
            "{qid}: choice {choice:?} not in probabilities keys"
        )));
    }
    let mut total = 0.0;
    for (k, v) in probs {
        let p = as_f64(v).ok_or_else(|| SystemOneError::new(format!("{qid}: bad probability for {k}")))?;
        total += p;
    }
    if (total - 1.0).abs() > PROB_SUM_TOLERANCE {
        return Err(SystemOneError::new(format!(
            "{qid}: probabilities sum to {total}, not 1"
        )));
    }
    if let Some(conf) = ans.get("confidence").filter(|v| !v.is_null()) {
        let c = as_f64(conf).ok_or_else(|| SystemOneError::new(format!("{qid}: bad confidence")))?;
        if !(0.0..=1.0).contains(&c) {
            return Err(SystemOneError::new(format!("{qid}: confidence out of range")));
        }
    }
    Ok(())
}

fn validate_noul(qid: &str, ans: &Map<String, Value>) -> Result<(), SystemOneError> {
    let p = ans
        .get("noul")
        .and_then(as_f64)
        .ok_or_else(|| SystemOneError::new(format!("{qid}: missing noul")))?;
    if !(0.0..=1.0).contains(&p) {
        return Err(SystemOneError::new(format!("{qid}: noul out of range")));
    }
    Ok(())
}

fn validate_score(qid: &str, ans: &Map<String, Value>) -> Result<(), SystemOneError> {
    ans.get("score")
        .and_then(as_f64)
        .ok_or_else(|| SystemOneError::new(format!("{qid}: missing score")))?;
    Ok(())
}

pub struct SystemOneClient {
    pub model: String,
    transport: Box<dyn Transport>,
}

impl SystemOneClient {
    #[cfg(feature = "native")]
    pub fn new(model: impl Into<String>, base_url: &str, timeout: f64) -> Self {
        Self {
            model: model.into(),
            transport: Box::new(HttpTransport::new(base_url, timeout)),
        }
    }

    pub fn with_transport(model: impl Into<String>, transport: Box<dyn Transport>) -> Self {
        Self {
            model: model.into(),
            transport,
        }
    }

    pub fn decide(
        &self,
        state: &Value,
        questions: &Map<String, Value>,
        images: Option<&[String]>,
    ) -> Result<SystemOneResponse, SystemOneError> {
        if questions.is_empty() {
            return Err(SystemOneError::new("questions must not be empty"));
        }
        let mut body = serde_json::json!({
            "model": self.model,
            "state": state,
            "questions": questions,
        });
        if let Some(imgs) = images {
            if !imgs.is_empty() {
                body["images"] = serde_json::json!(imgs);
            }
        }
        let data = self.transport.post_json(SYSTEMONE_PATH, &body)?;
        let ids: Vec<String> = questions.keys().cloned().collect();
        validate_response(&data, Some(&ids))
    }

    pub fn decide_str(
        &self,
        state: &str,
        questions: &Map<String, Value>,
    ) -> Result<SystemOneResponse, SystemOneError> {
        self.decide(&Value::String(state.to_string()), questions, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_choice() {
        let resp = validate_response(
            &serde_json::json!({
                "model": "nimble",
                "answers": {
                    "label": {
                        "type": "choice",
                        "choice": "bug",
                        "probabilities": {"billing": 0.01, "bug": 0.98, "account": 0.01},
                        "confidence": 0.89,
                    }
                },
                "usage": {"input_tokens": 10, "output_tokens": 1},
            }),
            Some(&["label".into()]),
        )
        .unwrap();
        assert_eq!(resp.answers["label"]["choice"], "bug");
    }

    #[test]
    fn noul_range() {
        validate_response(
            &serde_json::json!({"model": "clef-flash", "answers": {"q": {"type": "noul", "noul": 0.2}}}),
            None,
        )
        .unwrap();
        assert!(validate_response(
            &serde_json::json!({"model": "x", "answers": {"q": {"type": "noul", "noul": 1.5}}}),
            None,
        )
        .is_err());
    }

    #[test]
    fn choice_not_in_keys() {
        assert!(validate_response(
            &serde_json::json!({
                "model": "n",
                "answers": {
                    "q": {
                        "type": "choice",
                        "choice": "other",
                        "probabilities": {"a": 0.5, "b": 0.5},
                    }
                },
            }),
            None,
        )
        .is_err());
    }

    #[test]
    fn probs_must_sum() {
        assert!(validate_response(
            &serde_json::json!({
                "model": "n",
                "answers": {
                    "q": {
                        "type": "choice",
                        "choice": "a",
                        "probabilities": {"a": 0.1, "b": 0.1},
                    }
                },
            }),
            None,
        )
        .is_err());
    }

    #[test]
    fn missing_answers_and_server_error() {
        assert!(validate_response(&serde_json::json!({"model": "n"}), Some(&["q".into()])).is_err());
        assert!(validate_response(&serde_json::json!({"error": "model is required"}), None).is_err());
    }

    #[test]
    fn reverse_criteria_order() {
        let mut c = IndexMap::new();
        c.insert("a".into(), "A".into());
        c.insert("b".into(), "B".into());
        let rev = reverse_criteria(&c);
        let keys: Vec<_> = rev.keys().cloned().collect();
        assert_eq!(keys, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn live_choice_fixture() {
        let raw = include_str!("../tests/fixtures/nimble_choice.json");
        let data: Value = serde_json::from_str(raw).unwrap();
        let resp = validate_response(&data, Some(&["label".into()])).unwrap();
        assert_eq!(resp.answers["label"]["choice"], "bug");
    }

    #[test]
    fn live_noul_score_fixture() {
        let raw = include_str!("../tests/fixtures/nimble_noul_score.json");
        let data: Value = serde_json::from_str(raw).unwrap();
        validate_response(&data, None).unwrap();
    }
}
