# 04 — Architecture

**WHY.** Each moving part has one job (FP-8, SOLID). Calls stay linear (FP-7, REQ-6).

```
 markdown.py     sentences, offsets, heading path, fences skipped
 candidates.py   Proposer: gazetteer (exact names), markdown marks, pronouns
 ontology.py     types, relations, signatures, 26-option grouping
 systemone.py    Transport protocol, builders, fail-closed validator
 decisions.py    batched Choice questions, option rotation
 gate.py         ACCEPT / REVIEW / REJECT
 assemble.py     normalize names, lineage, EdgeQuake JSON
 cache.py        SQLite decisions + run ledger (REQ-7)
 pipeline.py     Extractor facade
 baseline_llm.py chat JSON comparison (not a decision)
 eval.py / calibrate.py   scores and fitted cutoffs
 cli.py / report.py       operator surface
```

```
[Parse O(n)] -> [Propose O(n)] -> [Type: 1 call / sentence batch]
     -> [Prune pairs by signature] -> [Relate: 1 call / sentence batch, cap k]
     -> [Gate] -> [Assemble]
```

DRY: one `validate_response`, one `GateConfig`, one `normalize_entity_name`.

EdgeQuake mapping (inspiration, not a Rust patch): `ExtractedEntity` / `ExtractedRelationship` fields including `source_chunk_ids`. See [07-lens-database.md](07-lens-database.md) and [15-traceability.md](15-traceability.md).

Module tests: T-1..T-8. E2E: T-9.
