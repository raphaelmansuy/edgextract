# SPEC 0001 — Closed-decision KG extraction

**WHY.** EdgeQuake-scale ingest needs entities and relations from markdown, fast, against a fixed ontology. A chat model that writes JSON is the wrong machine. Ollama 0.35 `POST /v1/systemone` is a closed decision. This pack specifies the library, tests, and article in `edgextract`.

## Reading order

1. [00-why.md](00-why.md) — WHY-1..WHY-5
2. [01-first-principles.md](01-first-principles.md) — FP-1..FP-8
3. [02-contract-systemone.md](02-contract-systemone.md) — REQ-2
4. [03-ontology.md](03-ontology.md) — REQ-1
5. [04-architecture.md](04-architecture.md)
6. Lenses 05–10 (product, fullstack, database, UX, front, AI/KG/O(n))
7. [11-edge-cases.md](11-edge-cases.md) — EC-*
8. [12-implementation-plan.md](12-implementation-plan.md) — M-*
9. [13-test-plan.md](13-test-plan.md) — T-*
10. [14-evaluation.md](14-evaluation.md)
11. [15-traceability.md](15-traceability.md)

```
                  00 WHY
                    |
         01 First principles (FP)
                    |
     +--------------+--------------+
     |              |              |
  02 Contract    03 Ontology    04 Architecture
     |              |              |
     +------+-------+-------+------+
            |               |
      05-10 Lenses     11 Edge cases
            |               |
            +-------+-------+
                    |
         12 Plan / 13 Tests / 14 Eval
                    |
              15 Traceability
```

IDs: `WHY-n`, `FP-n`, `REQ-n`, `EC-n`, `T-n`, `M-n`. `scripts/check_xrefs.py` fails if a REQ or EC is missing from tests or from 15.

Companion pages (not in this repo): Ideas Lab “Work in a Jev-like way…” and “Fast cheap KG IE”.
