use clap::{Parser, Subcommand};
use edgextract::benchmarks::load_converted_json;
use edgextract::cache::DecisionCache;
use edgextract::candidates::{GazetteerProposer, Proposer};
use edgextract::decisions::{DEFAULT_MAX_PROMPT_TOKENS, DEFAULT_MAX_QUESTIONS};
use edgextract::eval::{micro_average, score_result, score_spans};
use edgextract::ontology::{
    describe_ontology, load_ontology_named, write_starter_ontology,
};
use edgextract::pipeline::Extractor;
use edgextract::span_encoder::EncoderProposer;
use edgextract::systemone::{SystemOneClient, DEFAULT_BASE_URL};
use edgextract::types::Sentence;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

const DEFAULT_ENCODER_MODEL: &str = "fastino/gliner2.5-base-v1";

#[derive(Parser)]
#[command(
    name = "edgextract",
    about = "Extract a knowledge graph from text using an ontology and a decision model."
)]
struct Cli {
    #[arg(long, default_value = DEFAULT_BASE_URL)]
    base_url: String,
    #[arg(long, default_value = "nimble")]
    model: String,
    #[arg(long, default_value_t = 60.0)]
    timeout: f64,
    #[command(subcommand)]
    cmd: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the pipeline on a markdown file
    Extract {
        markdown: PathBuf,
        #[arg(long, default_value = "tech_docs")]
        ontology: String,
        #[arg(long, default_value = "-")]
        out: String,
        #[arg(long, default_value = ".edgextract-cache/decisions.sqlite")]
        cache: PathBuf,
        #[arg(long)]
        document_id: Option<String>,
        /// Closed questions packed into each POST /v1/systemone (one model step).
        #[arg(long, default_value_t = DEFAULT_MAX_QUESTIONS)]
        max_questions: usize,
        /// Estimated prompt token budget per SystemOne POST (tev1 cap is 2050).
        #[arg(long, default_value_t = DEFAULT_MAX_PROMPT_TOKENS)]
        max_prompt_tokens: usize,
        /// Add a GLiNER span proposer (does not type entities).
        #[arg(long)]
        encoder: bool,
        #[arg(long, default_value = DEFAULT_ENCODER_MODEL)]
        encoder_model: String,
        #[arg(long, default_value_t = 0.5)]
        encoder_threshold: f64,
    },
    /// Write a starter ontology YAML
    InitOntology { path: PathBuf },
    /// Load an ontology and print its legal links
    ValidateOntology { path: String },
    /// Score markdown against golden JSON. Needs a decision model.
    Eval {
        golden_dir: PathBuf,
        #[arg(long)]
        docs_dir: PathBuf,
        #[arg(long, default_value = "tech_docs")]
        ontology: String,
        #[arg(long, default_value = ".edgextract-cache/decisions.sqlite")]
        cache: PathBuf,
        #[arg(long, default_value_t = DEFAULT_MAX_QUESTIONS)]
        max_questions: usize,
        #[arg(long, default_value_t = DEFAULT_MAX_PROMPT_TOKENS)]
        max_prompt_tokens: usize,
        #[arg(long)]
        encoder: bool,
        #[arg(long, default_value = DEFAULT_ENCODER_MODEL)]
        encoder_model: String,
        #[arg(long, default_value_t = 0.5)]
        encoder_threshold: f64,
    },
    /// Score a CoNLL04 JSON split (raw SpERT or converted) with gazetteer + encoder.
    EvalBenchmark {
        split_json: PathBuf,
        #[arg(long, default_value = "conll04")]
        ontology: String,
        #[arg(long, default_value = ".edgextract-cache/decisions.sqlite")]
        cache: PathBuf,
        #[arg(long)]
        limit: Option<usize>,
        #[arg(long, default_value_t = DEFAULT_MAX_QUESTIONS)]
        max_questions: usize,
        #[arg(long, default_value_t = DEFAULT_MAX_PROMPT_TOKENS)]
        max_prompt_tokens: usize,
        #[arg(long, default_value = DEFAULT_ENCODER_MODEL)]
        encoder_model: String,
        #[arg(long, default_value_t = 0.30)]
        encoder_threshold: f64,
    },
    /// Serve a rule-based test double for POST /v1/systemone (no model needed; CORS on).
    /// For tests and offline development only: it is not a decision model.
    ServeStandin {
        /// Bundled ontologies whose names and kinds the double should know (repeatable).
        #[arg(long = "ontology", default_values_t = vec!["tech_docs".to_string()])]
        ontology: Vec<String>,
        /// Ontology YAML files to add (repeatable).
        #[arg(long = "ontology-file", num_args = 1..)]
        ontology_file: Vec<PathBuf>,
        #[arg(long, default_value = "127.0.0.1:11435")]
        addr: String,
        /// Sleep this long before every answer, to stand in for a model that takes time.
        #[arg(long, default_value_t = 0)]
        delay_ms: u64,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.cmd {
        Commands::ServeStandin { ontology, ontology_file, addr, delay_ms } => {
            let mut known = Vec::new();
            for name in &ontology {
                known.push(load_ontology_named(name)?);
            }
            for path in &ontology_file {
                known.push(edgextract::ontology::ontology_from_yaml(&std::fs::read_to_string(path)?)?);
            }
            let refs: Vec<&_> = known.iter().collect();
            let inner = edgextract::standin::rule_handler_for(&refs);
            let handler: edgextract::testing::HandlerFn = if delay_ms == 0 {
                inner
            } else {
                Arc::new(move |body| {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    inner(body)
                })
            };
            let server = edgextract::testing::start_fake_systemone_at(&addr, handler);
            println!(
                "rule-based TEST DOUBLE (not a model) for {} ontologies listening on {}",
                known.len(),
                server.base_url
            );
            loop {
                std::thread::park();
            }
        }
        Commands::Extract {
            markdown,
            ontology,
            out,
            cache,
            document_id,
            max_questions,
            max_prompt_tokens,
            encoder,
            encoder_model,
            encoder_threshold,
        } => {
            let text = fs::read_to_string(&markdown)?;
            let ont = load_ontology_named(&ontology)?;
            let client = SystemOneClient::new(&cli.model, &cli.base_url, cli.timeout);
            let cache = DecisionCache::open(&cache)?;
            let mut extractor = Extractor::new(ont, client)
                .with_cache(cache)
                .with_max_questions(max_questions)
                .with_max_prompt_tokens(max_prompt_tokens);
            if encoder {
                extractor = with_default_plus_encoder(extractor, &encoder_model, encoder_threshold)?;
            }
            let doc_id = document_id.unwrap_or_else(|| {
                markdown
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("doc")
                    .to_string()
            });
            let result = extractor.extract_markdown(&text, &doc_id)?;
            let dumped = serde_json::to_string_pretty(&result)?;
            if out == "-" {
                println!("{dumped}");
            } else {
                if let Some(parent) = Path::new(&out).parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&out, dumped)?;
            }
        }
        Commands::InitOntology { path } => {
            let written = write_starter_ontology(&path)?;
            println!("wrote {}", written.display());
            println!(
                "Edit the kinds and links, then run: edgextract validate-ontology {}",
                written.display()
            );
        }
        Commands::ValidateOntology { path } => {
            let ont = load_ontology_named(&path)?;
            let info = describe_ontology(&ont);
            println!(
                "{} ({})",
                info.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                info.get("id").and_then(|v| v.as_str()).unwrap_or("")
            );
            println!("Kinds of name:");
            if let Some(types) = info.get("types").and_then(|v| v.as_array()) {
                for item in types {
                    println!(
                        "  {}: {}",
                        item.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        item.get("description").and_then(|v| v.as_str()).unwrap_or("")
                    );
                }
            }
            println!("Links:");
            if let Some(rels) = info.get("relations").and_then(|v| v.as_array()) {
                for item in rels {
                    println!(
                        "  {}: {}",
                        item.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        item.get("description").and_then(|v| v.as_str()).unwrap_or("")
                    );
                }
            }
            println!("Legal pairs:");
            if let Some(pairs) = info.get("legal_pairs").and_then(|v| v.as_array()) {
                for pair in pairs {
                    println!("  {}", pair.as_str().unwrap_or(""));
                }
            }
        }
        Commands::Eval {
            golden_dir,
            docs_dir,
            ontology,
            cache,
            max_questions,
            max_prompt_tokens,
            encoder,
            encoder_model,
            encoder_threshold,
        } => {
            let ont = load_ontology_named(&ontology)?;
            let client = SystemOneClient::new(&cli.model, &cli.base_url, cli.timeout);
            let cache = DecisionCache::open(&cache)?;
            let mut extractor = Extractor::new(ont, client)
                .with_cache(cache)
                .with_max_questions(max_questions)
                .with_max_prompt_tokens(max_prompt_tokens);
            if encoder {
                extractor = with_default_plus_encoder(extractor, &encoder_model, encoder_threshold)?;
            }
            let mut labels: Vec<_> = fs::read_dir(&golden_dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
                .collect();
            labels.sort();
            let mut entity_rows = Vec::new();
            let mut relation_rows = Vec::new();
            if labels.is_empty() {
                return Err("no golden JSON files".into());
            }
            for path in labels {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("doc");
                let md = docs_dir.join(format!("{stem}.md"));
                if !md.exists() {
                    eprintln!("missing {}", md.display());
                    continue;
                }
                let text = fs::read_to_string(&md)?;
                let gold: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
                let result = extractor.extract_markdown(&text, stem)?;
                let (ents, rels) = score_result(&result, &gold);
                println!(
                    "{stem} entities_f1={:.3} relations_f1={:.3}",
                    ents.f1, rels.f1
                );
                entity_rows.push(ents);
                relation_rows.push(rels);
            }
            let ents = micro_average(&entity_rows);
            let rels = micro_average(&relation_rows);
            println!(
                "micro entities_f1={:.3} relations_f1={:.3} gate_fitted=false",
                ents.f1, rels.f1
            );
        }
        Commands::EvalBenchmark {
            split_json,
            ontology,
            cache,
            limit,
            max_questions,
            max_prompt_tokens,
            encoder_model,
            encoder_threshold,
        } => {
            let ont = load_ontology_named(&ontology)?;
            let client = SystemOneClient::new(&cli.model, &cli.base_url, cli.timeout);
            let cache = DecisionCache::open(&cache)?;
            let proposers = benchmark_proposers(&encoder_model, encoder_threshold)?;
            let extractor = Extractor::new(ont, client)
                .with_cache(cache)
                .with_max_questions(max_questions)
                .with_max_prompt_tokens(max_prompt_tokens)
                .with_proposers(proposers);
            let mut docs = load_converted_json(&split_json)?;
            if let Some(n) = limit {
                docs.truncate(n);
            }
            let mut entity_rows = Vec::new();
            let mut relation_rows = Vec::new();
            for doc in &docs {
                let text = doc.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let id = doc.get("id").and_then(|v| v.as_str()).unwrap_or("doc");
                let sent = Sentence {
                    id: format!("{id}-s0"),
                    text: text.to_string(),
                    start: 0,
                    end: text.len(),
                    heading_path: vec![],
                    index: 0,
                };
                let started = std::time::Instant::now();
                let result = extractor.extract_sentences(
                    &[sent],
                    id,
                    &format!("{id}-chunk-0"),
                    started,
                    0.0,
                )?;
                let scored = score_spans(&result, doc);
                println!(
                    "{id} span_ent_f1={:.3} span_rel_f1={:.3}",
                    scored.entities.f1, scored.relations.f1
                );
                entity_rows.push(scored.entities);
                relation_rows.push(scored.relations);
            }
            let ents = micro_average(&entity_rows);
            let rels = micro_average(&relation_rows);
            println!(
                "micro span_entities_f1={:.3} span_relations_f1={:.3} notes={} gate_fitted=false",
                ents.f1,
                rels.f1,
                docs.len()
            );
        }
    }
    Ok(())
}

fn with_default_plus_encoder(
    extractor: Extractor,
    encoder_model: &str,
    threshold: f64,
) -> Result<Extractor, Box<dyn std::error::Error>> {
    let encoder = live_encoder(encoder_model)?;
    let mut proposers = edgextract::candidates::default_proposers();
    proposers.push(Box::new(EncoderProposer::new(encoder, threshold)));
    Ok(extractor.with_proposers(proposers))
}

fn benchmark_proposers(
    encoder_model: &str,
    threshold: f64,
) -> Result<Vec<Box<dyn Proposer>>, Box<dyn std::error::Error>> {
    let encoder = live_encoder(encoder_model)?;
    Ok(vec![
        Box::new(GazetteerProposer),
        Box::new(EncoderProposer::new(encoder, threshold)),
    ])
}

fn live_encoder(
    encoder_model: &str,
) -> Result<Arc<dyn edgextract::span_encoder::SpanEncoder>, Box<dyn std::error::Error>> {
    #[cfg(feature = "spans")]
    {
        Ok(Arc::new(edgextract::span_encoder::Gliner2Encoder::new(
            encoder_model,
        )))
    }
    #[cfg(not(feature = "spans"))]
    {
        let _ = encoder_model;
        Err(
            "GLiNER support requires a build with --features spans (gliner-rs / Candle). \
             Default extract still uses gazetteer and markdown proposers."
                .into(),
        )
    }
}
