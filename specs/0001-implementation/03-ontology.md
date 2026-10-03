# 03 — Ontology (REQ-1)

**WHY.** A graph without a schema is a pile of strings. See WHY-2, FP-3.

File: `data/ontology/tech_docs.yaml` (also packaged). Types: PERSON, ORGANIZATION, PRODUCT, TECHNOLOGY, LOCATION, EVENT. Relations: CREATED_BY, WORKS_AT, USES, PART_OF, LOCATED_IN, DEPENDS_ON, HAPPENED_AT, each with domain and range.

```
 PERSON ----WORKS_AT----> ORGANIZATION ----LOCATED_IN----> LOCATION
    |                         |
    +----USES----> PRODUCT/TECHNOLOGY
 PRODUCT --CREATED_BY--> PERSON|ORGANIZATION
 PRODUCT --DEPENDS_ON--> PRODUCT|TECHNOLOGY
 EVENT --HAPPENED_AT--> ORGANIZATION|LOCATION
```

Limits: 2–50 types, relation edges ≤ 100, Choice options ≤ 26 including `NOT_ENTITY` / `NONE`. If types+1 > 26, two-stage grouping (REQ-10, EC-12).

Gazetteer names are hints for the proposer, not answers. The model still types.

Unknown domain/range in YAML is a load error. Tests: T-1.
