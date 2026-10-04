//! Propose mention spans. The decision model never finds spans on its own.

use crate::ontology::Ontology;
use crate::types::{Mention, MentionSource, Sentence};
use regex::Regex;
use std::sync::OnceLock;

const PRONOUNS: &[&str] = &[
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his", "she", "her", "hers",
    "it", "its", "they", "them", "their", "this", "that", "these", "those",
];

fn pronoun_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| {
        let mut words: Vec<&str> = PRONOUNS.to_vec();
        words.sort_by_key(|w| std::cmp::Reverse(w.len()));
        Regex::new(&format!(r"(?i)\b({})\b", words.join("|"))).expect("pronouns")
    })
}

fn bold_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"\*\*([^*]+)\*\*|__([^_]+)__").expect("bold"))
}

fn link_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").expect("link"))
}

fn code_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"`([^`]+)`").expect("code"))
}

fn is_pronoun(text: &str) -> bool {
    PRONOUNS.contains(&text.to_lowercase().as_str())
}

pub trait Proposer: Send + Sync {
    fn name(&self) -> &str;
    fn propose(&self, sentence: &Sentence, ontology: &Ontology) -> Vec<Mention>;
}

pub struct GazetteerProposer;

impl Proposer for GazetteerProposer {
    fn name(&self) -> &str {
        "gazetteer"
    }

    fn propose(&self, sentence: &Sentence, ontology: &Ontology) -> Vec<Mention> {
        let mut mentions = Vec::new();
        let text = &sentence.text;
        let lowered = text.to_lowercase();
        let mut names: Vec<&String> = ontology.gazetteer.keys().collect();
        names.sort_by_key(|n| std::cmp::Reverse(n.len()));
        let mut occupied: Vec<(usize, usize)> = Vec::new();
        for name in names {
            let needle = name.to_lowercase();
            let mut start = 0;
            while let Some(rel) = lowered[start..].find(&needle) {
                let i = start + rel;
                let j = i + needle.len();
                if inside(i, j, &occupied) {
                    start = i + 1;
                    continue;
                }
                if !token_boundary(text, i, j) {
                    start = i + 1;
                    continue;
                }
                occupied.push((i, j));
                mentions.push(mention(sentence, &text[i..j], i, j, MentionSource::Gazetteer));
                start = j;
            }
        }
        mentions
    }
}

pub struct MarkdownCueProposer;

impl Proposer for MarkdownCueProposer {
    fn name(&self) -> &str {
        "markdown"
    }

    fn propose(&self, sentence: &Sentence, _ontology: &Ontology) -> Vec<Mention> {
        let mut mentions = Vec::new();
        let text = &sentence.text;
        for rx in [bold_rx(), link_rx(), code_rx()] {
            for m in rx.captures_iter(text) {
                let full = m.get(0).unwrap();
                let span = m
                    .iter()
                    .skip(1)
                    .flatten()
                    .next()
                    .map(|g| g.as_str())
                    .unwrap_or("");
                if span.is_empty() {
                    continue;
                }
                let inner_off = full.as_str().find(span).unwrap_or(0);
                let inner_start = full.start() + inner_off;
                let inner_end = inner_start + span.len();
                mentions.push(mention(
                    sentence,
                    span,
                    inner_start,
                    inner_end,
                    MentionSource::Markdown,
                ));
            }
        }
        mentions
    }
}

/// Words that are capitalized only because they open a sentence, or that are never names.
const NOT_NAME_WORDS: &[&str] = &[
    "a", "an", "the", "this", "that", "these", "those", "it", "its", "they", "them", "their", "he",
    "she", "his", "her", "we", "our", "you", "your", "i", "in", "on", "at", "of", "for", "to",
    "from", "by", "with", "and", "or", "but", "if", "as", "is", "are", "was", "were", "be", "been",
    "being", "after", "before", "when", "while", "then", "there", "here", "also", "however",
    "though", "although", "because", "since", "until", "not", "no", "yes", "all", "any", "some",
    "each", "every", "both", "many", "most", "other", "another", "such", "what", "which", "who",
    "whom", "one", "two", "three", "first", "second", "third", "new", "old", "more", "less",
    "last", "next", "today", "yesterday", "tomorrow", "january", "february", "march", "april",
    "may", "june", "july", "august", "september", "october", "november", "december", "monday",
    "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "figure", "table",
    "section", "abstract", "introduction", "conclusion", "furthermore", "moreover", "finally",
    "specifically", "additionally", "overall", "instead", "thus", "therefore", "while", "during",
];

/// Lowercase words that may sit inside a name: "Bank of America", "Ludwig van Beethoven".
const NAME_CONNECTORS: &[&str] = &["of", "de", "van", "von", "da", "del"];

fn shape_token_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| {
        Regex::new(r"\p{Lu}[\p{L}\p{N}'’\-]*|\p{Ll}+|\p{N}+").expect("shape tokens")
    })
}

/// Proposes capitalized runs ("Brown University", "Battle of Waterloo", "GPT-4") as
/// *candidates only*. It decides nothing: every span it proposes is still put to the
/// decision model as a closed yes/no question ("is this a named entity?"), then typed.
/// This is what lets a document whose names are not on any list be read at all.
pub struct ShapeProposer;

impl Proposer for ShapeProposer {
    fn name(&self) -> &str {
        "shape"
    }

    fn propose(&self, sentence: &Sentence, ontology: &Ontology) -> Vec<Mention> {
        let text = &sentence.text;
        let listed = GazetteerProposer.propose(sentence, ontology);
        let tokens: Vec<(usize, usize)> = shape_token_rx()
            .find_iter(text)
            .map(|m| (m.start(), m.end()))
            .collect();
        let is_cap = |t: (usize, usize)| text[t.0..t.1].chars().next().is_some_and(|c| c.is_uppercase());
        let plain_gap = |a: usize, b: usize| text[a..b].chars().all(|c| c == ' ' || c == '\t') && b > a;
        let mut out = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            if !is_cap(tokens[i]) {
                i += 1;
                continue;
            }
            let mut j = i;
            while j + 1 < tokens.len() {
                let next = tokens[j + 1];
                if !plain_gap(tokens[j].1, next.0) {
                    break;
                }
                if is_cap(next) {
                    j += 1;
                    continue;
                }
                let word = &text[next.0..next.1];
                if NAME_CONNECTORS.contains(&word) {
                    if let Some(&after) = tokens.get(j + 2) {
                        if is_cap(after) && plain_gap(next.1, after.0) {
                            j += 2;
                            continue;
                        }
                    }
                }
                break;
            }
            // A stop word is only capitalized because it opens the sentence: drop it.
            let mut first = i;
            while first <= j && NOT_NAME_WORDS.contains(&text[tokens[first].0..tokens[first].1].to_lowercase().as_str()) {
                first += 1;
            }
            if first <= j {
                let start = tokens[first].0;
                let mut end = tokens[j].1;
                for possessive in ["'s", "’s"] {
                    if text[start..end].ends_with(possessive) {
                        end -= possessive.len();
                    }
                }
                let surface = &text[start..end];
                let overlaps_listed = listed.iter().any(|g| {
                    let (a, b) = (g.start - sentence.start, g.end - sentence.start);
                    !(end <= a || start >= b)
                });
                if surface.chars().count() >= 2 && !overlaps_listed {
                    out.push(mention(sentence, surface, start, end, MentionSource::Shape));
                }
            }
            i = j + 1;
        }
        out
    }
}

pub struct PronounProposer;

impl Proposer for PronounProposer {
    fn name(&self) -> &str {
        "pronoun"
    }

    fn propose(&self, sentence: &Sentence, _ontology: &Ontology) -> Vec<Mention> {
        pronoun_rx()
            .find_iter(&sentence.text)
            .map(|m| {
                let mut mention = mention(
                    sentence,
                    m.as_str(),
                    m.start(),
                    m.end(),
                    MentionSource::Shape,
                );
                mention.skipped_reason = Some("pronoun".into());
                mention
            })
            .collect()
    }
}

pub(crate) fn mention(
    sentence: &Sentence,
    text: &str,
    local_start: usize,
    local_end: usize,
    source: MentionSource,
) -> Mention {
    let cleaned = text.trim();
    let skipped = if is_pronoun(cleaned) {
        Some("pronoun".into())
    } else {
        None
    };
    Mention {
        text: cleaned.to_string(),
        start: sentence.start + local_start,
        end: sentence.start + local_end,
        sentence_id: sentence.id.clone(),
        heading_path: sentence.heading_path.clone(),
        source,
        skipped_reason: skipped,
    }
}

fn token_boundary(text: &str, i: usize, j: usize) -> bool {
    let left_ok = i == 0
        || text
            .get(..i)
            .and_then(|s| s.chars().next_back())
            .map(|c| !c.is_alphanumeric())
            .unwrap_or(true);
    let right_ok = j >= text.len()
        || text
            .get(j..)
            .and_then(|s| s.chars().next())
            .map(|c| !c.is_alphanumeric())
            .unwrap_or(true);
    left_ok && right_ok
}

fn inside(i: usize, j: usize, occupied: &[(usize, usize)]) -> bool {
    occupied.iter().any(|&(a, b)| !(j <= a || i >= b))
}

/// Keep longest spans; drop nested/overlapping shorter ones. Stable by start.
pub fn merge_mentions(mentions: Vec<Mention>) -> Vec<Mention> {
    let mut ranked = mentions;
    ranked.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| (b.end - b.start).cmp(&(a.end - a.start)))
            .then_with(|| a.source.as_str().cmp(b.source.as_str()))
    });
    let mut kept: Vec<Mention> = Vec::new();
    for m in ranked {
        if m.skipped_reason.is_some() {
            kept.push(m);
            continue;
        }
        let m_len = m.end - m.start;
        if kept.iter().any(|k| {
            k.skipped_reason.is_none()
                && !(m.end <= k.start || m.start >= k.end)
                && (k.end - k.start) >= m_len
        }) {
            continue;
        }
        kept.retain(|k| {
            k.skipped_reason.is_some()
                || (m.end <= k.start || m.start >= k.end)
                || (k.end - k.start) > m_len
        });
        kept.push(m);
    }
    kept.sort_by_key(|m| (m.start, m.end));
    kept
}

pub fn default_proposers() -> Vec<Box<dyn Proposer>> {
    vec![
        Box::new(GazetteerProposer),
        Box::new(MarkdownCueProposer),
        Box::new(PronounProposer),
    ]
}

/// The default proposers plus [`ShapeProposer`], for text whose names no list knows.
pub fn discovering_proposers() -> Vec<Box<dyn Proposer>> {
    let mut all = default_proposers();
    all.push(Box::new(ShapeProposer));
    all
}

pub fn propose_mentions(
    sentence: &Sentence,
    ontology: &Ontology,
    proposers: &[Box<dyn Proposer>],
) -> Vec<Mention> {
    let mut raw = Vec::new();
    for p in proposers {
        raw.extend(p.propose(sentence, ontology));
    }
    merge_mentions(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::split_sentences;
    use crate::ontology::load_ontology_named;

    fn sent(text: &str) -> Sentence {
        split_sentences(text, "doc").into_iter().next().unwrap()
    }

    #[test]
    fn gazetteer_and_pronouns() {
        let ont = load_ontology_named("tech_docs").unwrap();
        let s = sent("She joined Acme Inc in Berlin.");
        let mentions = propose_mentions(&s, &ont, &default_proposers());
        let skipped: Vec<_> = mentions
            .iter()
            .filter(|m| m.skipped_reason.as_deref() == Some("pronoun"))
            .collect();
        let names: Vec<_> = mentions
            .iter()
            .filter(|m| m.skipped_reason.is_none())
            .map(|m| m.text.as_str())
            .collect();
        assert!(!skipped.is_empty());
        assert!(names.contains(&"Acme Inc"));
        assert!(names.contains(&"Berlin"));
    }

    #[test]
    fn longest_match_apache_age() {
        let ont = load_ontology_named("tech_docs").unwrap();
        let s = sent("The **Apache AGE** graph extension sits on PostgreSQL.");
        let mentions: Vec<_> = propose_mentions(&s, &ont, &default_proposers())
            .into_iter()
            .filter(|m| m.skipped_reason.is_none())
            .collect();
        let names: Vec<_> = mentions.iter().map(|m| m.text.as_str()).collect();
        assert!(names.iter().any(|n| n.contains("Apache AGE")));
        assert!(!names.contains(&"Apache"));
    }

    fn shape_names(text: &str, ontology: &str) -> Vec<String> {
        let ont = load_ontology_named(ontology).unwrap();
        propose_mentions(&sent(text), &ont, &discovering_proposers())
            .into_iter()
            .filter(|m| m.skipped_reason.is_none())
            .map(|m| m.text)
            .collect()
    }

    #[test]
    fn shapes_find_names_that_no_list_knows() {
        let names = shape_names(
            "Researchers at Adobe and Brown University studied the Battle of Waterloo with GPT-4.",
            "tech_docs",
        );
        for want in ["Adobe", "Brown University", "Battle of Waterloo", "GPT-4"] {
            assert!(names.iter().any(|n| n == want), "{want} missing from {names:?}");
        }
    }

    #[test]
    fn shapes_skip_sentence_openers_and_possessives() {
        let names = shape_names("However, Zorbex's engine is fast.", "tech_docs");
        assert_eq!(names, vec!["Zorbex"], "{names:?}");
    }

    #[test]
    fn shapes_leave_listed_names_to_the_list() {
        // "Acme Inc" and "Berlin" are listed; a shape run must not swallow them.
        let names = shape_names("Jane Doe Acme Inc Berlin", "company_news");
        assert!(names.iter().any(|n| n == "Acme Inc"), "{names:?}");
        assert!(names.iter().any(|n| n == "Berlin"), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("Acme Inc Berlin")), "{names:?}");
    }

    #[test]
    fn merge_keeps_longer() {
        let a = Mention {
            text: "Apache".into(),
            start: 0,
            end: 6,
            sentence_id: "s".into(),
            heading_path: vec![],
            source: MentionSource::Shape,
            skipped_reason: None,
        };
        let b = Mention {
            text: "Apache AGE".into(),
            start: 0,
            end: 10,
            sentence_id: "s".into(),
            heading_path: vec![],
            source: MentionSource::Gazetteer,
            skipped_reason: None,
        };
        let kept = merge_mentions(vec![a, b]);
        let names: Vec<_> = kept
            .iter()
            .filter(|m| m.skipped_reason.is_none())
            .map(|m| m.text.as_str())
            .collect();
        assert_eq!(names, vec!["Apache AGE"]);
    }
}
