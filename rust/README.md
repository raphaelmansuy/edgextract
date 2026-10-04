# edgextract (Rust)

Closed-decision knowledge graph extraction. The Python package remains the reference; this crate is the same machine in Rust.

```bash
cargo add edgextract
# CLI:
cargo install edgextract
```

Browser WASM (npm, not crates.io): `npm i @raphael.mansuy/edgextract`. Demo: [GitHub Pages](https://raphaelmansuy.github.io/edgextract/) · [Hugging Face Space](https://raphaelmansuy-edgextract.static.hf.space/).

## First principles

You declare the question and the legal answers first. Spans come from names the ontology lists, markdown cues, or an optional GLiNER proposer. GLiNER only proposes character spans; the decision model still assigns ontology types. Domain and range prune illegal pairs in code. A missing key, a choice not in the map, or a transport error produces no invented triple. Thresholds live in `GateConfig` (`fitted` starts false). Evidence is the source sentence. Work is per sentence. There is one client, one validator, and one gate.

See [specs/0001-implementation/01-first-principles.md](../specs/0001-implementation/01-first-principles.md).

## Build and test

From the repository root:

```bash
cargo test --manifest-path rust/edgextract/Cargo.toml
```

Or `cargo test` from the workspace root. Tests start a local HTTP server and POST to `/v1/systemone`. They do not need Ollama or GLiNER weights.

GLiNER2.5 (Candle) is behind `--features spans`. That build downloads nothing during `cargo test` unless you run the ignored live test, which loads a local checkpoint.

```bash
cargo test --manifest-path rust/edgextract/Cargo.toml --features spans -- --ignored --nocapture live_gliner
```

A live SystemOne probe (Ollama 0.35+ with a decision model):

```bash
cargo test --manifest-path rust/edgextract/Cargo.toml -- --ignored --nocapture live_systemone
```

## CLI

```bash
cargo run --manifest-path rust/edgextract/Cargo.toml -- validate-ontology tech_docs
cargo run --manifest-path rust/edgextract/Cargo.toml -- extract note.md --ontology tech_docs --out graph.json
```

Default extract uses gazetteer, markdown, and pronoun proposers. Add GLiNER spans with a spans-enabled binary:

```bash
cargo run --manifest-path rust/edgextract/Cargo.toml --features spans -- \
  extract note.md --ontology tech_docs --encoder --encoder-model fastino/gliner2.5-base-v1 --out graph.json
```

`--encoder-model` is a local checkpoint directory, or a Fastino repo id whose files already live in `$XDG_CACHE_HOME/gliner-rs/<name>` (or `~/.cache/gliner-rs/<name>`). The library does not type from GLiNER labels.

CoNLL04-style span scoring (gazetteer + encoder, whole document as one sentence, encoder cutoff 0.30):

```bash
cargo run --manifest-path rust/edgextract/Cargo.toml --features spans -- \
  eval-benchmark tests/fixtures/conll04_sample.json --ontology conll04 --limit 3
```

Each `/v1/systemone` POST is one model step. The extractor packs closed questions until an estimated prompt stays under `--max-prompt-tokens` (default 2000, under tev1's 2050). `--max-questions` is a second cap. A host 400 about context length splits the batch and retries; other transport errors stay fail-closed. The cache key includes `edgextract.decision.2026-10-06`. Each question quotes the only sentence it may use. A listed name is accepted only when the surface matches that spelling. A kept triple is checked in code: legal ontology label, two different names, and a source sentence. `eval` scores a golden directory with deterministic precision and recall.

`extract` writes EdgeQuake-shaped JSON. HTML reports stay in the Python package.

## WebAssembly

The core crate builds for `wasm32-unknown-unknown` once the `native` feature (HTTP client, SQLite cache, CLI, local fake server) is off:

```bash
make wasm-check          # cargo build -p edgextract --no-default-features --target wasm32-unknown-unknown
make wasm                # wasm-pack build of rust/edgextract-wasm into web/src/wasm
```

Two things change in the browser, and both are swapped in at the edge: the decision cache lives in memory (`DecisionCache::in_memory`), and the model is a JavaScript function you pass to `Engine.extract` (the demo makes a synchronous `POST /v1/systemone` from a Web Worker). Set `discover_names` in the request to also propose capitalized runs the ontology does not list (`candidates::ShapeProposer`); each is still decided by the model. `standin::rule_handler` is a rule-based test double used by Rust tests, and `edgextract serve-standin` serves it over HTTP with CORS for the demo's end-to-end tests. It is not a decision model and the browser API does not accept it.

See [web/README.md](../web/README.md) for the demo.
