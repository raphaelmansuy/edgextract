# 10 — Lens: AI / KG / O(n)

**WHY.** A closed decision is cheap only if we do not explode pairs. WHY-3, FP-7, REQ-6.

Let S = sentences, M_s = mentions in sentence s, k = max pairs per sentence (24).

- Propose: O(n) in characters.
- Type calls: O(S) batches (≤ 12 questions/call).
- Candidate pairs: only ontology-legal (src_type, tgt_type). Capped at k; extras counted as `pairs_truncated` (EC-11).
- Relate calls: O(S) batches.
- Worst case work: O(n + S · k), not O((mentions in doc)²).

Abstain is a Noul, not a NONE or NOT_ENTITY label (FP-1). A gazetteer hit is a lookup, not a Choice. Option-order re-ask is off until you measure bias and set `rotate_below_confidence` (EC-16).

Calibration: precision–coverage curve on winner_prob. Do not copy 0.8906 from the release notes (WHY-4, REQ-4).

KG: descriptions extractive (REQ-9). No generated synonyms as types.

Clef/Clef Flash: images are state, not graph output, in v0.1.
