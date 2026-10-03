# 11 — Edge cases

Each row: mitigate in code, test ID. Linked from REQ-8.

| ID | Case | Mitigation | Test |
| EC-1 | Empty / whitespace doc | No calls, empty graph | T-3, T-9 |
| EC-2 | Fenced code | Skip fence regions | T-3 |
| EC-3 | YAML frontmatter | Strip, keep offsets | T-3 |
| EC-4 | Prompt injection in markdown | State is data; ontology still closed | T-3 |
| EC-5 | Overlapping mentions | Longest span wins | T-4 |
| EC-6 | Pronouns | Propose+skip, no type call | T-4, T-9 |
| EC-7 | Nested / shorter overlap | merge_mentions | T-4 |
| EC-8 | Malformed / missing answers | SystemOneError | T-2 |
| EC-9 | Probabilities not ~1; choice not in keys | SystemOneError | T-2 |
| EC-10 | HTTP 4xx/5xx / handler crash | Fail closed | T-9 |
| EC-11 | Pair explosion | max_pairs + truncated count | T-8 |
| EC-12 | >26 types | Two-stage GROUP_* then type (REQ-10) | T-1, T-8 |
| EC-13 | Opaque / numeric names | normalize → drop | T-5, T-8 |
| EC-14 | Self-loops | Drop in assemble | T-9 |
| EC-15 | Negation / hedge | Instructions say NONE; tests with fake+gold | T-9 |
| EC-16 | Option-order flip | Re-ask; REVIEW | T-9 |
| EC-17 | Repeat request | SQLite cache hit | T-9 |
| EC-18 | noul out of range | SystemOneError | T-2 |

Also covered in golden docs: code-only-ish 04_none, hedge 12_hedge, overlap 09_overlap.
