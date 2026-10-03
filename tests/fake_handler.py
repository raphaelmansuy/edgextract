"""Fake /v1/systemone that types gazetteer names and respects simple negation. REQ-3."""

from __future__ import annotations

import re
from typing import Any

from edgextract.ontology import NO_RELATION, NOT_ENTITY, Ontology


def gazetteer_handler(ontology: Ontology):
    gaz = {k.casefold(): v for k, v in ontology.gazetteer.items()}

    def handle(body: dict[str, Any]) -> dict[str, Any]:
        state = body.get("state") or ""
        if isinstance(state, dict):
            state = " ".join(str(v) for v in state.values())
        questions = body.get("questions") or {}
        answers = {}
        for qid, q in questions.items():
            kind = q.get("type")
            if kind == "choice":
                answers[qid] = _choice(q, state, gaz)
            elif kind == "noul":
                answers[qid] = {"type": "noul", "noul": _noul(state)}
            elif kind == "score":
                answers[qid] = {"type": "score", "score": 0.5}
            else:
                raise ValueError(f"bad type {kind}")
        return {
            "model": body.get("model") or "fake",
            "answers": answers,
            "usage": {"input_tokens": 20, "output_tokens": 1},
        }

    return handle


def _noul(state: str) -> float:
    if re.search(r"\b(not|never|n't|might|could|maybe|perhaps)\b", state, re.I):
        return 0.05
    return 0.95


def _choice(q: dict[str, Any], state: str, gaz: dict[str, str]) -> dict[str, Any]:
    criteria: dict[str, str] = q.get("criteria") or {}
    instr = (q.get("instructions") or "") + " "
    negated = bool(re.search(r"\b(not|never|n't|no)\b", state, re.I))
    hedged = bool(re.search(r"\b(might|could|maybe|perhaps)\b", state, re.I))
    if NO_RELATION in criteria:
        keys = list(criteria)
        if negated or hedged:
            winner = NO_RELATION
        else:
            winner = next((k for k in keys if k != NO_RELATION), NO_RELATION)
        return _dist(winner, keys, confidence=0.85)
    mention = _mention_from_instructions(instr)
    mapped = gaz.get(mention.casefold()) if mention else None
    if mapped and mapped in criteria:
        return _dist(mapped, list(criteria), confidence=0.9)
    if mention and mention.casefold() in {"she", "he", "they", "it", "them"}:
        return _dist(NOT_ENTITY, list(criteria), confidence=0.8)
    if NOT_ENTITY in criteria:
        # Title-case leftover → OTHER-ish: pick first real type if gazetteer-like
        if mention and mention[:1].isupper() and " " in mention:
            pick = next((k for k in criteria if k != NOT_ENTITY), NOT_ENTITY)
            return _dist(pick, list(criteria), confidence=0.55)
        return _dist(NOT_ENTITY, list(criteria), confidence=0.7)
    winner = next(iter(criteria))
    return _dist(winner, list(criteria), confidence=0.5)


def _mention_from_instructions(instr: str) -> str:
    m = re.search(r"mention \[\d+\] \('([^']+)'\)", instr)
    if m:
        return m.group(1)
    m = re.search(r"\('([^']+)'", instr)
    if m:
        return m.group(1)
    return ""


def _dist(winner: str, keys: list[str], confidence: float) -> dict[str, Any]:
    rest = [k for k in keys if k != winner]
    mass = 0.92
    leftover = (1.0 - mass) / max(len(rest), 1)
    probs = {winner: mass}
    for k in rest:
        probs[k] = leftover
    # fix float
    s = sum(probs.values())
    probs[winner] += 1.0 - s
    return {
        "type": "choice",
        "choice": winner,
        "probabilities": probs,
        "confidence": confidence,
    }
