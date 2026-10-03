# 07 — Lens: Database expert

**WHY.** A triple without a citation is gossip. REQ-5. WHY-5.

SQLite (`cache.py`):

```
decisions(cache_key PK, model, body_hash, response_json, created_at)
runs(run_id PK, document_id, model, ontology_id, started_at, finished_at, stats_json, result_json)
```

Export shape matches EdgeQuake pipeline types:

| edgextract | EdgeQuake (inspiration) |
| entities[].name | ExtractedEntity.name (UPPERCASE_UNDERSCORE) |
| entity_type | entity_type |
| description | description (here: evidence) |
| source_chunk_ids | source_chunk_ids (merger fail-closes without them) |
| relationships source/target/relation_type/weight | ExtractedRelationship |
| Cypher Node/EDGE | AGE vertex label Node, edge label EDGE |

Postgres-shaped mental model (not migrated here): `entities`, `relationships`, `chunk_entity_links`, `chunk_relation_links`.

Self-loops dropped (EC-14). Opaque ids empty (EC-13).
