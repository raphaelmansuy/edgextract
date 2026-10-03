"""HTTP client for Ollama POST /v1/systemone. Fail closed on a bad answer."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from edgextract.types import SystemOneResponse

DEFAULT_BASE_URL = "http://localhost:11434"
SYSTEMONE_PATH = "/v1/systemone"
PROB_SUM_TOLERANCE = 0.05


class SystemOneError(Exception):
    """Transport or contract failure. The caller must not invent an answer."""


class Transport(Protocol):
    def post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST JSON and return a parsed object, or raise SystemOneError."""


class HttpxTransport:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._owns = client is None
        self._client = client or httpx.Client(base_url=self.base_url, timeout=timeout)

    def post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            resp = self._client.post(path, json=body)
        except httpx.HTTPError as exc:
            raise SystemOneError(f"transport: {exc}") from exc
        if resp.status_code >= 400:
            snippet = resp.text[:400]
            raise SystemOneError(f"http {resp.status_code}: {snippet}")
        try:
            data = resp.json()
        except json.JSONDecodeError as exc:
            raise SystemOneError(f"non-json body: {resp.text[:200]}") from exc
        if not isinstance(data, dict):
            raise SystemOneError("response is not an object")
        return data

    def close(self) -> None:
        if self._owns:
            self._client.close()


def build_choice_question(instructions: str, criteria: Mapping[str, str]) -> dict[str, Any]:
    if not (2 <= len(criteria) <= 26):
        raise SystemOneError(f"choice needs 2..26 options, got {len(criteria)}")
    return {
        "type": "choice",
        "instructions": instructions,
        "criteria": dict(criteria),
    }


def build_noul_question(
    instructions: str, false_desc: str | None = None, true_desc: str | None = None
) -> dict[str, Any]:
    q: dict[str, Any] = {"type": "noul", "instructions": instructions}
    if false_desc is not None or true_desc is not None:
        q["criteria"] = {
            "false": false_desc or "No",
            "true": true_desc or "Yes",
        }
    return q


def build_score_question(instructions: str, levels: list[str]) -> dict[str, Any]:
    if not (2 <= len(levels) <= 26):
        raise SystemOneError(f"score needs 2..26 levels, got {len(levels)}")
    return {"type": "score", "instructions": instructions, "criteria": list(levels)}


def reverse_criteria(criteria: Mapping[str, str]) -> dict[str, str]:
    items = list(criteria.items())
    items.reverse()
    return dict(items)


def validate_response(
    data: dict[str, Any], expected_ids: list[str] | None = None
) -> SystemOneResponse:
    if "error" in data and "answers" not in data:
        raise SystemOneError(f"server error: {data['error']}")
    model = data.get("model")
    answers = data.get("answers")
    if not isinstance(model, str) or not model:
        raise SystemOneError("missing model")
    if not isinstance(answers, dict):
        raise SystemOneError("missing answers object")
    if expected_ids is not None:
        missing = [i for i in expected_ids if i not in answers]
        if missing:
            raise SystemOneError(f"missing answers: {missing}")
    for qid, ans in answers.items():
        if not isinstance(ans, dict):
            raise SystemOneError(f"answer {qid} is not an object")
        kind = ans.get("type")
        if kind == "choice":
            _validate_choice(qid, ans)
        elif kind == "noul":
            _validate_noul(qid, ans)
        elif kind == "score":
            _validate_score(qid, ans)
        else:
            raise SystemOneError(f"answer {qid} has unknown type {kind!r}")
    usage_raw = data.get("usage") or {}
    usage = {
        "input_tokens": int(usage_raw.get("input_tokens") or 0),
        "output_tokens": int(usage_raw.get("output_tokens") or 0),
    }
    return SystemOneResponse(model=model, answers=answers, usage=usage)


def _validate_choice(qid: str, ans: dict[str, Any]) -> None:
    choice = ans.get("choice")
    probs = ans.get("probabilities")
    if not isinstance(choice, str) or not choice:
        raise SystemOneError(f"{qid}: missing choice")
    if not isinstance(probs, dict) or not probs:
        raise SystemOneError(f"{qid}: missing probabilities")
    if choice not in probs:
        raise SystemOneError(f"{qid}: choice {choice!r} not in probabilities keys")
    values = []
    for k, v in probs.items():
        try:
            values.append(float(v))
        except (TypeError, ValueError) as exc:
            raise SystemOneError(f"{qid}: bad probability for {k}") from exc
    total = sum(values)
    if abs(total - 1.0) > PROB_SUM_TOLERANCE:
        raise SystemOneError(f"{qid}: probabilities sum to {total}, not 1")
    conf = ans.get("confidence")
    if conf is not None:
        try:
            c = float(conf)
        except (TypeError, ValueError) as exc:
            raise SystemOneError(f"{qid}: bad confidence") from exc
        if not 0.0 <= c <= 1.0:
            raise SystemOneError(f"{qid}: confidence out of range")


def _validate_noul(qid: str, ans: dict[str, Any]) -> None:
    noul = ans.get("noul")
    try:
        p = float(noul)
    except (TypeError, ValueError) as exc:
        raise SystemOneError(f"{qid}: missing noul") from exc
    if not 0.0 <= p <= 1.0:
        raise SystemOneError(f"{qid}: noul out of range")


def _validate_score(qid: str, ans: dict[str, Any]) -> None:
    try:
        float(ans.get("score"))
    except (TypeError, ValueError) as exc:
        raise SystemOneError(f"{qid}: missing score") from exc


class SystemOneClient:
    def __init__(
        self,
        model: str = "nimble",
        transport: Transport | None = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
    ) -> None:
        self.model = model
        self.transport = transport or HttpxTransport(base_url=base_url, timeout=timeout)

    def decide(
        self,
        state: str | dict[str, Any],
        questions: dict[str, dict[str, Any]],
        images: list[str] | None = None,
    ) -> SystemOneResponse:
        if not questions:
            raise SystemOneError("questions must not be empty")
        body: dict[str, Any] = {
            "model": self.model,
            "state": state,
            "questions": questions,
        }
        if images:
            body["images"] = images
        data = self.transport.post_json(SYSTEMONE_PATH, body)
        return validate_response(data, expected_ids=list(questions))
