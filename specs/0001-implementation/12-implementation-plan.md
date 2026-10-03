# 12 — Implementation plan

Milestones. Exit = tests + xref.

- **M-1** Scaffold uv, contract probe, fixtures. Done: `tests/fixtures/nimble_*.json`.
- **M-2** Ontology, markdown, proposers, client. T-1..T-4.
- **M-3** Decisions, gate, assemble, cache, pipeline, fake HTTP e2e. T-9.
- **M-4** LLM baseline, eval, calibrate, golden set of 12 docs.
- **M-5** Examples 01–09.
- **M-6** This spec pack + `scripts/check_xrefs.py`.
- **M-7** Article, SVG, PDF.
- **M-8** HTML report CLI.
- **M-9** ruff, full tests, live tests on pulled models, measured comparison.

SOLID/DRY gates: one Transport, one GateConfig, Proposer ABC, no copied JSON repair.

Principles: FP-1..FP-8. Risks: model weights not pulled (skip live, keep fake e2e).
