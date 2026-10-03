"""Shared data types for closed-decision KG extraction."""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class GateBand(StrEnum):
    ACCEPT = "ACCEPT"
    REVIEW = "REVIEW"
    REJECT = "REJECT"


class MentionSource(StrEnum):
    GAZETTEER = "gazetteer"
    MARKDOWN = "markdown"
    SHAPE = "shape"
    ENCODER = "encoder"


class Sentence(BaseModel):
    id: str
    text: str
    start: int
    end: int
    heading_path: tuple[str, ...] = ()
    index: int = 0


class Mention(BaseModel):
    text: str
    start: int
    end: int
    sentence_id: str
    heading_path: tuple[str, ...] = ()
    source: MentionSource = MentionSource.SHAPE
    skipped_reason: str | None = None


class ChoiceAnswer(BaseModel):
    type: str = "choice"
    choice: str
    probabilities: dict[str, float]
    confidence: float | None = None


class NoulAnswer(BaseModel):
    type: str = "noul"
    noul: float


class ScoreAnswer(BaseModel):
    type: str = "score"
    score: float
    probabilities: dict[str, float] | None = None
    confidence: float | None = None
    legend: list[str] | None = None


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class SystemOneResponse(BaseModel):
    model: str
    answers: dict[str, dict[str, Any]]
    usage: Usage = Field(default_factory=Usage)


class TypedMention(BaseModel):
    mention: Mention
    entity_type: str
    probabilities: dict[str, float] = Field(default_factory=dict)
    confidence: float | None = None
    band: GateBand = GateBand.REVIEW
    winner_prob: float = 0.0
    flipped: bool = False
    question_id: str = ""
    decided_by: str = "model"


class RelationHit(BaseModel):
    source_text: str
    source_type: str
    source_start: int
    source_end: int
    target_text: str
    target_type: str
    target_start: int
    target_end: int
    relation_type: str
    probabilities: dict[str, float] = Field(default_factory=dict)
    confidence: float | None = None
    band: GateBand = GateBand.REVIEW
    winner_prob: float = 0.0
    flipped: bool = False
    sentence_id: str
    heading_path: tuple[str, ...] = ()
    evidence: str = ""


class ExtractedEntity(BaseModel):
    """EdgeQuake-shaped entity record."""

    name: str
    entity_type: str
    description: str
    importance: float = 0.5
    source_spans: list[str] = Field(default_factory=list)
    source_chunk_ids: list[str] = Field(default_factory=list)
    source_document_id: str | None = None
    display_name: str | None = None


class ExtractedRelationship(BaseModel):
    """EdgeQuake-shaped relationship record."""

    source: str
    target: str
    relation_type: str
    description: str
    weight: float = 0.5
    keywords: list[str] = Field(default_factory=list)
    source_chunk_ids: list[str] = Field(default_factory=list)
    source_document_id: str | None = None


class ExtractionResult(BaseModel):
    entities: list[ExtractedEntity] = Field(default_factory=list)
    relationships: list[ExtractedRelationship] = Field(default_factory=list)
    source_chunk_id: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    extraction_time_ms: int = 0
    review: list[dict[str, Any]] = Field(default_factory=list)
    rejected: list[dict[str, Any]] = Field(default_factory=list)
    mentions: list[TypedMention] = Field(default_factory=list)
    relation_hits: list[RelationHit] = Field(default_factory=list)


class PipelineStats(BaseModel):
    sentences: int = 0
    mentions_proposed: int = 0
    mentions_skipped: int = 0
    pairs_considered: int = 0
    pairs_truncated: int = 0
    systemone_calls: int = 0
    cache_hits: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    elapsed_ms: int = 0
