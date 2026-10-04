//! End-to-end extract: parse, propose, decide, gate, assemble.

use crate::assemble::assemble;
use crate::audit::{audit_graph, lineage};
use crate::cache::DecisionCache;
use crate::candidates::{default_proposers, propose_mentions, Proposer};
use crate::decisions::{
    forecast_calls, relate_all, type_all, CachedClient, CallForecast, DECISION_CONTRACT,
    DEFAULT_MAX_PROMPT_TOKENS, DEFAULT_MAX_QUESTIONS, MAX_PAIRS_PER_SENTENCE,
};
use crate::types::{Mention, RelationHit, TypedMention};
use crate::error::Result;
use crate::gate::GateConfig;
use crate::markdown::split_sentences;
use crate::ontology::Ontology;
#[cfg(feature = "native")]
use crate::ontology::load_ontology_named;
use crate::systemone::SystemOneClient;
#[cfg(feature = "native")]
use crate::systemone::DEFAULT_BASE_URL;
use crate::types::{ExtractionResult, PipelineStats, Sentence};
#[cfg(feature = "native")]
use std::path::Path;
use web_time::{Instant, SystemTime, UNIX_EPOCH};

pub struct Extractor {
    pub ontology: Ontology,
    pub client: SystemOneClient,
    pub gate: GateConfig,
    pub cache: Option<DecisionCache>,
    pub max_pairs: usize,
    pub max_questions: usize,
    pub max_prompt_tokens: usize,
    pub proposers: Vec<Box<dyn Proposer>>,
}

impl Extractor {
    pub fn new(ontology: Ontology, client: SystemOneClient) -> Self {
        Self {
            ontology,
            client,
            gate: GateConfig::default(),
            cache: None,
            max_pairs: MAX_PAIRS_PER_SENTENCE,
            max_questions: DEFAULT_MAX_QUESTIONS,
            max_prompt_tokens: DEFAULT_MAX_PROMPT_TOKENS,
            proposers: default_proposers(),
        }
    }

    pub fn with_gate(mut self, gate: GateConfig) -> Self {
        self.gate = gate;
        self
    }

    pub fn with_cache(mut self, cache: DecisionCache) -> Self {
        self.cache = Some(cache);
        self
    }

    pub fn with_max_pairs(mut self, max_pairs: usize) -> Self {
        self.max_pairs = max_pairs;
        self
    }

    pub fn with_max_questions(mut self, max_questions: usize) -> Self {
        self.max_questions = max_questions.max(1);
        self
    }

    pub fn with_max_prompt_tokens(mut self, max_prompt_tokens: usize) -> Self {
        self.max_prompt_tokens = max_prompt_tokens.max(1);
        self
    }

    pub fn with_proposers(mut self, proposers: Vec<Box<dyn Proposer>>) -> Self {
        self.proposers = proposers;
        self
    }

    pub fn extract_markdown(&self, text: &str, document_id: &str) -> Result<ExtractionResult> {
        let started = Instant::now();
        let t0 = unix_now();
        let sentences = split_sentences(text, document_id);
        let chunk_id = format!("{document_id}-chunk-0");
        self.extract_sentences(&sentences, document_id, &chunk_id, started, t0)
    }

    pub fn extract_sentences(
        &self,
        sentences: &[Sentence],
        document_id: &str,
        chunk_id: &str,
        started: Instant,
        t0: f64,
    ) -> Result<ExtractionResult> {
        let mut acc = Acc::default();
        self.run_section(&mut acc, sentences)?;
        let elapsed = started.elapsed().as_millis() as i64;
        self.snapshot(&acc, sentences, document_id, chunk_id, elapsed, t0, true)
    }

    /// Read one run of sentences: propose, ask the model, and fold the answers into `acc`.
    /// `acc` changes only if the whole section succeeds, so a failed section can be retried.
    fn run_section(&self, acc: &mut Acc, sentences: &[Sentence]) -> Result<()> {
        let mut cached = CachedClient::new(&self.client, self.cache.as_ref());
        let mut proposed = 0usize;
        let mut skipped = 0usize;
        let mut proposed_mentions: Vec<Vec<Mention>> = Vec::new();
        for sent in sentences {
            let mentions = propose_mentions(sent, &self.ontology, &self.proposers);
            proposed += mentions.len();
            skipped += mentions.iter().filter(|m| m.skipped_reason.is_some()).count();
            proposed_mentions.push(mentions);
        }
        let all_typed = type_all(
            sentences,
            &proposed_mentions,
            &self.ontology,
            &mut cached,
            &self.gate,
            self.max_questions,
            self.max_prompt_tokens,
        )?;
        let (hit_groups, trunc) = relate_all(
            sentences,
            &all_typed,
            &self.ontology,
            &mut cached,
            &self.gate,
            self.max_pairs,
            self.max_questions,
            self.max_prompt_tokens,
        )?;
        acc.proposed += proposed;
        acc.skipped += skipped;
        acc.truncated += trunc;
        acc.pairs += trunc + hit_groups.iter().map(Vec::len).sum::<usize>();
        acc.calls += cached.calls;
        acc.cache_hits += cached.cache_hits;
        acc.input_tokens += cached.input_tokens;
        acc.output_tokens += cached.output_tokens;
        acc.decision_wall_ms += cached.decision_wall_ms;
        acc.questions_inferred += cached.questions_inferred;
        acc.questions_from_cache += cached.questions_from_cache;
        acc.typed.extend(all_typed.into_iter().flatten());
        acc.hits.extend(hit_groups.into_iter().flatten());
        Ok(())
    }

    /// The graph from everything read so far. `record` also logs the run in the cache.
    #[allow(clippy::too_many_arguments)]
    fn snapshot(
        &self,
        acc: &Acc,
        read: &[Sentence],
        document_id: &str,
        chunk_id: &str,
        elapsed_ms: i64,
        t0: f64,
        record: bool,
    ) -> Result<ExtractionResult> {
        let mut result = assemble(
            acc.typed.clone(),
            acc.hits.clone(),
            &self.ontology,
            document_id,
            chunk_id,
        );
        audit_graph(&result, &self.ontology, read)?;
        let traces = lineage(&result);
        let stats = PipelineStats {
            sentences: read.len(),
            mentions_proposed: acc.proposed,
            mentions_skipped: acc.skipped,
            pairs_considered: acc.pairs,
            pairs_truncated: acc.truncated,
            systemone_calls: acc.calls,
            cache_hits: acc.cache_hits,
            input_tokens: acc.input_tokens,
            output_tokens: acc.output_tokens,
            elapsed_ms,
            decision_wall_ms: acc.decision_wall_ms,
            questions_inferred: acc.questions_inferred,
            questions_from_cache: acc.questions_from_cache,
        };
        result.metadata = serde_json::json!({
            "parser": "edgextract",
            "contract": DECISION_CONTRACT,
            "ontology_id": self.ontology.id,
            "model": self.client.model,
            "gate_fitted": self.gate.fitted,
            "stats": stats,
            "lineage": traces,
        });
        result.input_tokens = stats.input_tokens;
        result.output_tokens = stats.output_tokens;
        result.extraction_time_ms = elapsed_ms;
        if record {
            if let Some(cache) = &self.cache {
                let finished = unix_now();
                let dumped = serde_json::to_value(&result).unwrap_or(serde_json::Value::Null);
                cache.record_run(
                    &run_id(),
                    document_id,
                    &self.client.model,
                    &self.ontology.id,
                    &serde_json::to_value(&stats).unwrap_or(serde_json::Value::Null),
                    &dumped,
                    t0,
                    finished,
                )?;
            }
        }
        Ok(result)
    }

    /// Read a long document in sections of about `section_chars` characters, one section per
    /// [`Session::step`]. Between steps the caller can show progress, paint the graph so far,
    /// stop, or carry on. Every section is an ordinary run, so nothing about the answers changes:
    /// only when you get to see them.
    pub fn into_session(self, text: &str, document_id: &str, section_chars: usize) -> Session {
        let sentences = split_sentences(text, document_id);
        let sections = plan_sections(&sentences, section_chars);
        Session {
            chunk_id: format!("{document_id}-chunk-0"),
            document_id: document_id.to_string(),
            sentences,
            total_sections: sections.len(),
            sections,
            next: 0,
            acc: Acc::default(),
            work_ms: 0,
            t0: unix_now(),
            ex: self,
        }
    }
}

/// What has been collected so far across sections.
#[derive(Default)]
struct Acc {
    typed: Vec<TypedMention>,
    hits: Vec<RelationHit>,
    proposed: usize,
    skipped: usize,
    pairs: usize,
    truncated: usize,
    calls: usize,
    cache_hits: usize,
    input_tokens: i64,
    output_tokens: i64,
    decision_wall_ms: i64,
    questions_inferred: usize,
    questions_from_cache: usize,
}

/// Group sentences into sections of about `target_chars`, preferring to end a section
/// where a new heading begins.
pub fn plan_sections(sentences: &[Sentence], target_chars: usize) -> Vec<(usize, usize)> {
    let target = target_chars.max(1);
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut size = 0usize;
    for (i, s) in sentences.iter().enumerate() {
        let new_heading = i > start && s.heading_path != sentences[i - 1].heading_path;
        if size > 0 && (size >= target || (new_heading && size * 2 >= target)) {
            out.push((start, i));
            start = i;
            size = 0;
        }
        size += s.text.len();
    }
    if start < sentences.len() {
        out.push((start, sentences.len()));
    }
    out
}

/// Where a [`Session`] is, for a progress bar.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Progress {
    pub section: usize,
    pub sections: usize,
    pub sentences_done: usize,
    pub sentences: usize,
    pub calls: usize,
    pub cache_hits: usize,
    /// Milliseconds spent reading so far (not counting time paused).
    pub work_ms: i64,
    pub done: bool,
}

/// A document being read section by section. See [`Extractor::into_session`].
pub struct Session {
    ex: Extractor,
    document_id: String,
    chunk_id: String,
    sentences: Vec<Sentence>,
    sections: Vec<(usize, usize)>,
    /// How many sections the whole document has, before any `limit_sections`.
    total_sections: usize,
    next: usize,
    acc: Acc,
    work_ms: i64,
    t0: f64,
}

impl Session {
    pub fn sentences(&self) -> &[Sentence] {
        &self.sentences
    }

    pub fn ontology(&self) -> &Ontology {
        &self.ex.ontology
    }

    /// The sentences of the sections read so far.
    pub fn read_sentences(&self) -> &[Sentence] {
        &self.sentences[..self.read_upto()]
    }

    pub fn sections(&self) -> usize {
        self.sections.len()
    }

    pub fn total_sections(&self) -> usize {
        self.total_sections
    }

    /// Read only the first `n` sections (and no more), e.g. to preview a long document.
    pub fn limit_sections(&mut self, n: usize) {
        self.sections.truncate(n.max(1));
    }

    pub fn done(&self) -> bool {
        self.next >= self.sections.len()
    }

    /// Before reading anything: how big is this job? Nothing here calls the model.
    pub fn forecast(&self) -> CallForecast {
        let mentions: Vec<Vec<Mention>> = self
            .sentences
            .iter()
            .map(|s| propose_mentions(s, &self.ex.ontology, &self.ex.proposers))
            .collect();
        forecast_calls(
            &self.sentences,
            &mentions,
            &self.ex.ontology,
            self.ex.max_questions,
            self.ex.max_prompt_tokens,
        )
    }

    fn read_upto(&self) -> usize {
        match self.next {
            0 => 0,
            n => self.sections[n - 1].1,
        }
    }

    pub fn progress(&self) -> Progress {
        Progress {
            section: self.next,
            sections: self.sections.len(),
            sentences_done: self.read_upto(),
            sentences: self.sentences.len(),
            calls: self.acc.calls,
            cache_hits: self.acc.cache_hits,
            work_ms: self.work_ms,
            done: self.done(),
        }
    }

    /// Read the next section. On error nothing is lost and the same section is tried next time.
    pub fn step(&mut self) -> Result<Progress> {
        if self.done() {
            return Ok(self.progress());
        }
        let (a, b) = self.sections[self.next];
        let started = Instant::now();
        let outcome = self.ex.run_section(&mut self.acc, &self.sentences[a..b]);
        self.work_ms += started.elapsed().as_millis() as i64;
        outcome?;
        self.next += 1;
        Ok(self.progress())
    }

    /// The graph from the sections read so far.
    pub fn snapshot(&self) -> Result<ExtractionResult> {
        let read = &self.sentences[..self.read_upto()];
        self.ex
            .snapshot(&self.acc, read, &self.document_id, &self.chunk_id, self.work_ms, self.t0, false)
    }

    /// The final graph; also records the run in the cache.
    pub fn finish(&self) -> Result<ExtractionResult> {
        let read = &self.sentences[..self.read_upto()];
        self.ex
            .snapshot(&self.acc, read, &self.document_id, &self.chunk_id, self.work_ms, self.t0, true)
    }
}

#[cfg(feature = "native")]
fn run_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(not(feature = "native"))]
fn run_id() -> String {
    format!("run-{}", (unix_now() * 1000.0) as u64)
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(feature = "native")]
pub fn extractor_from_files(
    ontology_path: impl AsRef<Path>,
    model: &str,
    base_url: &str,
    cache_path: Option<&Path>,
    timeout: f64,
) -> Result<Extractor> {
    let ontology = load_ontology_named(ontology_path.as_ref().to_str().unwrap_or("tech_docs"))?;
    let client = SystemOneClient::new(model, base_url, timeout);
    let mut ext = Extractor::new(ontology, client);
    if let Some(path) = cache_path {
        ext = ext.with_cache(DecisionCache::open(path)?);
    }
    Ok(ext)
}

#[cfg(feature = "native")]
pub fn extract_text(
    text: &str,
    ontology: &str,
    model: &str,
    document_id: &str,
    base_url: Option<&str>,
) -> Result<ExtractionResult> {
    let ont = load_ontology_named(ontology)?;
    let client = SystemOneClient::new(model, base_url.unwrap_or(DEFAULT_BASE_URL), 60.0);
    Extractor::new(ont, client).extract_markdown(text, document_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ontology::load_ontology_named;
    use crate::standin::rule_handler;
    use crate::testing::{HandlerFn, LocalTransport};
    use std::sync::Arc;

    /// A model host with the real one's hard limit: a prompt over 2050 tokens is refused,
    /// never truncated. Tokens are guessed at 3 characters each, a little worse than prose.
    fn strict_host(ontology: &Ontology) -> HandlerFn {
        let inner = rule_handler(ontology);
        Arc::new(move |body| {
            let tokens = body.to_string().len() / 3;
            if tokens > 2050 {
                return Err(format!(
                    "http 400: {{\"error\": \"prompt 0 has {tokens} tokens; expected 1-2050 (input is never truncated)\"}}"
                ));
            }
            inner(body)
        })
    }

    fn extractor(ontology: &str) -> Extractor {
        let ont = load_ontology_named(ontology).unwrap();
        let handler = strict_host(&ont);
        Extractor::new(
            ont,
            SystemOneClient::with_transport("m", Box::new(LocalTransport::new(handler))),
        )
    }

    /// The shape of a real wiki export: list items and quotes with no full stops,
    /// a table, one enormous line, and a few real sentences.
    fn awkward_document(repeat: usize) -> String {
        let mut text = String::from("---\ntitle: wiki\n---\n\n# Fund wiki\n\n");
        for i in 0..repeat {
            text.push_str(&format!("## Section {i}\n\n"));
            for j in 0..12 {
                text.push_str(&format!(
                    "- **term_{j}** — claim: Management fee, value: {j}.25% (basis not specified), conf: MEDIUM {{P{j}}}\n\t> \"Management Fee | {j}.25%\"\n"
                ));
            }
            text.push_str("\n| Name | Value | Page |\n| --- | --- | --- |\n| Acme Inc | 250,000 | 6 |\n| Northwind | 1.25% | 7 |\n\n");
            text.push_str(&"Acme Inc, Northwind and word ".repeat(300));
            text.push_str("\n\nAda Lovelace founded Northwind in Paris. Acme Inc invested in Northwind.\n\n");
        }
        text
    }

    #[test]
    fn a_long_awkward_document_never_overflows_a_prompt() {
        let text = awkward_document(2);
        assert!(text.len() > 20_000);
        let ex = extractor("company_news");
        // One shot: the old failure was a single unbounded "sentence" that could never fit.
        let result = ex.extract_markdown(&text, "wiki").expect("must not hit the token limit");
        let names: Vec<_> = result.entities.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"ADA_LOVELACE") && names.contains(&"NORTHWIND"), "{names:?}");
    }

    #[test]
    fn sections_show_partial_graphs_and_end_where_one_shot_ends() {
        let text = awkward_document(1);
        let one_shot = extractor("company_news").extract_markdown(&text, "wiki").unwrap();
        let mut session = extractor("company_news").into_session(&text, "wiki", 3000);
        assert!(session.progress().sections > 3);
        let before = session.snapshot().unwrap();
        assert!(before.entities.is_empty());
        let first = session.step().unwrap();
        assert_eq!(first.section, 1);
        assert!(!first.done);
        let partial = session.snapshot().unwrap();
        assert!(partial.metadata["stats"]["sentences"].as_u64().unwrap() < session.sentences().len() as u64);
        while !session.done() {
            session.step().unwrap();
        }
        let end = session.finish().unwrap();
        let rel = |r: &ExtractionResult| {
            let mut v: Vec<_> = r
                .relationships
                .iter()
                .map(|x| format!("{} {} {}", x.source, x.relation_type, x.target))
                .collect();
            v.sort();
            v.dedup();
            v
        };
        assert_eq!(rel(&end), rel(&one_shot));
        assert_eq!(end.entities.len(), one_shot.entities.len());
        assert!(session.progress().done);
    }

    #[test]
    fn a_failed_section_loses_nothing_and_can_be_retried() {
        struct Flaky(std::sync::atomic::AtomicUsize, HandlerFn);
        impl crate::systemone::Transport for Flaky {
            fn post_json(
                &self,
                _: &str,
                body: &serde_json::Value,
            ) -> std::result::Result<serde_json::Value, crate::error::SystemOneError> {
                let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n == 1 {
                    return Err(crate::error::SystemOneError::new("transport: connection reset"));
                }
                (self.1)(body.clone()).map_err(crate::error::SystemOneError::new)
            }
        }
        let ont = load_ontology_named("company_news").unwrap();
        let transport = Flaky(Default::default(), rule_handler(&ont));
        let ex = Extractor::new(ont, SystemOneClient::with_transport("m", Box::new(transport)));
        let text = "Ada Lovelace founded Northwind in Paris.\n\nAcme Inc invested in Northwind.\n";
        let mut session = ex.into_session(text, "d", 40);
        let mut failures = 0;
        while !session.done() {
            if session.step().is_err() {
                failures += 1;
            }
        }
        assert_eq!(failures, 1);
        let end = session.finish().unwrap();
        assert_eq!(end.relationships.len(), 2, "{:?}", end.relationships);
    }

    #[test]
    fn the_forecast_counts_the_work_before_any_model_call() {
        let text = awkward_document(2);
        let ex = Extractor::new(
            load_ontology_named("company_news").unwrap(),
            SystemOneClient::with_transport(
                "m",
                Box::new(LocalTransport::new(Arc::new(|_| Err("must not be called".into())))),
            ),
        )
        .with_proposers(crate::candidates::discovering_proposers());
        let session = ex.into_session(&text, "wiki", 3000);
        let f = session.forecast();
        assert!(f.unknown_names > 10, "{f:?}");
        assert!(f.typing_calls >= 1 && f.estimated_calls > f.typing_calls, "{f:?}");
    }
}
