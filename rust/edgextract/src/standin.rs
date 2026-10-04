//! A small, readable stand-in for a decision model.
//!
//! It answers the same closed questions the real host would (`choice` and `noul`),
//! using plain rules instead of a neural net: the ontology's own names, word
//! shapes, and the words inside each relation id (`INVESTED_IN` looks for
//! "invested ... in" between the two names). It exists so the whole pipeline can
//! run with no server and no model: in a browser tab, in a demo, in a test.
//!
//! It is deliberately modest. A hedge ("might") or a missing preposition gets a
//! middling probability, which the gate then sends to review. That is the point
//! of the demo: the cutoff, not the model, decides what enters the graph.

use crate::ontology::{Ontology, NOT_ENTITY};
use crate::testing::HandlerFn;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const PREPOSITIONS: &[&str] = &[
    "in", "for", "at", "of", "to", "by", "with", "on", "from", "as", "into", "under",
];

/// The context window of the host this double stands in for (tev1).
pub const CONTEXT_TOKENS: usize = 2050;

const QUOTED: &str = r"'((?:[^'\\]|\\.)*)'";

struct Patterns {
    relation: Regex,
    mention: Regex,
    sentence: Regex,
    negation: Regex,
    hedge: Regex,
    passive: Regex,
    by: Regex,
}

impl Patterns {
    fn new() -> Self {
        Self {
            relation: Regex::new(&format!(
                r"^In sentence \({QUOTED}\): Does (\w+) hold from {QUOTED} to {QUOTED}\?"
            ))
            .unwrap(),
            mention: Regex::new(&format!(r"mention \({QUOTED}\)")).unwrap(),
            sentence: Regex::new(&format!(r"^In sentence \({QUOTED}\)")).unwrap(),
            negation: Regex::new(r"(?i)\b(not|never|cannot|without|no longer)\b|n't").unwrap(),
            hedge: Regex::new(
                r"(?i)\b(might|could|may|perhaps|maybe|reportedly|allegedly|possibly|probably|rumou?red|considering|plans? to|plan to)\b",
            )
            .unwrap(),
            passive: Regex::new(r"(?i)\b(was|were|is|are|been|being|be)\b").unwrap(),
            by: Regex::new(r"(?i)\bby\b").unwrap(),
        }
    }
}

/// Words a relation id asks for, as regexes that tolerate simple inflections.
struct Cue {
    content: Vec<Regex>,
    prep: Option<Regex>,
    /// `CREATED_BY`-style ids name the patient first ("X was created by Y").
    by_form: bool,
}

fn forms(word: &str) -> Vec<String> {
    let mut bases: Vec<String> = vec![word.to_string()];
    for suffix in ["ed", "es", "d", "s", "ing"] {
        if let Some(stem) = word.strip_suffix(suffix) {
            if stem.len() >= 3 {
                bases.push(stem.to_string());
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    for b in &bases {
        let no_e = b.strip_suffix('e').unwrap_or(b);
        for f in [
            b.clone(),
            format!("{b}s"),
            format!("{b}es"),
            format!("{b}d"),
            format!("{b}ed"),
            format!("{b}ing"),
            format!("{no_e}ing"),
        ] {
            if !out.contains(&f) {
                out.push(f);
            }
        }
    }
    out
}

fn build_cue(rel_id: &str) -> Cue {
    let words: Vec<String> = rel_id
        .to_lowercase()
        .split('_')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect();
    let last = words.last().cloned().unwrap_or_default();
    let by_form = words.len() > 1 && last == "by";
    let prep = if words.len() > 1 && last != "by" && PREPOSITIONS.contains(&last.as_str()) {
        Regex::new(&format!(r"(?i)\b{}\b", regex::escape(&last))).ok()
    } else {
        None
    };
    let mut content_words: Vec<&String> = words
        .iter()
        .filter(|w| !PREPOSITIONS.contains(&w.as_str()))
        .collect();
    if content_words.is_empty() {
        content_words = words.iter().collect();
    }
    let content = content_words
        .iter()
        .filter_map(|w| {
            let alt = forms(w).iter().map(|f| regex::escape(f)).collect::<Vec<_>>().join("|");
            Regex::new(&format!(r"(?i)\b({alt})\b")).ok()
        })
        .collect();
    Cue {
        content,
        prep,
        by_form,
    }
}

fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                out.push(n);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Closest pair of occurrences of `a` and `b`, as `(a_start, a_end, b_start, b_end)`.
fn closest_pair(sentence: &str, a: &str, b: &str) -> Option<(usize, usize, usize, usize)> {
    let find_all = |needle: &str| -> Vec<(usize, usize)> {
        if needle.is_empty() {
            return Vec::new();
        }
        let hay = sentence.to_lowercase();
        let n = needle.to_lowercase();
        // Lowercasing can change byte length for a few scripts; fall back to exact match.
        if hay.len() != sentence.len() {
            return sentence
                .match_indices(needle)
                .map(|(i, m)| (i, i + m.len()))
                .collect();
        }
        hay.match_indices(&n).map(|(i, m)| (i, i + m.len())).collect()
    };
    let mut best: Option<(usize, usize, usize, usize, usize)> = None;
    for (as_, ae) in find_all(a) {
        for (bs, be) in find_all(b) {
            if as_ < be && bs < ae {
                continue; // overlap
            }
            let gap = if ae <= bs { bs - ae } else { as_ - be };
            if best.map(|x| gap < x.4).unwrap_or(true) {
                best = Some((as_, ae, bs, be, gap));
            }
        }
    }
    best.map(|(a0, a1, b0, b1, _)| (a0, a1, b0, b1))
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

struct Rules {
    gazetteer: HashMap<String, String>,
    /// `(type id, lowercase hint words)` from ids and aliases.
    hints: Vec<(String, Vec<String>)>,
    patterns: Patterns,
    cues: Mutex<HashMap<String, Arc<Cue>>>,
}

impl Rules {
    fn new(ontologies: &[&Ontology]) -> Self {
        let mut hints: Vec<(String, Vec<String>)> = Vec::new();
        let mut gazetteer = HashMap::new();
        for ontology in ontologies {
            for t in &ontology.types {
                if hints.iter().any(|(id, _)| id == &t.id) {
                    continue;
                }
                let mut words = vec![t.id.to_lowercase().replace('_', " ")];
                words.extend(t.aliases.iter().map(|a| a.to_lowercase()));
                hints.push((t.id.clone(), words));
            }
            for (k, v) in &ontology.gazetteer {
                gazetteer.entry(k.trim().to_string()).or_insert_with(|| v.clone());
            }
        }
        Self {
            gazetteer,
            hints,
            patterns: Patterns::new(),
            cues: Mutex::new(HashMap::new()),
        }
    }

    fn cue(&self, rel_id: &str) -> Arc<Cue> {
        let mut cues = self.cues.lock().expect("cue cache");
        cues.entry(rel_id.to_string())
            .or_insert_with(|| Arc::new(build_cue(rel_id)))
            .clone()
    }

    fn quoted(&self, rx: &Regex, text: &str) -> Option<String> {
        rx.captures(text)
            .and_then(|c| c.get(1))
            .map(|m| unescape(m.as_str()))
    }

    fn answer(&self, qid: &str, q: &Value) -> Result<Value, String> {
        let kind = q.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let instructions = q.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "noul" => Ok(json!({"type": "noul", "noul": self.noul(instructions)})),
            "choice" => {
                let criteria = q
                    .get("criteria")
                    .and_then(|v| v.as_object())
                    .ok_or_else(|| format!("{qid}: choice without criteria"))?;
                Ok(self.choice(instructions, criteria))
            }
            "score" => Ok(json!({"type": "score", "score": 0.5})),
            other => Err(format!("bad type {other}")),
        }
    }

    fn noul(&self, instructions: &str) -> f64 {
        if let Some(c) = self.patterns.relation.captures(instructions) {
            let sentence = unescape(&c[1]);
            let rel_id = c[2].to_string();
            return round2(self.relation_probability(&sentence, &rel_id, &unescape(&c[3]), &unescape(&c[4])));
        }
        if let Some(mention) = self.quoted(&self.patterns.mention, instructions) {
            let sentence = self.quoted(&self.patterns.sentence, instructions).unwrap_or_default();
            return self.is_name_in(&mention, &sentence);
        }
        0.5
    }

    fn relation_probability(&self, sentence: &str, rel_id: &str, src: &str, tgt: &str) -> f64 {
        let cue = self.cue(rel_id);
        let Some((a0, a1, b0, b1)) = closest_pair(sentence, src, tgt) else {
            return 0.03;
        };
        let src_left = a0 < b0;
        let (seg_start, seg_end) = if src_left { (a1, b0) } else { (b1, a0) };
        let segment = &sentence[seg_start.min(seg_end)..seg_end.max(seg_start)];
        let hit = |hay: &str| !cue.content.is_empty() && cue.content.iter().all(|rx| rx.is_match(hay));
        if !hit(segment) {
            return if hit(sentence) { 0.45 } else { 0.03 };
        }
        let p = &self.patterns;
        if p.negation.is_match(segment) {
            return 0.04;
        }
        let passive = p.passive.is_match(segment) && p.by.is_match(segment);
        let agent_is_left = !passive;
        let src_is_agent = src_left == agent_is_left;
        let holds = if cue.by_form { !src_is_agent } else { src_is_agent };
        if !holds {
            return 0.08;
        }
        if p.hedge.is_match(segment) {
            return 0.5;
        }
        if let Some(prep) = &cue.prep {
            if !prep.is_match(segment) {
                return 0.62;
            }
        }
        let words_between = segment.split_whitespace().count();
        if words_between > 10 {
            return 0.6;
        }
        0.97 - 0.01 * words_between.min(8) as f64
    }

    #[cfg(test)]
    fn is_name(&self, mention: &str) -> f64 {
        self.is_name_in(mention, "")
    }

    fn is_name_in(&self, mention: &str, sentence: &str) -> f64 {
        if self.gazetteer.contains_key(mention.trim()) {
            return 0.95;
        }
        // One plain capitalized word that merely opens the sentence ("Names inside fences...")
        // is far more often a capitalized common word than a name.
        let single = !mention.contains(' ') && !mention.chars().skip(1).any(|c| c.is_uppercase() || c.is_ascii_digit());
        if single && !sentence.is_empty() && sentence.trim_start_matches(['#', '*', '_', ' ']).starts_with(mention) {
            return 0.15;
        }
        let has_upper = mention.chars().any(|c| c.is_uppercase());
        let has_digit = mention.chars().any(|c| c.is_ascii_digit());
        let alpha_only = mention.chars().all(|c| c.is_alphabetic() || c == ' ');
        let starts_upper = mention.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);
        let inner_upper = mention.chars().skip(1).any(|c| c.is_uppercase());
        if starts_upper || inner_upper || has_digit {
            0.88
        } else if alpha_only && !has_upper {
            0.15
        } else {
            0.5
        }
    }

    fn choice(&self, instructions: &str, criteria: &Map<String, Value>) -> Value {
        let keys: Vec<String> = criteria.keys().cloned().collect();
        let mention = self
            .quoted(&self.patterns.mention, instructions)
            .unwrap_or_default();
        let sentence = self
            .quoted(&self.patterns.sentence, instructions)
            .unwrap_or_default()
            .to_lowercase();
        let usable = |k: &String| criteria.contains_key(k) && k != NOT_ENTITY && !k.starts_with("GROUP_");
        if let Some(declared) = self.gazetteer.get(mention.trim()) {
            if usable(declared) {
                return dist(declared, &keys, 0.92);
            }
        }
        for (type_id, words) in &self.hints {
            if !usable(type_id) {
                continue;
            }
            let found = words.iter().any(|w| {
                Regex::new(&format!(r"\b{}s?\b", regex::escape(w)))
                    .map(|rx| rx.is_match(&sentence))
                    .unwrap_or(false)
            });
            if found {
                return dist(type_id, &keys, 0.62);
            }
        }
        let first = keys.iter().find(|k| usable(k)).cloned();
        match first {
            Some(k) => dist(&k, &keys, 0.5),
            None => dist(keys.first().map(|s| s.as_str()).unwrap_or(NOT_ENTITY), &keys, 0.5),
        }
    }
}

fn dist(winner: &str, keys: &[String], p_win: f64) -> Value {
    let rest: Vec<&String> = keys.iter().filter(|k| k.as_str() != winner).collect();
    let share = if rest.is_empty() {
        0.0
    } else {
        (1.0 - p_win) / rest.len() as f64
    };
    let mut probs = Map::new();
    for k in keys {
        let v = if k == winner { p_win } else { share };
        probs.insert(
            k.clone(),
            serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::from(0)),
        );
    }
    // Absorb rounding drift so the probabilities sum to 1.
    let total: f64 = probs.values().filter_map(|v| v.as_f64()).sum();
    if let Some(v) = probs.get_mut(winner) {
        let fixed = v.as_f64().unwrap_or(p_win) + (1.0 - total);
        *v = serde_json::Number::from_f64(fixed).map(Value::Number).unwrap_or(Value::from(0));
    }
    json!({
        "type": "choice",
        "choice": winner,
        "probabilities": probs,
        "confidence": p_win,
    })
}

/// A handler for `POST /v1/systemone` bodies, backed by plain rules.
pub fn rule_handler(ontology: &Ontology) -> HandlerFn {
    rule_handler_for(&[ontology])
}

/// One handler that knows several ontologies at once (names and kinds are pooled).
/// A test host uses this so a single server can answer for whichever ontology a page sends.
pub fn rule_handler_for(ontologies: &[&Ontology]) -> HandlerFn {
    let rules = Arc::new(Rules::new(ontologies));
    Arc::new(move |body: Value| {
        // Like the real host: a prompt over the context window is refused, never truncated.
        // Three characters a token is a little harsher than prose, so a page that survives
        // this double has headroom against the real model.
        let tokens = body.to_string().len() / 3;
        if tokens > CONTEXT_TOKENS {
            return Err(format!(
                "prompt 0 has {tokens} tokens; expected 1-{CONTEXT_TOKENS} (input is never truncated)"
            ));
        }
        let questions = body
            .get("questions")
            .and_then(|v| v.as_object())
            .ok_or_else(|| "questions must be an object".to_string())?;
        let mut answers = Map::new();
        let mut input_chars = body.get("state").map(|s| s.to_string().len()).unwrap_or(0);
        for (qid, q) in questions {
            input_chars += q.to_string().len();
            answers.insert(qid.clone(), rules.answer(qid, q)?);
        }
        Ok(json!({
            "model": body.get("model").and_then(|v| v.as_str()).unwrap_or("rule-model"),
            "answers": answers,
            "usage": {"input_tokens": input_chars / 4, "output_tokens": questions.len()},
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ontology::load_ontology_named;

    fn rules() -> Rules {
        Rules::new(&[&load_ontology_named("company_news").unwrap()])
    }

    fn p(sentence: &str, rel: &str, a: &str, b: &str) -> f64 {
        rules().relation_probability(sentence, rel, a, b)
    }

    #[test]
    fn active_sentence_holds_in_stated_direction_only() {
        let s = "Acme Inc invested in Northwind.";
        assert!(p(s, "INVESTED_IN", "Acme Inc", "Northwind") > 0.9);
        assert!(p(s, "INVESTED_IN", "Northwind", "Acme Inc") < 0.2);
    }

    #[test]
    fn a_relation_the_sentence_does_not_state_is_no() {
        let s = "Acme Inc invested in Northwind.";
        assert!(p(s, "ACQUIRED", "Acme Inc", "Northwind") < 0.1);
    }

    #[test]
    fn passive_voice_flips_direction() {
        let s = "Northwind was acquired by Acme Inc.";
        assert!(p(s, "ACQUIRED", "Acme Inc", "Northwind") > 0.9);
        assert!(p(s, "ACQUIRED", "Northwind", "Acme Inc") < 0.2);
    }

    #[test]
    fn by_form_relation_names_the_patient_first() {
        let r = Rules::new(&[&load_ontology_named("tech_docs").unwrap()]);
        let s = "EdgeQuake was created by Acme Inc.";
        assert!(r.relation_probability(s, "CREATED_BY", "EdgeQuake", "Acme Inc") > 0.9);
        assert!(r.relation_probability(s, "CREATED_BY", "Acme Inc", "EdgeQuake") < 0.2);
        let active = "Acme Inc created EdgeQuake.";
        assert!(r.relation_probability(active, "CREATED_BY", "EdgeQuake", "Acme Inc") > 0.9);
    }

    #[test]
    fn negation_is_no_and_hedging_goes_to_review() {
        assert!(p("Acme Inc did not acquire Northwind.", "ACQUIRED", "Acme Inc", "Northwind") < 0.2);
        let hedged = p("Acme Inc might acquire Northwind.", "ACQUIRED", "Acme Inc", "Northwind");
        assert!((0.2..0.8).contains(&hedged), "hedged={hedged}");
    }

    #[test]
    fn missing_preposition_is_unsure() {
        let v = p("Jane Doe works at Acme Inc.", "WORKS_FOR", "Jane Doe", "Acme Inc");
        assert!((0.2..0.8).contains(&v), "v={v}");
    }

    #[test]
    fn quotes_in_sentences_survive_the_question_format() {
        let h = rule_handler(&load_ontology_named("company_news").unwrap());
        let body = json!({
            "model": "m",
            "state": "x",
            "questions": {"n0": {
                "type": "noul",
                "instructions": "In sentence ('Acme Inc invested in Northwind\\'s lab.'): Does INVESTED_IN hold from 'Acme Inc' to 'Northwind'? d",
            }},
        });
        let out = h(body).unwrap();
        assert!(out["answers"]["n0"]["noul"].as_f64().unwrap() > 0.8);
    }

    #[test]
    fn a_listed_name_must_match_its_spelling() {
        let r = Rules::new(&[&load_ontology_named("tech_docs").unwrap()]);
        assert!(r.is_name("Markdown") > 0.9);
        // "markdown" in running prose is the common word, not the listed product.
        assert!(r.is_name("markdown") < 0.2);
    }

    #[test]
    fn a_plain_word_that_only_opens_a_sentence_is_not_a_name() {
        let r = rules();
        assert!(r.is_name_in("Names", "Names inside fences are examples.") < 0.2);
        assert!(r.is_name_in("Zorbex", "Acme Inc backed Zorbex.") > 0.8);
        assert!(r.is_name_in("Acme Inc", "Acme Inc backed Zorbex.") > 0.8);
    }

    #[test]
    fn plain_lowercase_words_are_not_names() {
        let r = rules();
        assert!(r.is_name("important") < 0.2);
        assert!(r.is_name("Orion") > 0.8);
        assert!(r.is_name("Ada Lovelace") > 0.9);
    }
}
