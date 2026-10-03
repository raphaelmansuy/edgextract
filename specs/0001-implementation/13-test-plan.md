# 13 — Test plan

Pyramid: unit (T-1..T-8) → fake HTTP e2e (T-9) → live (T-10) → golden eval (T-11).

| ID | What | Where |
| T-1 | Ontology limits, two-stage | `test_ontology.py` REQ-1 REQ-10 EC-12 |
| T-2 | Validator | `test_systemone.py` REQ-2 EC-8 EC-9 EC-18 |
| T-3 | Markdown | `test_markdown.py` EC-1..EC-4 |
| T-4 | Mentions | `test_candidates.py` REQ-3 EC-5 EC-6 EC-7 |
| T-5 | Names | `test_names.py` REQ-5 EC-13 |
| T-6 | Gate | `test_gate.py` REQ-4 |
| T-7 | Eval/baseline JSON | `test_eval_baseline.py` REQ-9 |
| T-8 | Pairs, report, opaque | `test_edge_cases.py` EC-11 EC-12 EC-13 REQ-10 |
| T-9 | In-process HTTP | `test_e2e_pipeline.py` REQ-3..REQ-8, EC-10,14-17 |
| T-10 | Live Ollama | `test_live_systemone.py` `make test-live` |
| T-11 | Fixtures from notes + live | `test_fixtures.py` REQ-2 |

`make test` ignores live. Markers: `live`, `req`, `ec`.
