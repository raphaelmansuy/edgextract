//! Closed-decision knowledge graph extraction from text and an ontology.
//!
//! First principles (FP-1..FP-8): the caller owns the question and the legal
//! answers; the model returns a distribution over those labels; nobody invents
//! a free-text type name.

pub mod assemble;
pub mod audit;
pub mod benchmarks;
pub mod cache;
pub mod candidates;
pub mod decisions;
pub mod error;
pub mod eval;
pub mod gate;
pub mod markdown;
pub mod names;
pub mod ontology;
pub mod pipeline;
pub mod span_encoder;
pub mod standin;
pub mod systemone;
pub mod testing;
pub mod types;

pub use decisions::DECISION_CONTRACT;
pub use error::{Error, Result, SystemOneError};
pub use gate::GateConfig;
pub use ontology::{load_ontology, load_ontology_named, Ontology};
#[cfg(feature = "native")]
pub use pipeline::extract_text;
pub use pipeline::Extractor;
pub use systemone::SystemOneClient;
pub use types::ExtractionResult;
