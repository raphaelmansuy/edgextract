//! Stand-in for POST /v1/systemone.
//!
//! `gazetteer_handler` is a deterministic, rule-based answerer: it needs no model
//! and no OS, so it runs natively, in tests, and inside the wasm demo.
//! `start_fake_systemone` (native only) serves it over local HTTP.

use crate::error::SystemOneError;
use crate::ontology::{Ontology, NO_RELATION, NOT_ENTITY};
use crate::systemone::Transport;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::Arc;

pub type HandlerFn = Arc<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;

/// Calls a handler in-process, no HTTP. Lets a page run the whole pipeline offline.
pub struct LocalTransport {
    handler: HandlerFn,
}

impl LocalTransport {
    pub fn new(handler: HandlerFn) -> Self {
        Self { handler }
    }
}

impl Transport for LocalTransport {
    fn post_json(&self, _path: &str, body: &Value) -> Result<Value, SystemOneError> {
        (self.handler)(body.clone()).map_err(SystemOneError::new)
    }
}

#[cfg(feature = "native")]
pub use server::{start_fake_systemone, start_fake_systemone_at, FakeServer};

#[cfg(feature = "native")]
mod server {
    use super::HandlerFn;
    use serde_json::Value;
    use std::io::Write;
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use tiny_http::{Header, Method, Response, Server, StatusCode};

    fn ping_stop(base_url: &str) {
        if let Some(addr) = base_url.strip_prefix("http://") {
            if let Ok(mut stream) = TcpStream::connect(addr) {
                let _ = stream.write_all(b"POST /__stop HTTP/1.0\r\nContent-Length: 0\r\n\r\n");
            }
        }
    }

    pub struct FakeServer {
        pub base_url: String,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl FakeServer {
        pub fn stop(mut self) {
            self.stop.store(true, Ordering::SeqCst);
            ping_stop(&self.base_url);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    impl Drop for FakeServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            ping_stop(&self.base_url);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    fn with_headers<R: std::io::Read>(mut resp: Response<R>) -> Response<R> {
        // The browser demo calls this server from another origin, so answer CORS too.
        for (k, v) in [
            ("Content-Type", "application/json"),
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "POST, OPTIONS"),
            ("Access-Control-Allow-Headers", "content-type"),
        ] {
            resp = resp.with_header(Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
        }
        resp
    }

    fn json_reply(value: Value, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
        with_headers(Response::from_string(value.to_string()).with_status_code(StatusCode(status)))
    }

    pub fn start_fake_systemone(handler: HandlerFn) -> FakeServer {
        start_fake_systemone_at("127.0.0.1:0", handler)
    }

    /// Like `start_fake_systemone` but binds `addr` (for `edgextract serve-standin`).
    pub fn start_fake_systemone_at(addr: &str, handler: HandlerFn) -> FakeServer {
        let server = Server::http(addr).expect("bind fake systemone");
        let addr = server.server_addr().to_ip().expect("ip");
        let base_url = format!("http://{addr}");
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let handle = thread::spawn(move || {
            while !stop_t.load(Ordering::SeqCst) {
                let mut req = match server.recv_timeout(std::time::Duration::from_millis(200)) {
                    Ok(Some(r)) => r,
                    Ok(None) => continue,
                    Err(_) => break,
                };
                if req.url() == "/__stop" {
                    let _ = req.respond(Response::empty(200));
                    break;
                }
                if req.method() == &Method::Options {
                    let _ = req.respond(with_headers(Response::empty(204)));
                    continue;
                }
                if req.method() != &Method::Post || req.url() != "/v1/systemone" {
                    let _ = req.respond(json_reply(serde_json::json!({"error": "not found"}), 404));
                    continue;
                }
                let mut raw = String::new();
                let _ = req.as_reader().read_to_string(&mut raw);
                let reply = match serde_json::from_str::<Value>(&raw) {
                    Err(_) => json_reply(serde_json::json!({"error": "bad json"}), 400),
                    Ok(body) => match handler(body) {
                        Ok(out) => json_reply(out, 200),
                        // A refused prompt is the caller's fault (400), as on the real host.
                        Err(exc) if exc.starts_with("prompt ") => json_reply(serde_json::json!({"error": exc}), 400),
                        Err(exc) => json_reply(serde_json::json!({"error": exc}), 500),
                    },
                };
                let _ = req.respond(reply);
            }
        });
        FakeServer {
            base_url,
            stop,
            handle: Some(handle),
        }
    }
}

pub fn gazetteer_handler(ontology: &Ontology) -> HandlerFn {
    let gaz: Map<String, Value> = ontology
        .gazetteer
        .iter()
        .map(|(k, v)| (k.to_lowercase(), Value::String(v.clone())))
        .collect();
    Arc::new(move |body: Value| {
        let mut state = body.get("state").cloned().unwrap_or(Value::String(String::new()));
        if let Some(obj) = state.as_object() {
            state = Value::String(
                obj.values()
                    .map(|v| v.as_str().unwrap_or(&v.to_string()).to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        let state_s = state.as_str().unwrap_or("").to_string();
        let questions = body
            .get("questions")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let mut answers = Map::new();
        for (qid, q) in questions {
            let kind = q.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let ans = match kind {
                "choice" => choice(&q, &state_s, &gaz)?,
                "noul" => {
                    let instr = q.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
                    serde_json::json!({"type": "noul", "noul": noul(instr, &state_s)})
                }
                "score" => serde_json::json!({"type": "score", "score": 0.5}),
                other => return Err(format!("bad type {other}")),
            };
            answers.insert(qid, ans);
        }
        Ok(serde_json::json!({
            "model": body.get("model").and_then(|v| v.as_str()).unwrap_or("fake"),
            "answers": answers,
            "usage": {"input_tokens": 20, "output_tokens": 1},
        }))
    })
}

fn noul(instructions: &str, state: &str) -> f64 {
    let rx = Regex::new(r"(?i)\b(not|never|n't|might|could|maybe|perhaps)\b").unwrap();
    let hay = if instructions.is_empty() {
        state
    } else {
        instructions
    };
    if rx.is_match(hay) {
        0.05
    } else {
        0.95
    }
}

fn choice(q: &Value, state: &str, gaz: &Map<String, Value>) -> Result<Value, String> {
    let criteria: Map<String, Value> = q
        .get("criteria")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let instr = format!("{} ", q.get("instructions").and_then(|v| v.as_str()).unwrap_or(""));
    let negated = Regex::new(r"(?i)\b(not|never|n't|no)\b")
        .unwrap()
        .is_match(state);
    let hedged = Regex::new(r"(?i)\b(might|could|maybe|perhaps)\b")
        .unwrap()
        .is_match(state);
    if criteria.contains_key(NO_RELATION) {
        let keys: Vec<String> = criteria.keys().cloned().collect();
        let winner = if negated || hedged {
            NO_RELATION.to_string()
        } else {
            keys.iter()
                .find(|k| k.as_str() != NO_RELATION)
                .cloned()
                .unwrap_or_else(|| NO_RELATION.to_string())
        };
        return Ok(dist(&winner, &keys, 0.85));
    }
    let mention = mention_from_instructions(&instr);
    let mapped = gaz
        .get(&mention.to_lowercase())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(mapped) = mapped {
        if criteria.contains_key(&mapped) {
            let keys: Vec<String> = criteria.keys().cloned().collect();
            return Ok(dist(&mapped, &keys, 0.9));
        }
    }
    if mention.to_lowercase().as_str() == "she"
        || mention.to_lowercase() == "he"
        || mention.to_lowercase() == "they"
        || mention.to_lowercase() == "it"
        || mention.to_lowercase() == "them"
    {
        let keys: Vec<String> = criteria.keys().cloned().collect();
        return Ok(dist(NOT_ENTITY, &keys, 0.8));
    }
    if criteria.contains_key(NOT_ENTITY) {
        let title_case = mention
            .chars()
            .next()
            .map(|c| c.is_uppercase())
            .unwrap_or(false)
            && mention.contains(' ');
        if title_case {
            let pick = criteria
                .keys()
                .find(|k| k.as_str() != NOT_ENTITY)
                .cloned()
                .unwrap_or_else(|| NOT_ENTITY.to_string());
            let keys: Vec<String> = criteria.keys().cloned().collect();
            return Ok(dist(&pick, &keys, 0.55));
        }
        let keys: Vec<String> = criteria.keys().cloned().collect();
        return Ok(dist(NOT_ENTITY, &keys, 0.7));
    }
    let winner = criteria.keys().next().cloned().unwrap_or_default();
    let keys: Vec<String> = criteria.keys().cloned().collect();
    Ok(dist(&winner, &keys, 0.5))
}

fn mention_from_instructions(instr: &str) -> String {
    let rx1 = Regex::new(r"mention \[\d+\] \('([^']+)'\)").unwrap();
    if let Some(c) = rx1.captures(instr) {
        return c.get(1).unwrap().as_str().to_string();
    }
    let rx2 = Regex::new(r"\('([^']+)'").unwrap();
    if let Some(c) = rx2.captures(instr) {
        return c.get(1).unwrap().as_str().to_string();
    }
    String::new()
}

fn dist(winner: &str, keys: &[String], confidence: f64) -> Value {
    let rest: Vec<&String> = keys.iter().filter(|k| k.as_str() != winner).collect();
    let mass = 0.92;
    let leftover = (1.0 - mass) / rest.len().max(1) as f64;
    let mut probs = Map::new();
    probs.insert(winner.to_string(), json_num(mass));
    for k in &rest {
        probs.insert((*k).clone(), json_num(leftover));
    }
    let s: f64 = probs.values().filter_map(|v| v.as_f64()).sum();
    if let Some(v) = probs.get_mut(winner) {
        *v = json_num(v.as_f64().unwrap_or(mass) + (1.0 - s));
    }
    serde_json::json!({
        "type": "choice",
        "choice": winner,
        "probabilities": probs,
        "confidence": confidence,
    })
}

fn json_num(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or(Value::from(0))
}
