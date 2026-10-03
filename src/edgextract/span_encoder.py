"""Optional span proposers. The decision model still assigns ontology types."""

from __future__ import annotations

from typing import Protocol

from edgextract.candidates import Proposer, _mention
from edgextract.ontology import Ontology
from edgextract.types import Mention, MentionSource, Sentence


class SpanEncoder(Protocol):
    """Return character spans into sentence.text. Labels are discarded by the pipeline."""

    def propose_spans(
        self,
        text: str,
        labels: dict[str, str],
        *,
        threshold: float = 0.5,
    ) -> list[tuple[int, int, float]]:
        """Return (start, end, score) half-open spans in ``text``."""


class EncoderProposer(Proposer):
    name = "encoder"

    def __init__(self, encoder: SpanEncoder, *, threshold: float = 0.5) -> None:
        self.encoder = encoder
        self.threshold = threshold

    def propose(self, sentence: Sentence, ontology: Ontology) -> list[Mention]:
        labels = {t.id.lower(): t.description for t in ontology.types}
        spans = self.encoder.propose_spans(sentence.text, labels, threshold=self.threshold)
        mentions: list[Mention] = []
        for start, end, _score in spans:
            if start < 0 or end > len(sentence.text) or start >= end:
                continue
            surface = sentence.text[start:end]
            if not surface.strip():
                continue
            mentions.append(_mention(sentence, surface, start, end, MentionSource.ENCODER))
        return mentions


class FixedSpanEncoder:
    """Test double: returns predetermined spans regardless of labels."""

    def __init__(self, spans: list[tuple[int, int, float]] | None = None) -> None:
        self.spans = list(spans or [])

    def propose_spans(
        self,
        text: str,
        labels: dict[str, str],
        *,
        threshold: float = 0.5,
    ) -> list[tuple[int, int, float]]:
        del text, labels
        return [(s, e, sc) for s, e, sc in self.spans if sc >= threshold]


class Gliner2Encoder:
    """GLiNER2.5 boundary extractor. Optional dependency: gliner2[local]."""

    def __init__(
        self,
        model_id: str = "fastino/gliner2.5-small-v1",
        *,
        map_location: str = "mps",
        extractor: object | None = None,
    ) -> None:
        self.model_id = model_id
        self.map_location = map_location
        self._extractor = extractor

    def _load(self) -> object:
        if self._extractor is not None:
            return self._extractor
        try:
            from gliner2 import AutoExtractor
        except ImportError as exc:  # pragma: no cover - optional extra
            raise ImportError(
                'Install the spans extra: uv sync --extra spans (package "gliner2[local]").'
            ) from exc
        self._extractor = AutoExtractor.from_pretrained(
            self.model_id, map_location=self.map_location
        )
        return self._extractor

    def propose_spans(
        self,
        text: str,
        labels: dict[str, str],
        *,
        threshold: float = 0.5,
    ) -> list[tuple[int, int, float]]:
        model = self._load()
        result = model.extract_entities(  # type: ignore[attr-defined]
            text,
            labels,
            threshold=threshold,
            include_confidence=True,
            include_spans=True,
        )
        out: list[tuple[int, int, float]] = []
        seen: set[tuple[int, int]] = set()
        for _label, items in (result.get("entities") or {}).items():
            for item in items:
                start = int(item["start"])
                end = int(item["end"])
                score = float(item.get("confidence", 1.0))
                if (start, end) in seen:
                    continue
                seen.add((start, end))
                out.append((start, end, score))
        out.sort(key=lambda x: (x[0], -(x[1] - x[0])))
        return out
