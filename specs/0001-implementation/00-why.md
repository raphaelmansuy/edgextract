# 00 — WHY

**Start here.** Software does not want an essay about a paragraph. It wants a graph it can store: who, what, which link, and whether to trust the link.

## Five whys

- **WHY-1.** Why not ask a chat model for JSON triples? Because a writer can invent a type, skip a key, or put a word where you needed a number. Parsing is where the decision leaks. See FP-1, REQ-2.
- **WHY-2.** Why a fixed ontology? A knowledge graph has a schema. Open generation fights that schema. Types, relations, and legal edges must exist *before* the call. See REQ-1, [03-ontology.md](03-ontology.md).
- **WHY-3.** Why not let the decision model find the spans? Ollama System One answers `choice`, `noul`, `score`. It does not generate text. Span finding is code (or an encoder). See FP-2, REQ-3.
- **WHY-4.** Why gate in our code? The host may return a sharp probability that is still wrong. Ollama’s notes do not claim calibration like hosted Jev. Cutoffs are ours and must be fitted. See REQ-4, [14-evaluation.md](14-evaluation.md).
- **WHY-5.** Why this for EdgeQuake? EdgeQuake’s bottleneck at ingest is cost, latency, and schema fidelity per chunk — not “can an LLM emit triples?” A closed decision over candidates is the cheap path. See [07-lens-database.md](07-lens-database.md).

## Problem

Given markdown and an ontology, emit EdgeQuake-shaped entities and relationships with provenance, plus a review queue for the rest.

## Non-goals

- Free-text NER from the decision model.
- Coreference (pronouns are skipped: EC-6).
- Claiming Ollama probabilities are calibrated.
- Calling chat `format` / JSON schema “Jev”.
- Inventing a Score JSON body — we recorded a live one instead ([02-contract-systemone.md](02-contract-systemone.md)).
