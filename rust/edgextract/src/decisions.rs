//! Turn mentions and pairs into closed System One questions.

use crate::cache::{request_key, DecisionCache};
use crate::error::{Error, Result, SystemOneError};
use crate::gate::GateConfig;
use crate::ontology::{Ontology, NO_RELATION, NOT_ENTITY};
use crate::systemone::{
    build_choice_question, build_noul_question, reverse_criteria, SystemOneClient,
};
use crate::types::{
    ChoiceAnswer, GateBand, Mention, RelationHit, Sentence, TypedMention,
};
use indexmap::IndexMap;
use serde_json::{Map, Value};

/// Default packed questions per POST /v1/systemone. One call is one model step.
pub const DEFAULT_MAX_QUESTIONS: usize = 64;
/// Stay under tev1's 2050-token host cap (input is never truncated).
pub const DEFAULT_MAX_PROMPT_TOKENS: usize = 2000;
pub const MAX_PAIRS_PER_SENTENCE: usize = 24;
/// Bump when question wording or packing rules change. Part of every cache key.
pub const DECISION_CONTRACT: &str = "edgextract.decision.2026-10-06";
const PACK_PREAMBLE: &str =
    "Use only the sentence quoted after 'In sentence' in each question. Ignore other sentences.";
const TOKEN_PAD: usize = 80;

pub struct CachedClient<'a> {
    pub inner: &'a SystemOneClient,
    cache: Option<&'a DecisionCache>,
    pub calls: usize,
    pub cache_hits: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub decision_wall_ms: i64,
    pub questions_inferred: usize,
    pub questions_from_cache: usize,
}

impl<'a> CachedClient<'a> {
    pub fn new(inner: &'a SystemOneClient, cache: Option<&'a DecisionCache>) -> Self {
        Self {
            inner,
            cache,
            calls: 0,
            cache_hits: 0,
            input_tokens: 0,
            output_tokens: 0,
            decision_wall_ms: 0,
            questions_inferred: 0,
            questions_from_cache: 0,
        }
    }

    pub fn decide(&mut self, state: &str, questions: &Map<String, Value>) -> Result<Value> {
        match self.decide_once(state, questions) {
            Ok(v) => Ok(v),
            Err(e) if is_prompt_too_long(&e) && questions.len() > 1 => {
                let keys: Vec<String> = questions.keys().cloned().collect();
                let mid = keys.len() / 2;
                let mut left = Map::new();
                let mut right = Map::new();
                for (i, k) in keys.iter().enumerate() {
                    if i < mid {
                        left.insert(k.clone(), questions[k].clone());
                    } else {
                        right.insert(k.clone(), questions[k].clone());
                    }
                }
                let a = self.decide(state, &left)?;
                let b = self.decide(state, &right)?;
                Ok(merge_answer_payloads(a, b))
            }
            Err(e) => Err(e),
        }
    }

    fn decide_once(&mut self, state: &str, questions: &Map<String, Value>) -> Result<Value> {
        let state_v = Value::String(state.to_string());
        let qv = Value::Object(questions.clone());
        let key = request_key(DECISION_CONTRACT, &self.inner.model, &state_v, &qv, None);
        if let Some(cache) = self.cache {
            if let Some(cached) = cache.get(&key)? {
                self.cache_hits += 1;
                self.questions_from_cache += questions.len();
                return Ok(cached);
            }
        }
        let started = web_time::Instant::now();
        let resp = self.inner.decide_str(state, questions)?;
        self.decision_wall_ms += started.elapsed().as_millis() as i64;
        let payload = resp.to_value();
        self.calls += 1;
        self.questions_inferred += questions.len();
        self.input_tokens += resp.usage.input_tokens;
        self.output_tokens += resp.usage.output_tokens;
        if let Some(cache) = self.cache {
            cache.put(&key, &self.inner.model, &payload)?;
        }
        Ok(payload)
    }
}

pub fn estimate_tokens(state: &str, questions: &Map<String, Value>) -> usize {
    let body = serde_json::json!({
        "model": "m",
        "state": state,
        "questions": questions,
    });
    let encoded = serde_json::to_string(&body).unwrap_or_default();
    encoded.len().div_ceil(4) + TOKEN_PAD
}

pub fn is_prompt_too_long(err: &Error) -> bool {
    let s = err.to_string().to_lowercase();
    let http_oversize = s.contains("http 400") || s.contains("http 413");
    let tokenish = s.contains("token") || s.contains("context") || s.contains("too long");
    http_oversize && tokenish
}

fn merge_answer_payloads(mut a: Value, b: Value) -> Value {
    if let (Some(oa), Some(ob)) = (a.get_mut("answers").and_then(|v| v.as_object_mut()), b.get("answers").and_then(|v| v.as_object())) {
        for (k, v) in ob {
            oa.insert(k.clone(), v.clone());
        }
    }
    if let (Some(ua), Some(ub)) = (a.get_mut("usage"), b.get("usage")) {
        let inn = ua.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0)
            + ub.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        let out = ua.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0)
            + ub.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        ua["input_tokens"] = inn.into();
        ua["output_tokens"] = out.into();
    }
    a
}

fn ontology_types_block(ontology: &Ontology) -> String {
    let mut lines = vec!["Ontology types (legal labels only):".to_string()];
    for t in &ontology.types {
        lines.push(format!("  {}: {}", t.id, t.description));
    }
    lines.join("\n")
}

fn pack_ranges<T, F>(items: &[T], qmax: usize, max_tokens: usize, mut build: F) -> Vec<(usize, usize)>
where
    F: FnMut(&[T]) -> (String, Map<String, Value>),
{
    let qmax = qmax.max(1);
    let max_tokens = max_tokens.max(1);
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < items.len() {
        let mut end = start + 1;
        while end < items.len() && end - start < qmax {
            let (state, qs) = build(&items[start..end + 1]);
            if estimate_tokens(&state, &qs) > max_tokens {
                break;
            }
            end += 1;
        }
        ranges.push((start, end));
        start = end;
    }
    ranges
}

fn python_repr(text: &str) -> String {
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn entity_noul_instructions(sentence: &Sentence, mention: &Mention) -> String {
    format!(
        "In sentence ({}): Is mention ({}) a named entity of this ontology? \
         A pronoun, a common word, or a negated mention is no.",
        python_repr(&sentence.text),
        python_repr(&mention.text)
    )
}

fn type_choice_instructions(sentence: &Sentence, mention: &Mention) -> String {
    format!(
        "In sentence ({}): Which ontology type is mention ({})?",
        python_repr(&sentence.text),
        python_repr(&mention.text)
    )
}

fn rel_noul_instructions(
    sentence: &Sentence,
    src: &str,
    tgt: &str,
    rel_id: &str,
    description: &str,
) -> String {
    format!(
        "In sentence ({}): Does {rel_id} hold from {} to {}? {description} \
         Negation and mere possibility are no.",
        python_repr(&sentence.text),
        python_repr(src),
        python_repr(tgt)
    )
}

fn packed_state(multi_sentence: bool, single: String) -> String {
    if multi_sentence {
        PACK_PREAMBLE.to_string()
    } else {
        single
    }
}

fn as_noul(raw: &Value) -> Result<f64> {
    if raw.get("type").and_then(|v| v.as_str()) != Some("noul") {
        return Err(SystemOneError::new(format!(
            "expected noul, got {:?}",
            raw.get("type")
        ))
        .into());
    }
    raw.get("noul")
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)))
        .ok_or_else(|| SystemOneError::new("missing noul").into())
}

fn as_choice(raw: &Value) -> Result<ChoiceAnswer> {
    if raw.get("type").and_then(|v| v.as_str()) != Some("choice") {
        return Err(SystemOneError::new(format!(
            "expected choice, got {:?}",
            raw.get("type")
        ))
        .into());
    }
    let choice = raw
        .get("choice")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SystemOneError::new("missing choice"))?;
    let mut probabilities = IndexMap::new();
    if let Some(obj) = raw.get("probabilities").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(p) = v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)) {
                probabilities.insert(k.clone(), p);
            }
        }
    }
    let confidence = raw.get("confidence").and_then(|v| {
        if v.is_null() {
            None
        } else {
            v.as_f64().or_else(|| v.as_i64().map(|i| i as f64))
        }
    });
    Ok(ChoiceAnswer {
        kind: "choice".into(),
        choice: choice.to_string(),
        probabilities,
        confidence,
    })
}

fn typing_criteria(ontology: &Ontology) -> Result<IndexMap<String, String>> {
    if ontology.needs_two_stage_typing() {
        ontology.group_choice_criteria()
    } else {
        ontology.type_choice_criteria()
    }
}

fn type_only_criteria(ontology: &Ontology) -> Result<IndexMap<String, String>> {
    Ok(typing_criteria(ontology)?
        .into_iter()
        .filter(|(k, _)| k != NOT_ENTITY)
        .collect())
}

fn state_for_mentions(sentence: &Sentence, mentions: &[&Mention]) -> String {
    let heading = if sentence.heading_path.is_empty() {
        "(none)".to_string()
    } else {
        sentence.heading_path.join(" > ")
    };
    let mut lines = vec![
        format!("Heading: {heading}"),
        format!("Sentence: {}", sentence.text),
        "Mentions:".into(),
    ];
    for (i, m) in mentions.iter().enumerate() {
        lines.push(format!("  [{i}] {}", m.text));
    }
    lines.join("\n")
}

fn state_for_pairs(sentence: &Sentence, typed: &[&TypedMention]) -> String {
    let heading = if sentence.heading_path.is_empty() {
        "(none)".to_string()
    } else {
        sentence.heading_path.join(" > ")
    };
    let mut lines = vec![
        format!("Heading: {heading}"),
        format!("Sentence: {}", sentence.text),
        "Typed mentions:".into(),
    ];
    for (i, t) in typed.iter().enumerate() {
        lines.push(format!("  [{i}] {} ({})", t.mention.text, t.entity_type));
    }
    lines.join("\n")
}

fn choice_with_optional_rotation(
    client: &mut CachedClient,
    state: &str,
    qid: &str,
    question: &Value,
    raw: &Value,
    gate: &GateConfig,
) -> Result<(ChoiceAnswer, bool)> {
    let ans = as_choice(raw)?;
    require_closed_choice(&ans, question)?;
    if !gate.needs_rotation(ans.confidence) {
        return Ok((ans, false));
    }
    let criteria: IndexMap<String, String> = question
        .get("criteria")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let instructions = question
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut rotated = Map::new();
    rotated.insert(
        qid.to_string(),
        build_choice_question(instructions, &reverse_criteria(&criteria))?,
    );
    let second_payload = client.decide(state, &rotated)?;
    let second = as_choice(&second_payload["answers"][qid])?;
    require_closed_choice(&second, &rotated[qid])?;
    if second.choice != ans.choice {
        return Ok((second, true));
    }
    Ok((ans, false))
}

/// FP-1: the winning label must be one of the labels this question listed.
fn require_closed_choice(ans: &ChoiceAnswer, question: &Value) -> Result<()> {
    let allowed = question
        .get("criteria")
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().collect::<Vec<_>>())
        .unwrap_or_default();
    if !allowed.iter().any(|k| k.as_str() == ans.choice) {
        return Err(SystemOneError::new(format!(
            "choice {:?} is outside the labels this question listed",
            ans.choice
        ))
        .into());
    }
    Ok(())
}

fn refine_group(
    client: &mut CachedClient,
    state: &str,
    qid: &str,
    mention: &Mention,
    ontology: &Ontology,
    first: ChoiceAnswer,
) -> Result<(ChoiceAnswer, bool)> {
    let idx: usize = first
        .choice
        .split('_')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(usize::MAX);
    let groups = ontology.type_groups();
    if idx >= groups.len() {
        return Ok((first, false));
    }
    let mut criteria = IndexMap::new();
    for t in &groups[idx] {
        criteria.insert(t.id.clone(), t.description.clone());
    }
    criteria.insert(
        NOT_ENTITY.into(),
        "Not a named entity of this ontology, or a pronoun, or noise.".into(),
    );
    let mut questions = Map::new();
    questions.insert(
        qid.to_string(),
        build_choice_question(
            &format!(
                "Which type in this group is mention ({})? Pick NOT_ENTITY if none.",
                python_repr(&mention.text)
            ),
            &criteria,
        )?,
    );
    let payload = client.decide(state, &questions)?;
    let ans = as_choice(&payload["answers"][qid])?;
    require_closed_choice(&ans, &questions[qid])?;
    Ok((ans, false))
}

fn hit(
    src: &TypedMention,
    tgt: &TypedMention,
    relation: &str,
    asked: &str,
    sentence: &Sentence,
    band: GateBand,
    winner_prob: f64,
    probabilities: IndexMap<String, f64>,
    confidence: Option<f64>,
    flipped: bool,
) -> RelationHit {
    RelationHit {
        source_text: src.mention.text.clone(),
        source_type: src.entity_type.clone(),
        source_start: src.mention.start,
        source_end: src.mention.end,
        target_text: tgt.mention.text.clone(),
        target_type: tgt.entity_type.clone(),
        target_start: tgt.mention.start,
        target_end: tgt.mention.end,
        relation_type: relation.to_string(),
        asked: asked.to_string(),
        probabilities,
        confidence,
        band,
        winner_prob,
        flipped,
        sentence_id: sentence.id.clone(),
        heading_path: sentence.heading_path.clone(),
        evidence: sentence.text.clone(),
    }
}

fn typing_batch_payload(
    sentences: &[Sentence],
    batch: &[UnknownSpan],
    _ontology: &Ontology,
) -> (String, Map<String, Value>) {
    let multi = batch.iter().any(|u| u.sent_idx != batch[0].sent_idx);
    let mut questions = Map::new();
    let mut batch_mentions: Vec<&Mention> = Vec::new();
    for (b, item) in batch.iter().enumerate() {
        batch_mentions.push(&item.mention);
        questions.insert(
            format!("e{b}"),
            build_noul_question(
                &entity_noul_instructions(&sentences[item.sent_idx], &item.mention),
                Some("Not a named entity in this ontology."),
                Some("A named entity this ontology can type."),
            ),
        );
    }
    let state = packed_state(
        multi,
        state_for_mentions(&sentences[batch[0].sent_idx], &batch_mentions),
    );
    (state, questions)
}

struct UnknownSpan {
    sent_idx: usize,
    mention: Mention,
}

pub fn type_mentions(
    sentence: &Sentence,
    mentions: &[Mention],
    ontology: &Ontology,
    client: &mut CachedClient,
    gate: &GateConfig,
    max_questions: usize,
) -> Result<Vec<TypedMention>> {
    let sentences = [sentence.clone()];
    let grouped = [mentions.to_vec()];
    let mut out = type_all(
        &sentences,
        &grouped,
        ontology,
        client,
        gate,
        max_questions,
        DEFAULT_MAX_PROMPT_TOKENS,
    )?;
    Ok(out.pop().unwrap_or_default())
}

/// A rough forecast of the work a document needs, made before any model call.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct CallForecast {
    /// Candidate names the ontology does not list (each is asked about).
    pub unknown_names: usize,
    /// Model calls needed to ask about them (this one is counted exactly).
    pub typing_calls: usize,
    /// Everything: names, kinds and links. A guess, not a promise.
    pub estimated_calls: usize,
}

/// Count the typing calls exactly and guess the rest. Links depend on which names the
/// model accepts, which nobody knows yet, so they are estimated from how crowded each
/// sentence is.
pub fn forecast_calls(
    sentences: &[Sentence],
    mentions: &[Vec<Mention>],
    ontology: &Ontology,
    max_questions: usize,
    max_prompt_tokens: usize,
) -> CallForecast {
    let mut unknown: Vec<UnknownSpan> = Vec::new();
    let mut relation_questions = 0f64;
    let per_pair = (ontology.relations.len() as f64 / 3.0).ceil().max(1.0);
    for (sent_idx, ments) in mentions.iter().enumerate() {
        let live: Vec<&Mention> = ments.iter().filter(|m| m.skipped_reason.is_none()).collect();
        for m in &live {
            if ontology.gazetteer_type(&m.text).is_none() {
                unknown.push(UnknownSpan { sent_idx, mention: (*m).clone() });
            }
        }
        let k = live.len() as f64;
        // Half of the candidates are typically accepted; a pair is asked in both directions.
        let accepted = (k * 0.5).max(if k >= 2.0 { 2.0 } else { 0.0 });
        relation_questions += (accepted * (accepted - 1.0)).min(MAX_PAIRS_PER_SENTENCE as f64) * per_pair;
    }
    let typing_calls = if unknown.is_empty() {
        0
    } else {
        pack_ranges(&unknown, max_questions, max_prompt_tokens, |batch| {
            typing_batch_payload(sentences, batch, ontology)
        })
        .len()
    };
    // Each typing batch is followed by a kind question for the survivors.
    let relation_calls = (relation_questions / 12.0).ceil() as usize;
    CallForecast {
        unknown_names: unknown.len(),
        typing_calls,
        estimated_calls: typing_calls * 2 + relation_calls,
    }
}

/// Type every sentence, packing unknown-span questions across the document.
pub fn type_all(
    sentences: &[Sentence],
    mentions: &[Vec<Mention>],
    ontology: &Ontology,
    client: &mut CachedClient,
    gate: &GateConfig,
    max_questions: usize,
    max_prompt_tokens: usize,
) -> Result<Vec<Vec<TypedMention>>> {
    let qmax = max_questions.max(1);
    let tmax = max_prompt_tokens.max(1);
    let mut typed: Vec<Vec<TypedMention>> = vec![Vec::new(); sentences.len()];
    let mut unknown: Vec<UnknownSpan> = Vec::new();
    for (sent_idx, ments) in mentions.iter().enumerate() {
        let live: Vec<&Mention> = ments.iter().filter(|m| m.skipped_reason.is_none()).collect();
        for (i, mention) in live.iter().enumerate() {
            if let Some(declared) = ontology.gazetteer_type(&mention.text) {
                let mut probabilities = IndexMap::new();
                probabilities.insert(declared.to_string(), 1.0);
                typed[sent_idx].push(TypedMention {
                    mention: (*mention).clone(),
                    entity_type: declared.to_string(),
                    probabilities,
                    confidence: Some(1.0),
                    band: GateBand::Accept,
                    winner_prob: 1.0,
                    flipped: false,
                    question_id: format!("g{sent_idx}_{i}"),
                    decided_by: "ontology".into(),
                });
            } else {
                unknown.push(UnknownSpan {
                    sent_idx,
                    mention: (*mention).clone(),
                });
            }
        }
    }
    if unknown.is_empty() {
        return Ok(typed);
    }

    let ranges = pack_ranges(&unknown, qmax, tmax, |batch| {
        typing_batch_payload(sentences, batch, ontology)
    });
    for (start, end) in ranges {
        let batch = &unknown[start..end];
        let (state, questions) = typing_batch_payload(sentences, batch, ontology);
        let payload = client.decide(&state, &questions)?;
        let mut survivors: Vec<(usize, f64)> = Vec::new();
        for (b, item) in batch.iter().enumerate() {
            let p_yes = as_noul(&payload["answers"][format!("e{b}")])?;
            let band = gate.band_noul(p_yes);
            if band != GateBand::Accept {
                let mut probabilities = IndexMap::new();
                probabilities.insert("yes".into(), p_yes);
                probabilities.insert("no".into(), 1.0 - p_yes);
                typed[item.sent_idx].push(TypedMention {
                    mention: item.mention.clone(),
                    entity_type: NOT_ENTITY.into(),
                    probabilities,
                    confidence: None,
                    band,
                    winner_prob: p_yes,
                    flipped: false,
                    question_id: format!("e{b}"),
                    decided_by: "model".into(),
                });
            } else {
                survivors.push((b, p_yes));
            }
        }
        if survivors.is_empty() {
            continue;
        }
        let criteria = type_only_criteria(ontology)?;
        let mut choice_qs = Map::new();
        for (b, _) in &survivors {
            let item = &batch[*b];
            choice_qs.insert(
                format!("t{b}"),
                build_choice_question(
                    &type_choice_instructions(&sentences[item.sent_idx], &item.mention),
                    &criteria,
                )?,
            );
        }
        let choice_state = format!("{state}\n{}", ontology_types_block(ontology));
        let chosen = client.decide(&choice_state, &choice_qs)?;
        for (b, p_yes) in survivors {
            let item = &batch[b];
            let mention = &item.mention;
            let qid = format!("t{b}");
            let (mut ans, mut flipped) = choice_with_optional_rotation(
                client,
                &choice_state,
                &qid,
                &choice_qs[&qid],
                &chosen["answers"][&qid],
                gate,
            )?;
            if ans.choice.starts_with("GROUP_") {
                let extra;
                (ans, extra) = refine_group(client, &choice_state, &qid, mention, ontology, ans)?;
                flipped = flipped || extra;
            }
            let winner_p = *ans.probabilities.get(&ans.choice).unwrap_or(&0.0);
            let band = gate.band_choice(
                &ans.choice,
                winner_p,
                ans.confidence,
                &Default::default(),
                flipped,
            );
            typed[item.sent_idx].push(TypedMention {
                mention: mention.clone(),
                entity_type: if band == GateBand::Reject {
                    NOT_ENTITY.into()
                } else {
                    ans.choice
                },
                probabilities: ans.probabilities,
                confidence: ans.confidence,
                band: if band == GateBand::Reject {
                    GateBand::Review
                } else {
                    band
                },
                winner_prob: p_yes.min(winner_p),
                flipped,
                question_id: qid,
                decided_by: "model".into(),
            });
        }
    }
    Ok(typed)
}

pub fn relate_pairs(
    sentence: &Sentence,
    typed: &[TypedMention],
    ontology: &Ontology,
    client: &mut CachedClient,
    gate: &GateConfig,
    max_pairs: usize,
    max_questions: usize,
) -> Result<(Vec<RelationHit>, usize)> {
    let sentences = [sentence.clone()];
    let grouped = [typed.to_vec()];
    let (mut hits, trunc) = relate_all(
        &sentences,
        &grouped,
        ontology,
        client,
        gate,
        max_pairs,
        max_questions,
        DEFAULT_MAX_PROMPT_TOKENS,
    )?;
    Ok((hits.pop().unwrap_or_default(), trunc))
}

struct PredItem {
    sent_idx: usize,
    src: TypedMention,
    tgt: TypedMention,
    rel_id: String,
    description: String,
}

fn relate_batch_payload(
    sentences: &[Sentence],
    typed: &[Vec<TypedMention>],
    batch: &[PredItem],
    _ontology: &Ontology,
) -> (String, Map<String, Value>) {
    let multi = batch.iter().any(|p| p.sent_idx != batch[0].sent_idx);
    let mut noul_qs = Map::new();
    for (i, pred) in batch.iter().enumerate() {
        noul_qs.insert(
            format!("n{i}"),
            build_noul_question(
                &rel_noul_instructions(
                    &sentences[pred.sent_idx],
                    &pred.src.mention.text,
                    &pred.tgt.mention.text,
                    &pred.rel_id,
                    &pred.description,
                ),
                Some(&format!(
                    "The sentence does not assert {} in this direction.",
                    pred.rel_id
                )),
                Some(&format!(
                    "The sentence asserts {} from the first mention to the second.",
                    pred.rel_id
                )),
            ),
        );
    }
    let accepted: Vec<&TypedMention> = typed[batch[0].sent_idx]
        .iter()
        .filter(|t| t.band == GateBand::Accept && t.entity_type != NOT_ENTITY)
        .collect();
    let state = packed_state(
        multi,
        state_for_pairs(&sentences[batch[0].sent_idx], &accepted),
    );
    (state, noul_qs)
}

/// Relate every sentence, packing legal-link noul questions across the document.
pub fn relate_all(
    sentences: &[Sentence],
    typed: &[Vec<TypedMention>],
    ontology: &Ontology,
    client: &mut CachedClient,
    gate: &GateConfig,
    max_pairs: usize,
    max_questions: usize,
    max_prompt_tokens: usize,
) -> Result<(Vec<Vec<RelationHit>>, usize)> {
    let qmax = max_questions.max(1);
    let tmax = max_prompt_tokens.max(1);
    let mut hits: Vec<Vec<RelationHit>> = vec![Vec::new(); sentences.len()];
    let mut truncated = 0usize;
    let mut predicates: Vec<PredItem> = Vec::new();
    for (sent_idx, typed_sent) in typed.iter().enumerate() {
        let accepted: Vec<&TypedMention> = typed_sent
            .iter()
            .filter(|t| t.band == GateBand::Accept && t.entity_type != NOT_ENTITY)
            .collect();
        let mut pairs: Vec<(&TypedMention, &TypedMention, IndexMap<String, String>)> = Vec::new();
        for src in &accepted {
            for tgt in &accepted {
                if std::ptr::eq(*src, *tgt) {
                    continue;
                }
                if src.mention.start == tgt.mention.start && src.mention.end == tgt.mention.end {
                    continue;
                }
                let criteria =
                    ontology.relation_choice_criteria(&src.entity_type, &tgt.entity_type)?;
                if criteria.len() == 1 && criteria.contains_key(NO_RELATION) {
                    continue;
                }
                if pairs.len() >= max_pairs {
                    truncated += 1;
                    continue;
                }
                pairs.push((*src, *tgt, criteria));
            }
        }
        for (src, tgt, criteria) in pairs {
            for (rel_id, description) in criteria {
                if rel_id == NO_RELATION {
                    continue;
                }
                predicates.push(PredItem {
                    sent_idx,
                    src: src.clone(),
                    tgt: tgt.clone(),
                    rel_id,
                    description,
                });
            }
        }
    }
    if predicates.is_empty() {
        return Ok((hits, truncated));
    }
    let ranges = pack_ranges(&predicates, qmax, tmax, |batch| {
        relate_batch_payload(sentences, typed, batch, ontology)
    });
    for (start, end) in ranges {
        let batch = &predicates[start..end];
        let (state, noul_qs) = relate_batch_payload(sentences, typed, batch, ontology);
        let payload = client.decide(&state, &noul_qs)?;
        for (i, pred) in batch.iter().enumerate() {
            let p_yes = as_noul(&payload["answers"][format!("n{i}")])?;
            let band = gate.band_noul(p_yes);
            let sentence = &sentences[pred.sent_idx];
            if band == GateBand::Accept {
                let mut probs = IndexMap::new();
                probs.insert(pred.rel_id.clone(), p_yes);
                hits[pred.sent_idx].push(hit(
                    &pred.src,
                    &pred.tgt,
                    &pred.rel_id,
                    &pred.rel_id,
                    sentence,
                    band,
                    p_yes,
                    probs,
                    None,
                    false,
                ));
            } else {
                let mut probs = IndexMap::new();
                probs.insert(NO_RELATION.into(), p_yes);
                hits[pred.sent_idx].push(hit(
                    &pred.src,
                    &pred.tgt,
                    NO_RELATION,
                    &pred.rel_id,
                    sentence,
                    band,
                    p_yes,
                    probs,
                    None,
                    false,
                ));
            }
        }
    }
    Ok((hits, truncated))
}

#[cfg(test)]
mod tests {
    use super::require_closed_choice;
    use super::{entity_noul_instructions, is_prompt_too_long, pack_ranges};
    use crate::error::{Error, SystemOneError};
    use crate::types::{ChoiceAnswer, Mention, MentionSource, Sentence};
    use serde_json::Map;

    #[test]
    fn choice_outside_the_listed_labels_fails_closed() {
        let question = serde_json::json!({
            "type": "choice",
            "criteria": {"PERSON": "a person", "ORGANIZATION": "a group"}
        });
        let ans = ChoiceAnswer {
            kind: "choice".into(),
            choice: "PLACE".into(),
            probabilities: [("PLACE".into(), 1.0)].into_iter().collect(),
            confidence: Some(0.9),
        };
        let err = require_closed_choice(&ans, &question).unwrap_err();
        assert!(err.to_string().contains("outside the labels"));
    }

    #[test]
    fn prompt_too_long_detects_tev1_cap() {
        let err = Error::SystemOne(SystemOneError::new(
            r#"http 400 Bad Request: {"error":"prompt 0 has 3532 tokens; expected 1–2050 (input is never truncated)"}"#,
        ));
        assert!(is_prompt_too_long(&err));
        let other = Error::SystemOne(SystemOneError::new("http 500: boom"));
        assert!(!is_prompt_too_long(&other));
    }

    #[test]
    fn pack_ranges_respects_token_budget() {
        let items: Vec<u8> = (0..10).collect();
        let ranges = pack_ranges(&items, 64, 200, |batch| {
            let mut qs = Map::new();
            for (i, _) in batch.iter().enumerate() {
                qs.insert(format!("q{i}"), serde_json::json!({"type":"noul","instructions":"x".repeat(40)}));
            }
            ("state".into(), qs)
        });
        assert!(ranges.len() > 1, "budget should split the batch, got {ranges:?}");
        assert_eq!(ranges[0].0, 0);
        assert_eq!(ranges.last().unwrap().1, 10);
    }

    #[test]
    fn every_question_quotes_its_sentence() {
        let sent = Sentence {
            id: "s".into(),
            text: "Jane Doe joined Acme Inc in Berlin.".into(),
            start: 0,
            end: 35,
            heading_path: vec![],
            index: 0,
        };
        let mention = Mention {
            text: "Jane Doe".into(),
            start: 0,
            end: 8,
            sentence_id: "s".into(),
            heading_path: vec![],
            source: MentionSource::Gazetteer,
            skipped_reason: None,
        };
        let q = entity_noul_instructions(&sent, &mention);
        assert!(q.contains("In sentence"));
        assert!(q.contains("Berlin"));
        assert!(q.contains("Jane Doe"));
    }
}
