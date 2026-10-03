"""Convert the SpERT CoNLL04 JSON into span-labeled gold for edgextract."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ENTITY_TYPE_MAP = {
    "Peop": "PERSON",
    "Org": "ORGANIZATION",
    "Loc": "LOCATION",
    "Other": "OTHER",
}

RELATION_TYPE_MAP = {
    "Work_For": "WORKS_FOR",
    "Kill": "KILL",
    "OrgBased_In": "ORG_BASED_IN",
    "Live_In": "LIVES_IN",
    "Located_In": "LOCATED_IN",
}

EXPECTED_DOMAIN_RANGE = {
    "WORKS_FOR": ("PERSON", "ORGANIZATION"),
    "KILL": ("PERSON", "PERSON"),
    "ORG_BASED_IN": ("ORGANIZATION", "LOCATION"),
    "LIVES_IN": ("PERSON", "LOCATION"),
    "LOCATED_IN": ("LOCATION", "LOCATION"),
}


def token_char_spans(tokens: list[str]) -> list[tuple[int, int]]:
    """Character spans for tokens joined with a single space."""
    spans: list[tuple[int, int]] = []
    pos = 0
    for i, tok in enumerate(tokens):
        start = pos
        end = pos + len(tok)
        spans.append((start, end))
        pos = end + (1 if i + 1 < len(tokens) else 0)
    return spans


def tokens_to_text(tokens: list[str]) -> str:
    return " ".join(tokens)


def load_raw_split(path: str | Path) -> list[dict[str, Any]]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"expected a list of documents in {path}")
    return data


def convert_document(raw: dict[str, Any], *, doc_id: str | None = None) -> dict[str, Any]:
    tokens = list(raw["tokens"])
    text = tokens_to_text(tokens)
    char_spans = token_char_spans(tokens)
    entities_raw = list(raw.get("entities") or [])
    entities: list[dict[str, Any]] = []
    for idx, ent in enumerate(entities_raw):
        t_start = int(ent["start"])
        t_end = int(ent["end"])
        if t_start < 0 or t_end > len(tokens) or t_start >= t_end:
            raise ValueError(f"bad entity token span {ent} in {doc_id}")
        c_start = char_spans[t_start][0]
        c_end = char_spans[t_end - 1][1]
        surface = text[c_start:c_end]
        etype = ENTITY_TYPE_MAP[ent["type"]]
        entities.append(
            {
                "name": surface,
                "type": etype,
                "start": c_start,
                "end": c_end,
                "token_start": t_start,
                "token_end": t_end,
                "index": idx,
            }
        )

    relations: list[dict[str, Any]] = []
    for rel in raw.get("relations") or []:
        head_i = int(rel["head"])
        tail_i = int(rel["tail"])
        head = entities[head_i]
        tail = entities[tail_i]
        rtype = RELATION_TYPE_MAP[rel["type"]]
        expected = EXPECTED_DOMAIN_RANGE[rtype]
        actual = (head["type"], tail["type"])
        if actual != expected:
            raise ValueError(
                f"domain/range violation for {rtype}: expected {expected}, got {actual} "
                f"in doc {doc_id or raw.get('orig_id')}"
            )
        relations.append(
            {
                "source": head["name"],
                "target": tail["name"],
                "type": rtype,
                "source_start": head["start"],
                "source_end": head["end"],
                "target_start": tail["start"],
                "target_end": tail["end"],
                "head": head_i,
                "tail": tail_i,
            }
        )

    return {
        "id": doc_id or str(raw.get("orig_id", "doc")),
        "text": text,
        "tokens": tokens,
        "entities": entities,
        "relations": relations,
        "orig_id": raw.get("orig_id"),
    }


def convert_split(raw_docs: list[dict[str, Any]], *, split: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, raw in enumerate(raw_docs):
        doc_id = f"{split}_{i:04d}"
        out.append(convert_document(raw, doc_id=doc_id))
    return out


def default_raw_path(split: str, root: str | Path | None = None) -> Path:
    base = (
        Path(root)
        if root
        else Path(__file__).resolve().parents[3] / "data" / "benchmarks" / "conll04"
    )
    return base / f"conll04_{split}.json"


def load_converted_split(split: str, root: str | Path | None = None) -> list[dict[str, Any]]:
    return convert_split(load_raw_split(default_raw_path(split, root)), split=split)
