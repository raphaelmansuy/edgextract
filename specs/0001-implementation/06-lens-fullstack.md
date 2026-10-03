# 06 — Lens: Full-stack developer

**WHY.** The operator surface must fail closed and be scriptable. REQ-8.

CLI (`edgextract`): `probe`, `extract`, `report`, `eval`, `calibrate`, `export-cypher`.

Config: `--base-url` (default `http://localhost:11434`), `--model` (default `nimble`), `--ontology`, `--cache`, `--timeout`.

Errors: `SystemOneError` to stderr, exit 1. Never write a partial graph as if it were complete when the host failed mid-document (current v0.1 fails the run). Cache keys hash model+state+questions so wording changes bust the cache (REQ-7, EC-17).

Concurrency: Ollama local is treated as serial. No parallel System One storms in v0.1. REQ-6.

Library entry: `Extractor.extract_markdown`. Transport is injectable for tests (T-9).
