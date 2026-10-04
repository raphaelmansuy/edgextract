//! Canonical entity names, copied in spirit from EdgeQuake EntityId.

use regex::Regex;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

fn articles() -> &'static std::collections::HashSet<&'static str> {
    static ARTICLES: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
    ARTICLES.get_or_init(|| ["a", "an", "the"].into_iter().collect())
}

fn opaque() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|\d+)$",
        )
        .expect("opaque")
    })
}

fn non_alnum() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"[^0-9a-z]+").expect("non_alnum"))
}

fn possessive() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| Regex::new(r"(?i)'s\b").expect("possessive"))
}

/// NFC, drop articles and possessives, UPPERCASE_UNDERSCORE. Empty if opaque.
pub fn normalize_entity_name(raw: &str) -> String {
    let text: String = raw.trim().nfc().collect();
    if text.is_empty() {
        return String::new();
    }
    let text = possessive().replace_all(&text, "");
    let lowered = text.to_lowercase();
    let compact = lowered.replace(' ', "");
    if opaque().is_match(&compact) {
        return String::new();
    }
    let tokens: Vec<&str> = non_alnum()
        .split(&lowered)
        .filter(|t| !t.is_empty() && !articles().contains(t))
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    let joined = tokens.join("_");
    if opaque().is_match(&joined) {
        return String::new();
    }
    joined.to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::normalize_entity_name;

    #[test]
    fn basic() {
        assert_eq!(normalize_entity_name("Jane Doe"), "JANE_DOE");
        assert_eq!(normalize_entity_name("the Apache AGE"), "APACHE_AGE");
        assert_eq!(normalize_entity_name("Acme Inc."), "ACME_INC");
    }

    #[test]
    fn opaque_and_empty() {
        assert_eq!(normalize_entity_name(""), "");
        assert_eq!(normalize_entity_name("42"), "");
        assert_eq!(
            normalize_entity_name("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ""
        );
    }
}
