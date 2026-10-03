"""Turn mentions and pairs into closed System One questions."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from edgextract.gate import GateConfig
from edgextract.ontology import NO_RELATION, NOT_ENTITY, Ontology
from edgextract.systemone import (
    SystemOneClient,
    SystemOneError,
    build_choice_question,
    build_noul_question,
    reverse_criteria,
)
from edgextract.types import (
    ChoiceAnswer,
    GateBand,
    Mention,
    RelationHit,
    Sentence,
    TypedMention,
)

MAX_QUESTIONS_PER_CALL = 12
MAX_PAIRS_PER_SENTENCE = 24


class CachedClient:
    """Wrap SystemOneClient with an optional SQLite cache."""

    def __init__(
        self,
        inner: SystemOneClient,
        get_put: tuple[Callable[[str], dict | None], Callable[[str, str, dict], None]]
        | None = None,
        key_fn: Callable[..., str] | None = None,
    ) -> None:
        self.inner = inner
        self._get_put = get_put
        self._key_fn = key_fn
        self.calls = 0
        self.cache_hits = 0
        self.input_tokens = 0
        self.output_tokens = 0

    def decide(self, state: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
        from edgextract.cache import request_key

        key = request_key(self.inner.model, state, questions, None)
        if self._get_put:
            cached = self._get_put[0](key)
            if cached is not None:
                self.cache_hits += 1
                return cached
        resp = self.inner.decide(state, questions)
        payload = resp.model_dump()
        self.calls += 1
        self.input_tokens += resp.usage.input_tokens
        self.output_tokens += resp.usage.output_tokens
        if self._get_put:
            self._get_put[1](key, self.inner.model, payload)
        return payload


def type_mentions(
    sentence: Sentence,
    mentions: list[Mention],
    ontology: Ontology,
    client: CachedClient,
    gate: GateConfig,
) -> list[TypedMention]:
    """Known names are a lookup. Unknown spans abstain with Noul, then Choice over types."""
    live = [m for m in mentions if not m.skipped_reason]
    typed: list[TypedMention] = []
    unknown: list[tuple[int, Mention]] = []
    for i, mention in enumerate(live):
        declared = ontology.gazetteer_type(mention.text)
        if declared:
            typed.append(
                TypedMention(
                    mention=mention,
                    entity_type=declared,
                    probabilities={declared: 1.0},
                    confidence=1.0,
                    band=GateBand.ACCEPT,
                    winner_prob=1.0,
                    question_id=f"g{i}",
                    decided_by="ontology",
                )
            )
        else:
            unknown.append((i, mention))
    if not unknown:
        return typed

    state = _state_for_mentions(sentence, [m for _, m in unknown])
    for batch in _chunks(unknown, MAX_QUESTIONS_PER_CALL):
        questions = {
            f"e{i}": build_noul_question(
                f"Is mention ({mention.text!r}) a named entity of this ontology? "
                "A pronoun, a common word, or a negated mention is no.",
                false_desc="Not a named entity in this ontology.",
                true_desc="A named entity this ontology can type.",
            )
            for i, mention in batch
        }
        payload = client.decide(state, questions)
        survivors: list[tuple[int, Mention, float]] = []
        for i, mention in batch:
            p_yes = _as_noul(payload["answers"][f"e{i}"])
            band = gate.band_noul(p_yes)
            if band is not GateBand.ACCEPT:
                typed.append(
                    TypedMention(
                        mention=mention,
                        entity_type=NOT_ENTITY,
                        probabilities={"yes": p_yes, "no": 1.0 - p_yes},
                        band=band,
                        winner_prob=p_yes,
                        question_id=f"e{i}",
                    )
                )
            else:
                survivors.append((i, mention, p_yes))
        if not survivors:
            continue
        criteria = _type_only_criteria(ontology)
        choice_qs = {
            f"t{i}": build_choice_question(
                f"Which ontology type is mention ({mention.text!r})?",
                criteria,
            )
            for i, mention, _p in survivors
        }
        chosen = client.decide(state, choice_qs)
        for i, mention, p_yes in survivors:
            ans, flipped = _choice_with_optional_rotation(
                client, state, f"t{i}", choice_qs[f"t{i}"], chosen["answers"][f"t{i}"], gate
            )
            if str(ans.choice).startswith("GROUP_"):
                ans, extra = _refine_group(client, state, f"t{i}", mention, ontology, ans)
                flipped = flipped or extra
            winner_p = float(ans.probabilities.get(ans.choice, 0.0))
            band = gate.band_choice(
                ans.choice,
                winner_p,
                ans.confidence,
                null_labels=frozenset(),
                flipped=flipped,
            )
            typed.append(
                TypedMention(
                    mention=mention,
                    entity_type=ans.choice if band is not GateBand.REJECT else NOT_ENTITY,
                    probabilities=ans.probabilities,
                    confidence=ans.confidence,
                    band=band if band is not GateBand.REJECT else GateBand.REVIEW,
                    winner_prob=min(p_yes, winner_p),
                    flipped=flipped,
                    question_id=f"t{i}",
                )
            )
    return typed


def relate_pairs(
    sentence: Sentence,
    typed: list[TypedMention],
    ontology: Ontology,
    client: CachedClient,
    gate: GateConfig,
    max_pairs: int = MAX_PAIRS_PER_SENTENCE,
) -> tuple[list[RelationHit], int]:
    accepted = [t for t in typed if t.band is GateBand.ACCEPT and t.entity_type != NOT_ENTITY]
    pairs: list[tuple[TypedMention, TypedMention, dict[str, str]]] = []
    truncated = 0
    for src in accepted:
        for tgt in accepted:
            if src is tgt:
                continue
            if src.mention.start == tgt.mention.start and src.mention.end == tgt.mention.end:
                continue
            criteria = ontology.relation_choice_criteria(src.entity_type, tgt.entity_type)
            if set(criteria.keys()) == {NO_RELATION}:
                continue
            if len(pairs) >= max_pairs:
                truncated += 1
                continue
            pairs.append((src, tgt, criteria))
    if not pairs:
        return [], truncated

    predicates: list[tuple[TypedMention, TypedMention, str, str]] = []
    for src, tgt, criteria in pairs:
        for rel_id, description in criteria.items():
            if rel_id == NO_RELATION:
                continue
            predicates.append((src, tgt, rel_id, description))

    hits: list[RelationHit] = []
    state = _state_for_pairs(sentence, accepted)
    for batch in _chunks(predicates, MAX_QUESTIONS_PER_CALL):
        noul_qs: dict[str, dict[str, Any]] = {}
        for i, (src, tgt, rel_id, description) in enumerate(batch):
            noul_qs[f"n{i}"] = build_noul_question(
                f"Does {rel_id} hold from {src.mention.text!r} to {tgt.mention.text!r}? "
                f"{description} "
                "Negation and mere possibility are no.",
                false_desc=f"The sentence does not assert {rel_id} in this direction.",
                true_desc=f"The sentence asserts {rel_id} from the first mention to the second.",
            )
        payload = client.decide(state, noul_qs)
        for i, (src, tgt, rel_id, _description) in enumerate(batch):
            p_yes = _as_noul(payload["answers"][f"n{i}"])
            band = gate.band_noul(p_yes)
            if band is GateBand.ACCEPT:
                hits.append(_hit(src, tgt, rel_id, sentence, band, p_yes, {rel_id: p_yes}, None))
            else:
                hits.append(
                    _hit(src, tgt, NO_RELATION, sentence, band, p_yes, {NO_RELATION: p_yes}, None)
                )
    return hits, truncated


def _type_only_criteria(ontology: Ontology) -> dict[str, str]:
    criteria = _typing_criteria(ontology)
    return {k: v for k, v in criteria.items() if k != NOT_ENTITY}


def _typing_criteria(ontology: Ontology) -> dict[str, str]:
    if ontology.needs_two_stage_typing():
        return ontology.group_choice_criteria()
    return ontology.type_choice_criteria()


def _choice_with_optional_rotation(
    client: CachedClient,
    state: str,
    qid: str,
    question: dict[str, Any],
    raw: dict[str, Any],
    gate: GateConfig,
) -> tuple[ChoiceAnswer, bool]:
    ans = _as_choice(raw)
    if not gate.needs_rotation(ans.confidence):
        return ans, False
    rotated = {
        qid: build_choice_question(question["instructions"], reverse_criteria(question["criteria"]))
    }
    second = _as_choice(client.decide(state, rotated)["answers"][qid])
    if second.choice != ans.choice:
        return second, True
    return ans, False


def _as_noul(raw: dict[str, Any]) -> float:
    if raw.get("type") != "noul":
        raise SystemOneError(f"expected noul, got {raw.get('type')}")
    return float(raw["noul"])


def _hit(
    src: TypedMention,
    tgt: TypedMention,
    relation: str,
    sentence: Sentence,
    band: GateBand,
    winner_prob: float,
    probabilities: dict[str, float],
    confidence: float | None,
    flipped: bool = False,
) -> RelationHit:
    return RelationHit(
        source_text=src.mention.text,
        source_type=src.entity_type,
        source_start=src.mention.start,
        source_end=src.mention.end,
        target_text=tgt.mention.text,
        target_type=tgt.entity_type,
        target_start=tgt.mention.start,
        target_end=tgt.mention.end,
        relation_type=relation,
        probabilities=probabilities,
        confidence=confidence,
        band=band,
        winner_prob=winner_prob,
        flipped=flipped,
        sentence_id=sentence.id,
        heading_path=sentence.heading_path,
        evidence=sentence.text,
    )


def _refine_group(
    client: CachedClient,
    state: str,
    qid: str,
    mention: Mention,
    ontology: Ontology,
    first: ChoiceAnswer,
) -> tuple[ChoiceAnswer, bool]:
    try:
        idx = int(first.choice.split("_")[1])
    except (IndexError, ValueError):
        return first, False
    groups = ontology.type_groups()
    if idx < 0 or idx >= len(groups):
        return first, False
    criteria = {t.id: t.description for t in groups[idx]}
    criteria[NOT_ENTITY] = "Not a named entity of this ontology, or a pronoun, or noise."
    questions = {
        qid: build_choice_question(
            f"Which type in this group is mention ({mention.text!r})? Pick NOT_ENTITY if none.",
            criteria,
        )
    }
    payload = client.decide(state, questions)
    return _as_choice(payload["answers"][qid]), False


def _as_choice(raw: dict[str, Any]) -> ChoiceAnswer:
    if raw.get("type") != "choice":
        raise SystemOneError(f"expected choice, got {raw.get('type')}")
    return ChoiceAnswer(
        type="choice",
        choice=str(raw["choice"]),
        probabilities={k: float(v) for k, v in raw["probabilities"].items()},
        confidence=None if raw.get("confidence") is None else float(raw["confidence"]),
    )


def _state_for_mentions(sentence: Sentence, mentions: list[Mention]) -> str:
    heading = " > ".join(sentence.heading_path) if sentence.heading_path else "(none)"
    lines = [
        f"Heading: {heading}",
        f"Sentence: {sentence.text}",
        "Mentions:",
    ]
    for i, m in enumerate(mentions):
        lines.append(f"  [{i}] {m.text}")
    return "\n".join(lines)


def _state_for_pairs(sentence: Sentence, typed: list[TypedMention]) -> str:
    heading = " > ".join(sentence.heading_path) if sentence.heading_path else "(none)"
    lines = [
        f"Heading: {heading}",
        f"Sentence: {sentence.text}",
        "Typed mentions:",
    ]
    for i, t in enumerate(typed):
        lines.append(f"  [{i}] {t.mention.text} ({t.entity_type})")
    return "\n".join(lines)


def _chunks[T](items: list[T], size: int) -> list[list[T]]:
    return [items[i : i + size] for i in range(0, len(items), size)]
