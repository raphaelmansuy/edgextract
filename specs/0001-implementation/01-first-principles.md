# 01 — First principles

Grounded in WHY-1..WHY-5.

- **FP-1. Closed before the call.** You declare the question and the legal answers first. The machine may return only a value inside that type. Linked from REQ-2.
- **FP-2. Propose then decide.** Spans come from names the ontology lists, or from spans the author marked. The model does not hunt for shapes. REQ-3.
- **FP-3. Ontology is the schema.** Domain/range prune illegal pairs in code, not in a prompt. REQ-1.
- **FP-4. Fail closed.** A missing key, a choice not in the map, a transport error: no invented triple. REQ-8, EC-8, EC-10.
- **FP-5. Thresholds live in code.** `GateConfig.fitted` starts false. Calibrate on our labels. REQ-4.
- **FP-6. Evidence, not essays.** Descriptions are source sentences. The decision model cannot summarise. REQ-9.
- **FP-7. Linear work.** Calls grow with sentences, not with the Cartesian product of the whole document. Pairs per sentence are capped. REQ-6, EC-11.
- **FP-8. One decision helper.** DRY: one client, one validator, one gate. SOLID: proposers are replaceable; transport is a protocol. [04-architecture.md](04-architecture.md).

```
  You own:      ontology, spans, pairs, thresholds, lineage, cache
  Model owns:   a distribution over the labels you listed
  Nobody owns:  a free-text type name
```
