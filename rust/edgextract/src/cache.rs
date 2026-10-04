//! Decision cache and run ledger. Same (model, state, questions) never hits the host twice.
//!
//! Native builds can persist to SQLite (`DecisionCache::open`). Every build can keep
//! answers in memory (`DecisionCache::in_memory`), which is what wasm32 uses.

use crate::error::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
#[cfg(feature = "native")]
use std::fs;
#[cfg(feature = "native")]
use std::path::{Path, PathBuf};
#[cfg(feature = "native")]
use web_time::{SystemTime, UNIX_EPOCH};

#[cfg(feature = "native")]
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS decisions (
  cache_key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  document_id TEXT,
  model TEXT,
  ontology_id TEXT,
  started_at REAL,
  finished_at REAL,
  stats_json TEXT,
  result_json TEXT
);
"#;

pub fn canonical_json(value: &Value) -> String {
    fn write(v: &Value, out: &mut String) {
        match v {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => out.push_str(&n.to_string()),
            Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap()),
            Value::Array(arr) => {
                out.push('[');
                for (i, x) in arr.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(x, out);
                }
                out.push(']');
            }
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap());
                    out.push(':');
                    write(&map[*k], out);
                }
                out.push('}');
            }
        }
    }
    let mut s = String::new();
    write(value, &mut s);
    s
}

pub fn request_key(
    contract: &str,
    model: &str,
    state: &Value,
    questions: &Value,
    images: Option<&Value>,
) -> String {
    let payload = serde_json::json!({
        "contract": contract,
        "model": model,
        "state": state,
        "questions": questions,
        "images": images.cloned().unwrap_or_else(|| serde_json::json!([])),
    });
    let blob = canonical_json(&payload);
    let mut hasher = Sha256::new();
    hasher.update(blob.as_bytes());
    hex::encode(hasher.finalize())
}

type Table = Arc<Mutex<HashMap<String, Value>>>;

enum Backend {
    Memory(Table),
    #[cfg(feature = "native")]
    Sqlite(Mutex<rusqlite::Connection>),
}

/// Answers keyed by (contract, model, state, questions). Cheap to clone only in
/// memory mode, where clones share one table.
pub struct DecisionCache {
    #[cfg(feature = "native")]
    pub path: Option<PathBuf>,
    backend: Backend,
}

impl Clone for DecisionCache {
    /// Clones of an in-memory cache share one table. A SQLite cache cannot be cloned.
    fn clone(&self) -> Self {
        match &self.backend {
            Backend::Memory(t) => Self {
                #[cfg(feature = "native")]
                path: None,
                backend: Backend::Memory(t.clone()),
            },
            #[cfg(feature = "native")]
            Backend::Sqlite(_) => panic!("a SQLite DecisionCache cannot be cloned; share it by reference"),
        }
    }
}

impl DecisionCache {
    /// Keeps answers for the life of the process (or page). This is what wasm uses.
    pub fn in_memory() -> Self {
        Self {
            #[cfg(feature = "native")]
            path: None,
            backend: Backend::Memory(Arc::default()),
        }
    }

    #[cfg(feature = "native")]
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = rusqlite::Connection::open(&path)?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            path: Some(path),
            backend: Backend::Sqlite(Mutex::new(conn)),
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<Value>> {
        match &self.backend {
            Backend::Memory(t) => Ok(t.lock().expect("cache lock").get(key).cloned()),
            #[cfg(feature = "native")]
            Backend::Sqlite(conn) => {
                let conn = conn.lock().expect("cache lock");
                let mut stmt = conn.prepare("SELECT response_json FROM decisions WHERE cache_key = ?1")?;
                let mut rows = stmt.query(rusqlite::params![key])?;
                if let Some(row) = rows.next()? {
                    let json: String = row.get(0)?;
                    let value: Value = serde_json::from_str(&json)
                        .map_err(|e| crate::error::Error::Cache(e.to_string()))?;
                    Ok(Some(value))
                } else {
                    Ok(None)
                }
            }
        }
    }

    pub fn put(&self, key: &str, model: &str, response: &Value) -> Result<()> {
        match &self.backend {
            Backend::Memory(t) => {
                let _ = model;
                t.lock()
                    .expect("cache lock")
                    .insert(key.to_string(), response.clone());
                Ok(())
            }
            #[cfg(feature = "native")]
            Backend::Sqlite(conn) => {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0);
                conn.lock().expect("cache lock").execute(
                    "INSERT OR REPLACE INTO decisions(cache_key, model, body_hash, response_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        key,
                        model,
                        key,
                        serde_json::to_string(response).unwrap_or_else(|_| "{}".into()),
                        now
                    ],
                )?;
                Ok(())
            }
        }
    }

    /// Number of stored answers.
    pub fn len(&self) -> usize {
        match &self.backend {
            Backend::Memory(t) => t.lock().expect("cache lock").len(),
            #[cfg(feature = "native")]
            Backend::Sqlite(conn) => conn
                .lock()
                .expect("cache lock")
                .query_row("SELECT COUNT(*) FROM decisions", [], |r| r.get::<_, i64>(0))
                .map(|n| n as usize)
                .unwrap_or(0),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        match &self.backend {
            Backend::Memory(t) => t.lock().expect("cache lock").clear(),
            #[cfg(feature = "native")]
            Backend::Sqlite(conn) => {
                let _ = conn.lock().expect("cache lock").execute("DELETE FROM decisions", []);
            }
        }
    }

    /// Record one finished run. Only SQLite keeps a ledger; memory mode skips it.
    #[allow(clippy::too_many_arguments)]
    pub fn record_run(
        &self,
        run_id: &str,
        document_id: &str,
        model: &str,
        ontology_id: &str,
        stats: &Value,
        result: &Value,
        started_at: f64,
        finished_at: f64,
    ) -> Result<()> {
        match &self.backend {
            Backend::Memory(_) => {
                let _ = (run_id, document_id, model, ontology_id, stats, result, started_at, finished_at);
                Ok(())
            }
            #[cfg(feature = "native")]
            Backend::Sqlite(conn) => {
                conn.lock().expect("cache lock").execute(
                    "INSERT OR REPLACE INTO runs(run_id, document_id, model, ontology_id, started_at,
                     finished_at, stats_json, result_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![
                        run_id,
                        document_id,
                        model,
                        ontology_id,
                        started_at,
                        finished_at,
                        serde_json::to_string(stats).unwrap_or_default(),
                        serde_json::to_string(result).unwrap_or_default(),
                    ],
                )?;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::request_key;
    use serde_json::json;

    #[test]
    fn contract_changes_the_cache_key() {
        let state = json!("s");
        let questions = json!({"q": {"type": "noul"}});
        let a = request_key("edgextract.decision.2026-10-03", "nimble", &state, &questions, None);
        let b = request_key("edgextract.decision.other", "nimble", &state, &questions, None);
        assert_ne!(a, b);
    }

    #[test]
    fn in_memory_cache_round_trips_and_clones_share() {
        let a = super::DecisionCache::in_memory();
        let b = a.clone();
        assert!(a.is_empty());
        a.put("k", "m", &json!({"x": 1})).unwrap();
        assert_eq!(b.get("k").unwrap(), Some(json!({"x": 1})));
        assert_eq!(b.len(), 1);
        b.clear();
        assert_eq!(a.get("k").unwrap(), None);
    }
}
