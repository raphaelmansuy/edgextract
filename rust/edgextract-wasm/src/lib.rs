//! edgextract in the browser.
//!
//! Everything the Rust pipeline does natively runs here unchanged: sentence
//! splitting, proposing names, the closed questions, the gate, and the audit.
//! Only two things differ, and both are swapped in at the edge:
//!
//! * the decision cache is in memory instead of SQLite, and
//! * the model is a JavaScript function you pass in, which `POST`s to
//!   `/v1/systemone` on a real decision-model host. (Rust tests may still call
//!   [`run`] with the rule-based test double; the browser API cannot.)
//!
//! The JS function must be synchronous, so run this module in a Web Worker and
//! use a synchronous `XMLHttpRequest` there.

use edgextract::cache::DecisionCache;
use edgextract::candidates::discovering_proposers;
use edgextract::error::SystemOneError;
use edgextract::gate::GateConfig;
use edgextract::ontology::{
    bundled_ontology_names, bundled_yaml, describe_ontology, ontology_from_yaml,
};
use edgextract::pipeline::{Extractor, Session};
use edgextract::standin::rule_handler;
use edgextract::systemone::{SystemOneClient, Transport};
use edgextract::testing::LocalTransport;
use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// What the page sends for one run.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub text: String,
    pub ontology_yaml: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub gate: GateIn,
    /// Also propose capitalized runs the ontology does not list, and let the model decide.
    #[serde(default)]
    pub discover_names: bool,
    /// Read the document in sections of about this many characters (default 3000).
    #[serde(default)]
    pub section_chars: Option<usize>,
    /// Read only the first N sections (a preview of a long document).
    #[serde(default)]
    pub max_sections: Option<usize>,
}

/// Cutoffs the page may override. Anything left out keeps the library default.
#[derive(Debug, Default, Deserialize)]
pub struct GateIn {
    pub noul_yes: Option<f64>,
    pub noul_no: Option<f64>,
    pub accept_prob: Option<f64>,
    pub reject_prob: Option<f64>,
}

impl GateIn {
    fn into_config(self) -> Result<GateConfig, String> {
        let mut gate = GateConfig::default();
        if let Some(v) = self.noul_yes {
            gate.noul_yes = v;
        }
        if let Some(v) = self.noul_no {
            gate.noul_no = v;
        }
        if let Some(v) = self.accept_prob {
            gate.accept_prob = v;
        }
        if let Some(v) = self.reject_prob {
            gate.reject_prob = v;
        }
        for (name, v) in [
            ("noul_yes", gate.noul_yes),
            ("noul_no", gate.noul_no),
            ("accept_prob", gate.accept_prob),
            ("reject_prob", gate.reject_prob),
        ] {
            if !(0.0..=1.0).contains(&v) {
                return Err(format!("cutoff {name} must be between 0 and 1, got {v}"));
            }
        }
        if gate.noul_no >= gate.noul_yes {
            return Err(format!(
                "the drop cutoff ({}) must sit below the keep cutoff ({})",
                gate.noul_no, gate.noul_yes
            ));
        }
        Ok(gate)
    }
}

/// The page's own model call: `(path, bodyJson) -> responseJson`, synchronous.
struct JsTransport {
    call: js_sys::Function,
}

// wasm32-unknown-unknown has one thread, so nothing here can actually cross threads.
unsafe impl Send for JsTransport {}
unsafe impl Sync for JsTransport {}

impl Transport for JsTransport {
    fn post_json(&self, path: &str, body: &Value) -> Result<Value, SystemOneError> {
        let reply = self
            .call
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(path),
                &JsValue::from_str(&body.to_string()),
            )
            .map_err(|e| {
                SystemOneError::new(format!(
                    "transport: {}",
                    e.as_string()
                        .or_else(|| {
                            js_sys::Reflect::get(&e, &JsValue::from_str("message"))
                                .ok()
                                .and_then(|m| m.as_string())
                        })
                        .unwrap_or_else(|| "the model call threw".into())
                ))
            })?;
        let text = reply
            .as_string()
            .ok_or_else(|| SystemOneError::new("transport: the model call must return a JSON string"))?;
        let data: Value = serde_json::from_str(&text)
            .map_err(|e| SystemOneError::new(format!("non-json body: {e}")))?;
        if !data.is_object() {
            return Err(SystemOneError::new("response is not an object"));
        }
        Ok(data)
    }
}

/// Sections are about this many characters: big enough to pack questions well, small enough
/// that the page hears something every few seconds.
pub const DEFAULT_SECTION_CHARS: usize = 3000;

/// Set up a document to be read section by section. Nothing is sent to the model yet.
pub fn build(
    request: Request,
    transport: Option<Box<dyn Transport>>,
    cache: &DecisionCache,
) -> Result<Session, String> {
    let ontology = ontology_from_yaml(&request.ontology_yaml).map_err(|e| e.to_string())?;
    let gate = request.gate.into_config()?;
    let document_id = request.document_id.unwrap_or_else(|| "document".into());
    let (model, transport): (String, Box<dyn Transport>) = match transport {
        Some(t) => (request.model.unwrap_or_else(|| "tev1".into()), t),
        None => (
            request.model.unwrap_or_else(|| "rule-model".into()),
            Box::new(LocalTransport::new(rule_handler(&ontology))),
        ),
    };
    let mut extractor = Extractor::new(ontology, SystemOneClient::with_transport(model, transport))
        .with_gate(gate)
        .with_cache(cache.clone());
    if request.discover_names {
        extractor = extractor.with_proposers(discovering_proposers());
    }
    let mut session = extractor.into_session(
        &request.text,
        &document_id,
        request.section_chars.unwrap_or(DEFAULT_SECTION_CHARS),
    );
    if let Some(n) = request.max_sections {
        session.limit_sections(n);
    }
    Ok(session)
}

/// What the page paints: the graph so far, the sentences read, and where the reading is.
pub fn output(session: &Session, cache: &DecisionCache, last: bool) -> Result<Value, String> {
    let result = if last { session.finish() } else { session.snapshot() }.map_err(|e| e.to_string())?;
    Ok(json!({
        "result": result,
        "sentences": session.read_sentences(),
        "ontology": describe_ontology(session.ontology()),
        "cache_entries": cache.len(),
        "progress": session.progress(),
    }))
}

/// Read a whole document. Pure Rust so it is testable without a browser.
pub fn run(
    request: Request,
    transport: Option<Box<dyn Transport>>,
    cache: &DecisionCache,
) -> Result<Value, String> {
    let mut session = build(request, transport, cache)?;
    while !session.done() {
        session.step().map_err(|e| e.to_string())?;
    }
    output(&session, cache, true)
}

/// A page-lifetime engine. It keeps the decision cache, so moving a cutoff and
/// running again asks the model nothing new.
#[wasm_bindgen]
pub struct Engine {
    cache: DecisionCache,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        console_error_panic_hook::set_once();
        Engine {
            cache: DecisionCache::in_memory(),
        }
    }

    /// Prepare a document. `request` is JSON (see `Request`); `model_call` is a synchronous
    /// `(path, bodyJson) => responseJson` function that reaches the decision model. Nothing
    /// is asked yet: call `plan()`, then `step()` until `done()`. Throws a string.
    pub fn start(&self, request: &str, model_call: js_sys::Function) -> Result<Job, JsValue> {
        let parsed: Request =
            serde_json::from_str(request).map_err(|e| JsValue::from_str(&format!("bad request: {e}")))?;
        let transport = Box::new(JsTransport { call: model_call }) as Box<dyn Transport>;
        let session = build(parsed, Some(transport), &self.cache).map_err(|e| JsValue::from_str(&e))?;
        Ok(Job {
            session,
            cache: self.cache.clone(),
        })
    }

    pub fn cache_entries(&self) -> usize {
        self.cache.len()
    }

    pub fn clear_cache(&self) {
        self.cache.clear();
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// One document being read, section by section.
#[wasm_bindgen]
pub struct Job {
    session: Session,
    cache: DecisionCache,
}

#[wasm_bindgen]
impl Job {
    /// How big is this job? JSON: sentences, sections, and a forecast of model calls.
    /// Asks the model nothing.
    pub fn plan(&self) -> String {
        json!({
            "sentences": self.session.sentences().len(),
            "sections": self.session.sections(),
            "total_sections": self.session.total_sections(),
            "forecast": self.session.forecast(),
            "progress": self.session.progress(),
        })
        .to_string()
    }

    /// Read only the first `n` sections.
    pub fn limit_sections(&mut self, n: usize) {
        self.session.limit_sections(n);
    }

    pub fn done(&self) -> bool {
        self.session.done()
    }

    /// Read the next section. Returns progress JSON, or throws a string; after a throw the
    /// same section is tried again on the next call and nothing already read is lost.
    pub fn step(&mut self) -> Result<String, JsValue> {
        self.session
            .step()
            .map(|p| serde_json::to_string(&p).unwrap_or_default())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The graph from the sections read so far (JSON, same shape as `finish`).
    pub fn snapshot(&self) -> Result<String, JsValue> {
        output(&self.session, &self.cache, false)
            .map(|v| v.to_string())
            .map_err(|e| JsValue::from_str(&e))
    }

    /// The final graph (JSON). Also records the run.
    pub fn finish(&self) -> Result<String, JsValue> {
        output(&self.session, &self.cache, true)
            .map(|v| v.to_string())
            .map_err(|e| JsValue::from_str(&e))
    }
}

/// The ontologies that ship with the crate, as JSON `[{name, yaml}]`.
#[wasm_bindgen]
pub fn bundled_ontologies() -> String {
    let list: Vec<Value> = bundled_ontology_names()
        .into_iter()
        .map(|name| json!({"name": name, "yaml": bundled_yaml(name).unwrap_or("")}))
        .collect();
    Value::Array(list).to_string()
}

/// Check an ontology the way the library does. Returns a JSON description
/// (kinds and legal links), or throws the plain-English reason it is not valid.
#[wasm_bindgen]
pub fn validate_ontology(yaml: &str) -> Result<String, JsValue> {
    ontology_from_yaml(yaml)
        .map(|o| describe_ontology(&o).to_string())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// A commented starter ontology to begin a new one from.
#[wasm_bindgen]
pub fn starter_ontology() -> String {
    edgextract::ontology::STARTER_ONTOLOGY.to_string()
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORTHWIND: &str = "# Northwind raises a round\n\nAda Lovelace founded Northwind in Paris.\nNorthwind is headquartered in Paris.\n\nAcme Inc invested in Northwind.\nJane Doe works for Acme Inc in Berlin.\n";

    fn request(text: &str, ontology: &str) -> Request {
        Request {
            text: text.into(),
            ontology_yaml: bundled_yaml(ontology).unwrap().into(),
            model: None,
            document_id: Some("t".into()),
            gate: GateIn::default(),
            discover_names: false,
            section_chars: None,
            max_sections: None,
        }
    }

    fn triples(out: &Value) -> Vec<(String, String, String)> {
        out["result"]["relationships"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["source"].as_str().unwrap().to_string(),
                    r["relation_type"].as_str().unwrap().to_string(),
                    r["target"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn northwind_runs_offline_and_keeps_only_what_the_text_says() {
        let cache = DecisionCache::in_memory();
        let out = run(request(NORTHWIND, "company_news"), None, &cache).unwrap();
        let t = triples(&out);
        let has = |s: &str, r: &str, o: &str| t.contains(&(s.into(), r.into(), o.into()));
        assert!(has("ADA_LOVELACE", "FOUNDED", "NORTHWIND"), "{t:?}");
        assert!(has("NORTHWIND", "HEADQUARTERED_IN", "PARIS"), "{t:?}");
        assert!(has("ACME_INC", "INVESTED_IN", "NORTHWIND"), "{t:?}");
        assert!(has("JANE_DOE", "WORKS_FOR", "ACME_INC"), "{t:?}");
        // The old stand-in said yes to every legal link. This one does not.
        assert!(!has("ACME_INC", "ACQUIRED", "NORTHWIND"), "{t:?}");
        assert!(!has("NORTHWIND", "INVESTED_IN", "ACME_INC"), "{t:?}");
        assert_eq!(t.len(), 4, "{t:?}");
    }

    #[test]
    fn a_document_whose_names_no_list_knows_is_still_read() {
        // Nothing here is on the ontology's list, so without discovery nothing is asked.
        let text = "Zorbex Labs, a startup, invested in Quillion, a firm.\n";
        let cache = DecisionCache::in_memory();
        let blind = run(request(text, "company_news"), None, &cache).unwrap();
        assert_eq!(blind["result"]["metadata"]["stats"]["systemone_calls"], 0);
        assert!(triples(&blind).is_empty());

        let mut seeing = request(text, "company_news");
        seeing.discover_names = true;
        // The test double is only 0.62 sure of a kind it learned from a hint word.
        seeing.gate.accept_prob = Some(0.55);
        let out = run(seeing, None, &cache).unwrap();
        let asked = out["result"]["metadata"]["stats"]["systemone_calls"].as_u64().unwrap();
        assert!(asked >= 1, "the model must be asked about the candidates");
        let t = triples(&out);
        assert!(
            t.contains(&("ZORBEX_LABS".into(), "INVESTED_IN".into(), "QUILLION".into())),
            "{t:?}"
        );
    }

    #[test]
    fn a_second_run_is_answered_from_the_cache() {
        let cache = DecisionCache::in_memory();
        let first = run(request(NORTHWIND, "company_news"), None, &cache).unwrap();
        let second = run(request(NORTHWIND, "company_news"), None, &cache).unwrap();
        let calls = |o: &Value| o["result"]["metadata"]["stats"]["systemone_calls"].as_u64().unwrap();
        assert!(calls(&first) >= 1);
        assert_eq!(calls(&second), 0);
        assert_eq!(triples(&first), triples(&second));
    }

    #[test]
    fn stricter_cutoff_moves_items_to_review() {
        let cache = DecisionCache::in_memory();
        let mut loose = request(NORTHWIND, "company_news");
        loose.gate.noul_yes = Some(0.8);
        let mut strict = request(NORTHWIND, "company_news");
        strict.gate.noul_yes = Some(0.99);
        let a = run(loose, None, &cache).unwrap();
        let b = run(strict, None, &cache).unwrap();
        assert!(triples(&b).len() < triples(&a).len());
        assert!(b["result"]["review"].as_array().unwrap().len() > a["result"]["review"].as_array().unwrap().len());
    }

    #[test]
    fn a_failing_host_fails_closed() {
        struct Down;
        impl Transport for Down {
            fn post_json(&self, _: &str, _: &Value) -> Result<Value, SystemOneError> {
                Err(SystemOneError::new("transport: refused"))
            }
        }
        let err = run(request(NORTHWIND, "company_news"), Some(Box::new(Down)), &DecisionCache::in_memory()).unwrap_err();
        assert!(err.contains("refused"), "{err}");
    }

    #[test]
    fn bad_cutoffs_and_bad_ontologies_are_plain_errors() {
        let mut r = request(NORTHWIND, "company_news");
        r.gate.noul_no = Some(0.9);
        assert!(run(r, None, &DecisionCache::in_memory()).unwrap_err().contains("below"));
        let mut r = request(NORTHWIND, "company_news");
        r.ontology_yaml = "id: x\ntypes: []\nrelations: []".into();
        assert!(run(r, None, &DecisionCache::in_memory()).is_err());
    }
}
