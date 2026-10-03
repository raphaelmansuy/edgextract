"""Propose mention spans. The decision model never finds spans on its own."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod

from edgextract.ontology import Ontology
from edgextract.types import Mention, MentionSource, Sentence

_PRONOUNS = frozenset(
    {
        "i",
        "me",
        "my",
        "we",
        "us",
        "our",
        "you",
        "your",
        "he",
        "him",
        "his",
        "she",
        "her",
        "hers",
        "it",
        "its",
        "they",
        "them",
        "their",
        "this",
        "that",
        "these",
        "those",
    }
)
_PRONOUN_RX = re.compile(
    r"\b(" + "|".join(sorted(_PRONOUNS, key=len, reverse=True)) + r")\b",
    re.I,
)
_BOLD = re.compile(r"\*\*([^*]+)\*\*|__([^_]+)__")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_CODE = re.compile(r"`([^`]+)`")


class Proposer(ABC):
    name: str

    @abstractmethod
    def propose(self, sentence: Sentence, ontology: Ontology) -> list[Mention]:
        raise NotImplementedError


class GazetteerProposer(Proposer):
    name = "gazetteer"

    def propose(self, sentence: Sentence, ontology: Ontology) -> list[Mention]:
        mentions: list[Mention] = []
        text = sentence.text
        lowered = text.casefold()
        names = sorted(ontology.gazetteer.keys(), key=len, reverse=True)
        occupied: list[tuple[int, int]] = []
        for name in names:
            needle = name.casefold()
            start = 0
            while True:
                i = lowered.find(needle, start)
                if i < 0:
                    break
                j = i + len(needle)
                if _inside(i, j, occupied):
                    start = i + 1
                    continue
                if not _token_boundary(text, i, j):
                    start = i + 1
                    continue
                occupied.append((i, j))
                mentions.append(_mention(sentence, text[i:j], i, j, MentionSource.GAZETTEER))
                start = j
        return mentions


class MarkdownCueProposer(Proposer):
    name = "markdown"

    def propose(self, sentence: Sentence, ontology: Ontology) -> list[Mention]:
        del ontology
        mentions: list[Mention] = []
        text = sentence.text
        for rx, _group in ((_BOLD, 0), (_LINK, 1), (_CODE, 1)):
            for m in rx.finditer(text):
                span = next(g for g in m.groups() if g is not None)
                inner_start = m.start() + (m.group(0).find(span))
                inner_end = inner_start + len(span)
                mentions.append(
                    _mention(sentence, span, inner_start, inner_end, MentionSource.MARKDOWN)
                )
        return mentions


class PronounProposer(Proposer):
    name = "pronoun"

    def propose(self, sentence: Sentence, ontology: Ontology) -> list[Mention]:
        del ontology
        out: list[Mention] = []
        for m in _PRONOUN_RX.finditer(sentence.text):
            mention = _mention(sentence, m.group(0), m.start(), m.end(), MentionSource.SHAPE)
            mention.skipped_reason = "pronoun"
            out.append(mention)
        return out


def _mention(
    sentence: Sentence, text: str, local_start: int, local_end: int, source: MentionSource
) -> Mention:
    cleaned = text.strip()
    skipped = None
    if cleaned.casefold() in _PRONOUNS:
        skipped = "pronoun"
    return Mention(
        text=cleaned,
        start=sentence.start + local_start,
        end=sentence.start + local_end,
        sentence_id=sentence.id,
        heading_path=sentence.heading_path,
        source=source,
        skipped_reason=skipped,
    )


def _token_boundary(text: str, i: int, j: int) -> bool:
    left_ok = i == 0 or not text[i - 1].isalnum()
    right_ok = j == len(text) or not text[j].isalnum()
    return left_ok and right_ok


def _inside(i: int, j: int, occupied: list[tuple[int, int]]) -> bool:
    return any(not (j <= a or i >= b) for a, b in occupied)


def merge_mentions(mentions: list[Mention]) -> list[Mention]:
    """Keep longest spans; drop nested/overlapping shorter ones. Stable by start."""
    ranked = sorted(mentions, key=lambda m: (m.start, -(m.end - m.start), m.source.value))
    kept: list[Mention] = []
    for m in ranked:
        if m.skipped_reason:
            kept.append(m)
            continue
        if any(
            not k.skipped_reason
            and not (m.end <= k.start or m.start >= k.end)
            and (k.end - k.start) >= (m.end - m.start)
            for k in kept
        ):
            continue
        kept = [
            k
            for k in kept
            if k.skipped_reason
            or (m.end <= k.start or m.start >= k.end)
            or (k.end - k.start) > (m.end - m.start)
        ]
        kept.append(m)
    kept.sort(key=lambda m: (m.start, m.end))
    return kept


DEFAULT_PROPOSERS: tuple[Proposer, ...] = (
    GazetteerProposer(),
    MarkdownCueProposer(),
    PronounProposer(),
)


def propose_mentions(
    sentence: Sentence,
    ontology: Ontology,
    proposers: tuple[Proposer, ...] = DEFAULT_PROPOSERS,
) -> list[Mention]:
    raw: list[Mention] = []
    for p in proposers:
        raw.extend(p.propose(sentence, ontology))
    return merge_mentions(raw)
