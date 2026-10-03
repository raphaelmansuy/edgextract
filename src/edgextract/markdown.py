"""Markdown to sentences with offsets and heading path. Code fences stay data, not questions."""

from __future__ import annotations

import re
from dataclasses import dataclass

from edgextract.types import Sentence

_FRONTMATTER = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.S)
_FENCE = re.compile(r"^```.*$", re.M)
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_SENT_END = re.compile(r"([.!?]+)(?:\s+|$)")
_ABBREV = frozenset(
    {
        "mr",
        "mrs",
        "ms",
        "dr",
        "prof",
        "sr",
        "jr",
        "vs",
        "etc",
        "e.g",
        "i.e",
        "inc",
        "ltd",
        "co",
        "fig",
        "eq",
        "no",
        "vol",
        "pp",
        "al",
        "st",
        "ave",
    }
)


@dataclass
class MaskedRegion:
    start: int
    end: int
    kind: str


def strip_frontmatter(text: str) -> tuple[str, int]:
    m = _FRONTMATTER.match(text)
    if not m:
        return text, 0
    return text[m.end() :], m.end()


def fence_regions(text: str) -> list[MaskedRegion]:
    regions: list[MaskedRegion] = []
    in_fence = False
    start = 0
    for m in _FENCE.finditer(text):
        if not in_fence:
            in_fence = True
            start = m.start()
        else:
            in_fence = False
            regions.append(MaskedRegion(start, m.end(), "fence"))
    if in_fence:
        regions.append(MaskedRegion(start, len(text), "fence"))
    return regions


def in_regions(pos: int, regions: list[MaskedRegion]) -> bool:
    return any(r.start <= pos < r.end for r in regions)


def _looks_abbrev(text: str, punct_start: int) -> bool:
    i = punct_start
    while i > 0 and text[i - 1].isalpha():
        i -= 1
    token = text[i:punct_start].rstrip(".").lower()
    return token in _ABBREV


def split_sentences(text: str, *, doc_id: str = "doc") -> list[Sentence]:
    body, offset = strip_frontmatter(text)
    fences = fence_regions(body)
    heading_stack: list[tuple[int, str]] = []
    sentences: list[Sentence] = []
    idx = 0

    lines = body.splitlines(keepends=True)
    pos = 0
    para_parts: list[tuple[int, str]] = []

    def flush_para() -> None:
        nonlocal idx
        if not para_parts:
            return
        start = para_parts[0][0]
        chunk = "".join(p[1] for p in para_parts)
        path = tuple(h[1] for h in heading_stack)
        for local_start, local_end, sent in _sentences_in(chunk):
            abs_start = offset + start + local_start
            abs_end = offset + start + local_end
            stripped = sent.strip()
            if not stripped:
                continue
            sentences.append(
                Sentence(
                    id=f"{doc_id}-s{idx}",
                    text=stripped,
                    start=abs_start,
                    end=abs_end,
                    heading_path=path,
                    index=idx,
                )
            )
            idx += 1
        para_parts.clear()

    for line in lines:
        line_start = pos
        pos += len(line)
        if in_regions(line_start, fences):
            flush_para()
            continue
        hm = _HEADING.match(line.rstrip("\n"))
        if hm:
            flush_para()
            level = len(hm.group(1))
            title = hm.group(2).strip()
            heading_stack[:] = [h for h in heading_stack if h[0] < level]
            heading_stack.append((level, title))
            continue
        if line.strip() == "":
            flush_para()
            continue
        para_parts.append((line_start, line))
    flush_para()
    return sentences


def _sentences_in(chunk: str) -> list[tuple[int, int, str]]:
    out: list[tuple[int, int, str]] = []
    start = 0
    i = 0
    n = len(chunk)
    while i < n:
        ch = chunk[i]
        if ch in ".!?" and not _looks_abbrev(chunk, i):
            j = i + 1
            while j < n and chunk[j] in ".!?\"')":
                j += 1
            if j >= n or chunk[j].isspace():
                sent = chunk[start:j]
                if sent.strip():
                    out.append((start, j, sent))
                while j < n and chunk[j].isspace():
                    j += 1
                start = j
                i = j
                continue
        i += 1
    if start < n and chunk[start:].strip():
        out.append((start, n, chunk[start:]))
    return out


def heading_context(sentence: Sentence) -> str:
    if not sentence.heading_path:
        return ""
    return " > ".join(sentence.heading_path)
