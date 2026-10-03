# 15 — Traceability

REQ/EC must appear here and in `tests/`. `scripts/check_xrefs.py` enforces that.

| ID | Spec | Module | Tests |
| REQ-1 | 03-ontology | ontology.py | T-1 |
| REQ-2 | 02-contract | systemone.py | T-2, T-10, T-11 |
| REQ-3 | 01 FP-2, 04 | candidates.py, decisions.py | T-4, T-9 |
| REQ-4 | 01 FP-5, 10 | gate.py, calibrate.py | T-6, T-9 |
| REQ-5 | 07 | names.py, assemble.py | T-5, T-9 |
| REQ-6 | 10 | pipeline.py, decisions.py | T-9 |
| REQ-7 | 06, 07 | cache.py | T-9 EC-17 |
| REQ-8 | 01 FP-4 | systemone.py | T-2, T-9 EC-10 |
| REQ-9 | 01 FP-6 | assemble.py, baseline_llm.py | T-7, T-8 |
| REQ-10 | 03 | ontology.py, decisions.py | T-1, T-8 EC-12 |
| EC-1 | 11 | markdown.py, pipeline.py | T-3, T-9 |
| EC-2 | 11 | markdown.py | T-3 |
| EC-3 | 11 | markdown.py | T-3 |
| EC-4 | 11 | markdown.py | T-3 |
| EC-5 | 11 | candidates.py | T-4 |
| EC-6 | 11 | candidates.py | T-4, T-9 |
| EC-7 | 11 | candidates.py | T-4 |
| EC-8 | 11 | systemone.py | T-2 |
| EC-9 | 11 | systemone.py | T-2 |
| EC-10 | 11 | systemone.py | T-9 |
| EC-11 | 11 | decisions.py | T-8 |
| EC-12 | 11 | ontology.py | T-1, T-8 |
| EC-13 | 11 | names.py | T-5, T-8 |
| EC-14 | 11 | assemble.py, decisions.py | T-9 |
| EC-15 | 11 | decisions.py | T-9 |
| EC-16 | 11 | decisions.py | T-9 |
| EC-17 | 11 | cache.py | T-9 |
| EC-18 | 11 | systemone.py | T-2 |

WHY-1..WHY-5 ↔ 00-why.md. FP-1..FP-8 ↔ 01-first-principles.md. T-1..T-11 ↔ 13-test-plan.md. M-1..M-9 ↔ 12-implementation-plan.md.

## EdgeQuake file map (read-only inspiration)

- `edgequake/crates/edgequake-pipeline/src/extractor/types.rs` — ExtractedEntity / Relationship
- `.../prompts/entity_type_policy.rs` — EntityExtractionSchema
- `.../extractor/llm.rs` — JSON LLM extractor (our baseline analogue)
- `edgequake-storage/src/entity_id.rs` — name normalization
- `edgequake-llm` Ollama provider — different endpoint (`/api/chat`), not `/v1/systemone`
