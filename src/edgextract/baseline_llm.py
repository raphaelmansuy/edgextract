"""Generative JSON baseline: one chat completion per document, like EdgeQuake's LLMExtractor."""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import httpx

from edgextract.names import normalize_entity_name
from edgextract.ontology import Ontology
from edgextract.types import ExtractedEntity, ExtractedRelationship, ExtractionResult

JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)


class LLMBaselineError(Exception):
    pass


def extraction_prompt(text: str, ontology: Ontology, *, exact_spans: bool = False) -> str:
    types = ", ".join(ontology.type_ids())
    rels = ", ".join(ontology.relation_ids())
    copy = ""
    if exact_spans:
        copy = "Copy each name as a contiguous span of the document. Do not paraphrase.\n"
    return (
        "Extract named entities and relations from the document.\n"
        f"Allowed entity types: {types}\n"
        f"Allowed relation types: {rels}\n"
        "Return ONLY JSON of the form "
        '{"entities":[{"name":"...","type":"...","description":"..."}],'
        '"relationships":[{"source":"...","target":"...","type":"...","description":"..."}]}\n'
        "Use only the allowed types. Do not invent types.\n"
        f"{copy}\n"
        f"Document:\n{text}\n"
    )


def parse_llm_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    m = JSON_FENCE.search(text)
    if m:
        text = m.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LLMBaselineError(f"could not parse JSON: {raw[:300]}") from exc
    if not isinstance(data, dict):
        raise LLMBaselineError("JSON root is not an object")
    return data


def to_result(
    data: dict[str, Any],
    ontology: Ontology,
    *,
    document_id: str,
    chunk_id: str,
) -> ExtractionResult:
    type_ids = set(ontology.type_ids())
    rel_ids = set(ontology.relation_ids())
    entities: list[ExtractedEntity] = []
    seen: set[str] = set()
    for item in data.get("entities") or []:
        if not isinstance(item, dict):
            continue
        display = str(item.get("name") or "").strip()
        name = normalize_entity_name(display)
        et = str(item.get("type") or item.get("entity_type") or "OTHER").upper()
        if not name or name in seen:
            continue
        if et not in type_ids:
            continue
        seen.add(name)
        entities.append(
            ExtractedEntity(
                name=name,
                entity_type=et,
                description=str(item.get("description") or display),
                source_spans=[display],
                source_chunk_ids=[chunk_id],
                source_document_id=document_id,
                display_name=display,
            )
        )
    names = {e.name for e in entities}
    rels: list[ExtractedRelationship] = []
    for item in data.get("relationships") or data.get("relations") or []:
        if not isinstance(item, dict):
            continue
        src = normalize_entity_name(str(item.get("source") or ""))
        tgt = normalize_entity_name(str(item.get("target") or ""))
        rt = str(item.get("type") or item.get("relation_type") or "").upper()
        if not src or not tgt or src == tgt:
            continue
        if rt not in rel_ids:
            continue
        if src not in names or tgt not in names:
            continue
        rels.append(
            ExtractedRelationship(
                source=src,
                target=tgt,
                relation_type=rt,
                description=str(item.get("description") or ""),
                source_chunk_ids=[chunk_id],
                source_document_id=document_id,
            )
        )
    return ExtractionResult(
        entities=entities,
        relationships=rels,
        source_chunk_id=chunk_id,
        metadata={"parser": "llm-json", "ontology_id": ontology.id},
    )


class LLMBaseline:
    def __init__(
        self,
        model: str = "gemma4:latest",
        base_url: str = "http://localhost:11434",
        timeout: float = 180.0,
        api_key: str | None = None,
    ) -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        if api_key is None and "mistral.ai" in self.base_url:
            api_key = os.environ.get("MISTRAL_API_KEY")
        self.api_key = api_key

    def extract(
        self,
        text: str,
        ontology: Ontology,
        *,
        document_id: str = "doc",
        exact_spans: bool = False,
    ) -> ExtractionResult:
        t0 = time.time()
        prompt = extraction_prompt(text, ontology, exact_spans=exact_spans)
        url = f"{self.base_url}/v1/chat/completions"
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
        }
        headers: dict[str, str] = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            body["response_format"] = {"type": "json_object"}
        payload: dict[str, Any] | None = None
        for attempt in range(4):
            try:
                resp = httpx.post(url, json=body, headers=headers, timeout=self.timeout)
            except httpx.HTTPError as exc:
                raise LLMBaselineError(str(exc)) from exc
            if resp.status_code in {429, 503} and attempt < 3:
                time.sleep(2**attempt)
                continue
            try:
                resp.raise_for_status()
                payload = resp.json()
            except httpx.HTTPError as exc:
                raise LLMBaselineError(str(exc)) from exc
            break
        if payload is None:
            raise LLMBaselineError("no response from the chat model")
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMBaselineError(f"bad chat response: {payload!r}") from exc
        usage = payload.get("usage") or {}
        data = parse_llm_json(content or "")
        result = to_result(
            data, ontology, document_id=document_id, chunk_id=f"{document_id}-chunk-0"
        )
        result.metadata["raw_content"] = content or ""
        result.extraction_time_ms = int((time.time() - t0) * 1000)
        result.input_tokens = int(usage.get("prompt_tokens") or 0)
        result.output_tokens = int(usage.get("completion_tokens") or 0)
        result.metadata["model"] = str(payload.get("model") or self.model)
        return result
