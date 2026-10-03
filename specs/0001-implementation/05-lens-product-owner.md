# 05 — Lens: Product Owner

**WHY.** The product is a fast, honest extractor, not a chatbot. WHY-5.

Personas: ingest engineer wiring EdgeQuake-like graphs; researcher comparing decision models; reviewer of the REVIEW queue.

Value: lower $/doc and latency vs one LLM JSON call per chunk; schema fidelity; a visible review pile instead of silent junk triples.

In scope: markdown, one bundled tech-docs ontology, CLI, HTML report, golden eval, article.

Out of scope: a hosted SaaS, coreference, image-to-graph (Clef can judge images; v0.1 does not build graphs from pixels).

Success metrics (measure, do not invent): time/doc, System One calls/doc, entity F1, relation F1, coverage at a chosen error budget, share in REVIEW. See [14-evaluation.md](14-evaluation.md).

Risks: proposer recall (missed spans never get typed); unfitted thresholds; option-order flips (EC-16).
