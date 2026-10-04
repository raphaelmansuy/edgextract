use edgextract::systemone::{build_choice_question, SystemOneClient};
use indexmap::IndexMap;

/// Talks to a local Ollama at localhost:11434. Ignored by default.
#[test]
#[ignore]
fn live_systemone_choice() {
    let client = SystemOneClient::new("nimble", "http://localhost:11434", 60.0);
    let mut criteria = IndexMap::new();
    criteria.insert("billing".into(), "Payments and refunds".into());
    criteria.insert("bug".into(), "Software errors".into());
    criteria.insert("account".into(), "Login and account access".into());
    let q = build_choice_question("Which label fits this ticket?", &criteria).unwrap();
    let mut questions = serde_json::Map::new();
    questions.insert("label".into(), q);
    let resp = client
        .decide_str("Our checkout has returned 500 errors since 9am.", &questions)
        .expect("live Ollama POST /v1/systemone");
    assert!(resp.answers.contains_key("label"));
    assert_eq!(
        resp.answers["label"]["type"].as_str(),
        Some("choice")
    );
}
