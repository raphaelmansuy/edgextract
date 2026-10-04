use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum GateBand {
    Accept,
    Review,
    Reject,
}

impl GateBand {
    pub fn as_str(self) -> &'static str {
        match self {
            GateBand::Accept => "ACCEPT",
            GateBand::Review => "REVIEW",
            GateBand::Reject => "REJECT",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MentionSource {
    Gazetteer,
    Markdown,
    Shape,
    Encoder,
}

impl MentionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            MentionSource::Gazetteer => "gazetteer",
            MentionSource::Markdown => "markdown",
            MentionSource::Shape => "shape",
            MentionSource::Encoder => "encoder",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sentence {
    pub id: String,
    pub text: String,
    pub start: usize,
    pub end: usize,
    #[serde(default)]
    pub heading_path: Vec<String>,
    #[serde(default)]
    pub index: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mention {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub sentence_id: String,
    #[serde(default)]
    pub heading_path: Vec<String>,
    #[serde(default = "default_shape")]
    pub source: MentionSource,
    #[serde(default)]
    pub skipped_reason: Option<String>,
}

fn default_shape() -> MentionSource {
    MentionSource::Shape
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChoiceAnswer {
    #[serde(rename = "type")]
    pub kind: String,
    pub choice: String,
    pub probabilities: indexmap::IndexMap<String, f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SystemOneResponse {
    pub model: String,
    pub answers: serde_json::Map<String, Value>,
    #[serde(default)]
    pub usage: Usage,
}

impl SystemOneResponse {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TypedMention {
    pub mention: Mention,
    pub entity_type: String,
    #[serde(default)]
    pub probabilities: indexmap::IndexMap<String, f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default = "default_review")]
    pub band: GateBand,
    #[serde(default)]
    pub winner_prob: f64,
    #[serde(default)]
    pub flipped: bool,
    #[serde(default)]
    pub question_id: String,
    #[serde(default = "default_decided_by")]
    pub decided_by: String,
}

fn default_review() -> GateBand {
    GateBand::Review
}

fn default_decided_by() -> String {
    "model".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RelationHit {
    pub source_text: String,
    pub source_type: String,
    pub source_start: usize,
    pub source_end: usize,
    pub target_text: String,
    pub target_type: String,
    pub target_start: usize,
    pub target_end: usize,
    pub relation_type: String,
    /// The relation the question asked about. A review or rejected hit has
    /// `relation_type == "NONE"`, so this is the only place that names the link.
    #[serde(default)]
    pub asked: String,
    #[serde(default)]
    pub probabilities: indexmap::IndexMap<String, f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default = "default_review")]
    pub band: GateBand,
    #[serde(default)]
    pub winner_prob: f64,
    #[serde(default)]
    pub flipped: bool,
    pub sentence_id: String,
    #[serde(default)]
    pub heading_path: Vec<String>,
    #[serde(default)]
    pub evidence: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtractedEntity {
    pub name: String,
    pub entity_type: String,
    pub description: String,
    #[serde(default = "default_half")]
    pub importance: f64,
    #[serde(default)]
    pub source_spans: Vec<String>,
    #[serde(default)]
    pub source_chunk_ids: Vec<String>,
    #[serde(default)]
    pub source_document_id: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

fn default_half() -> f64 {
    0.5
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtractedRelationship {
    pub source: String,
    pub target: String,
    pub relation_type: String,
    pub description: String,
    #[serde(default = "default_half")]
    pub weight: f64,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub source_chunk_ids: Vec<String>,
    #[serde(default)]
    pub source_document_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ExtractionResult {
    #[serde(default)]
    pub entities: Vec<ExtractedEntity>,
    #[serde(default)]
    pub relationships: Vec<ExtractedRelationship>,
    #[serde(default)]
    pub source_chunk_id: String,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub extraction_time_ms: i64,
    #[serde(default)]
    pub review: Vec<Value>,
    #[serde(default)]
    pub rejected: Vec<Value>,
    #[serde(default)]
    pub mentions: Vec<TypedMention>,
    #[serde(default)]
    pub relation_hits: Vec<RelationHit>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PipelineStats {
    pub sentences: usize,
    pub mentions_proposed: usize,
    pub mentions_skipped: usize,
    pub pairs_considered: usize,
    pub pairs_truncated: usize,
    pub systemone_calls: usize,
    pub cache_hits: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub elapsed_ms: i64,
    #[serde(default)]
    pub decision_wall_ms: i64,
    #[serde(default)]
    pub questions_inferred: usize,
    #[serde(default)]
    pub questions_from_cache: usize,
}
