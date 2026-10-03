"""End-to-end extract: parse, propose, decide, gate, assemble."""

from __future__ import annotations

import time
import uuid
from pathlib import Path

from edgextract.assemble import assemble
from edgextract.cache import DecisionCache
from edgextract.candidates import DEFAULT_PROPOSERS, Proposer, propose_mentions
from edgextract.decisions import CachedClient, relate_pairs, type_mentions
from edgextract.gate import GateConfig
from edgextract.markdown import split_sentences
from edgextract.ontology import Ontology
from edgextract.systemone import SystemOneClient
from edgextract.types import ExtractionResult, PipelineStats, Sentence


class Extractor:
    def __init__(
        self,
        ontology: Ontology,
        client: SystemOneClient,
        gate: GateConfig | None = None,
        cache: DecisionCache | None = None,
        max_pairs: int = 24,
        proposers: tuple[Proposer, ...] | None = None,
    ) -> None:
        self.ontology = ontology
        self.client = client
        self.gate = gate or GateConfig()
        self.cache = cache
        self.max_pairs = max_pairs
        self.proposers = proposers if proposers is not None else DEFAULT_PROPOSERS

    def extract_markdown(
        self,
        text: str,
        *,
        document_id: str = "doc",
        chunk_id: str | None = None,
    ) -> ExtractionResult:
        started = time.time()
        sentences = split_sentences(text, doc_id=document_id)
        return self.extract_sentences(
            sentences,
            document_id=document_id,
            chunk_id=chunk_id or f"{document_id}-chunk-0",
            started=started,
        )

    def extract_sentences(
        self,
        sentences: list[Sentence],
        *,
        document_id: str,
        chunk_id: str,
        started: float | None = None,
    ) -> ExtractionResult:
        t0 = started if started is not None else time.time()
        get_put = None
        if self.cache is not None:
            get_put = (self.cache.get, self.cache.put)
        cached = CachedClient(self.client, get_put)
        all_typed = []
        all_hits = []
        proposed = 0
        skipped = 0
        pairs = 0
        truncated = 0
        for sent in sentences:
            mentions = propose_mentions(sent, self.ontology, proposers=self.proposers)
            proposed += len(mentions)
            skipped += sum(1 for m in mentions if m.skipped_reason)
            typed = type_mentions(sent, mentions, self.ontology, cached, self.gate)
            hits, trunc = relate_pairs(
                sent, typed, self.ontology, cached, self.gate, max_pairs=self.max_pairs
            )
            all_typed.extend(typed)
            all_hits.extend(hits)
            pairs += len(hits) + trunc
            truncated += trunc
        result = assemble(
            all_typed, all_hits, self.ontology, document_id=document_id, chunk_id=chunk_id
        )
        elapsed = int((time.time() - t0) * 1000)
        stats = PipelineStats(
            sentences=len(sentences),
            mentions_proposed=proposed,
            mentions_skipped=skipped,
            pairs_considered=pairs,
            pairs_truncated=truncated,
            systemone_calls=cached.calls,
            cache_hits=cached.cache_hits,
            input_tokens=cached.input_tokens,
            output_tokens=cached.output_tokens,
            elapsed_ms=elapsed,
        )
        result.metadata = {
            "parser": "edgextract",
            "ontology_id": self.ontology.id,
            "model": self.client.model,
            "gate_fitted": self.gate.fitted,
            "stats": stats.model_dump(),
        }
        result.input_tokens = stats.input_tokens
        result.output_tokens = stats.output_tokens
        result.extraction_time_ms = elapsed
        if self.cache is not None:
            self.cache.record_run(
                run_id=str(uuid.uuid4()),
                document_id=document_id,
                model=self.client.model,
                ontology_id=self.ontology.id,
                stats=stats.model_dump(),
                result=result.model_dump(mode="json"),
                started_at=t0,
                finished_at=time.time(),
            )
        return result


def extractor_from_files(
    ontology_path: str | Path,
    model: str = "nimble",
    base_url: str = "http://localhost:11434",
    cache_path: str | Path | None = None,
    timeout: float = 60.0,
) -> Extractor:
    from edgextract.ontology import load_ontology_named

    ontology = load_ontology_named(ontology_path)
    cache = DecisionCache(cache_path) if cache_path else None
    client = SystemOneClient(model=model, base_url=str(base_url), timeout=timeout)
    return Extractor(ontology=ontology, client=client, cache=cache)


def extract_text(
    text: str,
    ontology: str | Path | Ontology = "tech_docs",
    *,
    model: str = "nimble",
    document_id: str = "doc",
    base_url: str = "http://localhost:11434",
) -> ExtractionResult:
    """Five-line path: load an ontology, ask the decision model, return a graph."""
    from edgextract.ontology import load_ontology_named

    ont = ontology if isinstance(ontology, Ontology) else load_ontology_named(ontology)
    client = SystemOneClient(model=model, base_url=base_url)
    return Extractor(ont, client).extract_markdown(text, document_id=document_id)
