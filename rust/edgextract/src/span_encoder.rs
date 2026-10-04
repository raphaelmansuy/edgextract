//! Optional span proposers. The decision model still assigns ontology types.

use crate::candidates::{mention, Proposer};
use crate::ontology::Ontology;
use crate::types::{Mention, MentionSource, Sentence};
use indexmap::IndexMap;
use std::sync::Arc;

pub trait SpanEncoder: Send + Sync {
    /// Return half-open `(start, end, score)` offsets into `text`.
    fn propose_spans(
        &self,
        text: &str,
        labels: &IndexMap<String, String>,
        threshold: f64,
    ) -> Vec<(usize, usize, f64)>;
}

pub struct EncoderProposer {
    encoder: Arc<dyn SpanEncoder>,
    threshold: f64,
}

impl EncoderProposer {
    pub fn new(encoder: Arc<dyn SpanEncoder>, threshold: f64) -> Self {
        Self {
            encoder,
            threshold,
        }
    }
}

impl Proposer for EncoderProposer {
    fn name(&self) -> &str {
        "encoder"
    }

    fn propose(&self, sentence: &Sentence, ontology: &Ontology) -> Vec<Mention> {
        let mut labels = IndexMap::new();
        for t in &ontology.types {
            labels.insert(t.id.to_lowercase(), t.description.clone());
        }
        let spans = self
            .encoder
            .propose_spans(&sentence.text, &labels, self.threshold);
        let mut mentions = Vec::new();
        for (start, end, _score) in spans {
            if start >= end || end > sentence.text.len() {
                continue;
            }
            if sentence.text.get(start..end).is_none() {
                continue;
            }
            let surface = &sentence.text[start..end];
            if surface.trim().is_empty() {
                continue;
            }
            mentions.push(mention(
                sentence,
                surface,
                start,
                end,
                MentionSource::Encoder,
            ));
        }
        mentions
    }
}

#[derive(Clone, Default)]
pub struct FixedSpanEncoder {
    pub spans: Vec<(usize, usize, f64)>,
}

impl FixedSpanEncoder {
    pub fn new(spans: Vec<(usize, usize, f64)>) -> Self {
        Self { spans }
    }
}

impl SpanEncoder for FixedSpanEncoder {
    fn propose_spans(
        &self,
        _text: &str,
        _labels: &IndexMap<String, String>,
        threshold: f64,
    ) -> Vec<(usize, usize, f64)> {
        self.spans
            .iter()
            .copied()
            .filter(|(_, _, sc)| *sc >= threshold)
            .collect()
    }
}

pub fn encoder_labels(ontology: &Ontology) -> IndexMap<String, String> {
    ontology
        .types
        .iter()
        .map(|t| (t.id.to_lowercase(), t.description.clone()))
        .collect()
}

#[cfg(feature = "spans")]
mod gliner {
    use super::*;
    use crate::error::{Error, Result};
    use candle_core::{DType, Device};
    use gliner_rs::download::download_variant;
    use gliner_rs::model_path::VariantDef;
    use gliner_rs::{ChunkOptions, ExtractOptions, GLiNER2};
    use serde_json::Value;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    const LONG_CHAR_HINT: usize = 1800;

    pub struct Gliner2Encoder {
        model_id: String,
        inner: Mutex<Option<GLiNER2>>,
    }

    impl Gliner2Encoder {
        pub fn new(model_id: impl Into<String>) -> Self {
            Self {
                model_id: model_id.into(),
                inner: Mutex::new(None),
            }
        }

        fn engine(&self) -> Result<std::sync::MutexGuard<'_, Option<GLiNER2>>> {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::Io("gliner lock poisoned".into()))?;
            if guard.is_none() {
                let path = resolve_checkpoint(&self.model_id)?;
                let model = GLiNER2::load(&path, &Device::Cpu, DType::F32)
                    .map_err(|e| Error::Io(format!("gliner load {}: {e}", path.display())))?;
                *guard = Some(model);
            }
            Ok(guard)
        }

        fn propose_spans_result(
            &self,
            text: &str,
            labels: &IndexMap<String, String>,
            threshold: f64,
        ) -> Result<Vec<(usize, usize, f64)>> {
            let names: Vec<String> = labels.keys().cloned().collect();
            let label_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
            let opts = ExtractOptions {
                threshold: threshold as f32,
                include_spans: true,
                include_confidence: true,
                ..Default::default()
            };
            let guard = self.engine()?;
            let model = guard.as_ref().expect("loaded");
            let result = if text.len() > LONG_CHAR_HINT {
                model
                    .extract_entities_long(text, &label_refs, &opts, ChunkOptions::default())
                    .map_err(|e| Error::Io(format!("gliner: {e}")))?
            } else {
                model
                    .extract_entities(text, &label_refs, &opts)
                    .map_err(|e| Error::Io(format!("gliner: {e}")))?
            };
            Ok(spans_from_gliner_json(&result, threshold))
        }
    }

    impl SpanEncoder for Gliner2Encoder {
        fn propose_spans(
            &self,
            text: &str,
            labels: &IndexMap<String, String>,
            threshold: f64,
        ) -> Vec<(usize, usize, f64)> {
            match self.propose_spans_result(text, labels, threshold) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("gliner propose failed: {e}");
                    Vec::new()
                }
            }
        }
    }

    fn spans_from_gliner_json(result: &Value, threshold: f64) -> Vec<(usize, usize, f64)> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let entities = result.get("entities").and_then(|v| v.as_object());
        if let Some(map) = entities {
            for (_label, items) in map {
                let Some(arr) = items.as_array() else {
                    continue;
                };
                for item in arr {
                    let start = item.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    let end = item.get("end").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    let score = item
                        .get("confidence")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(1.0);
                    if score < threshold {
                        continue;
                    }
                    if !seen.insert((start, end)) {
                        continue;
                    }
                    out.push((start, end, score));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| (b.1 - b.0).cmp(&(a.1 - a.0))));
        out
    }

    fn known_variant(model_id: &str) -> Option<VariantDef> {
        match model_id {
            "fastino/gliner2.5-base-v1" | "gliner2.5-base-v1" | "base" => Some(VariantDef {
                key: "base",
                hf_repo: "fastino/gliner2.5-base-v1",
            }),
            "fastino/gliner2.5-small-v1" | "gliner2.5-small-v1" | "small" => Some(VariantDef {
                key: "small",
                hf_repo: "fastino/gliner2.5-small-v1",
            }),
            "fastino/gliner2.5-multi-v1" | "gliner2.5-multi-v1" | "multi" => Some(VariantDef {
                key: "multi",
                hf_repo: "fastino/gliner2.5-multi-v1",
            }),
            _ => None,
        }
    }

    fn resolve_checkpoint(model_id: &str) -> Result<PathBuf> {
        let as_path = Path::new(model_id);
        if as_path.exists() {
            return Ok(as_path.to_path_buf());
        }
        if let Some(variant) = known_variant(model_id) {
            return download_variant(&variant).map_err(|e| Error::Io(e.to_string()));
        }
        let name = model_id.rsplit('/').next().unwrap_or(model_id);
        if let Some(dir) = gliner_rs::download::cache_dir() {
            let cached = dir.join(name);
            if cached.exists() {
                return Ok(cached);
            }
        }
        Err(Error::Io(format!(
            "GLiNER checkpoint {model_id} is not a local path. Use fastino/gliner2.5-base-v1 \
             (downloaded on first use), or pass a checkpoint directory to --encoder-model."
        )))
    }
}

#[cfg(feature = "spans")]
pub use gliner::Gliner2Encoder;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candidates::{propose_mentions, GazetteerProposer};
    use crate::ontology::load_ontology_named;
    use crate::types::MentionSource;

    #[test]
    fn encoder_proposer_emits_mentions() {
        let ont = load_ontology_named("conll04").unwrap();
        let text = "Jane Doe joined Acme Inc in Berlin.";
        let sent = Sentence {
            id: "s0".into(),
            text: text.into(),
            start: 0,
            end: text.len(),
            heading_path: vec![],
            index: 0,
        };
        let encoder = Arc::new(FixedSpanEncoder::new(vec![
            (0, 8, 0.99),
            (16, 24, 0.95),
            (28, 34, 0.9),
        ]));
        let proposers: Vec<Box<dyn Proposer>> = vec![
            Box::new(GazetteerProposer),
            Box::new(EncoderProposer::new(encoder, 0.5)),
        ];
        let mentions = propose_mentions(&sent, &ont, &proposers);
        let live: Vec<_> = mentions
            .iter()
            .filter(|m| m.skipped_reason.is_none())
            .collect();
        let surfaces: Vec<_> = live.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(surfaces, vec!["Jane Doe", "Acme Inc", "Berlin"]);
        assert!(live.iter().all(|m| m.source == MentionSource::Encoder));
    }
}

#[cfg(all(test, feature = "spans"))]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_gliner_fixture_sentence() {
        let encoder = Gliner2Encoder::new("fastino/gliner2.5-small-v1");
        let text = "Jane Doe joined Acme Inc in Berlin.";
        let mut labels = IndexMap::new();
        labels.insert("person".into(), "a person".into());
        labels.insert("organization".into(), "a group".into());
        labels.insert("location".into(), "a place".into());
        let spans = encoder.propose_spans(text, &labels, 0.3);
        assert!(
            !spans.is_empty(),
            "expected GLiNER spans on a short sentence, got {spans:?}"
        );
    }
}
