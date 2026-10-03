"""CoNLL04 conversion, span scoring, and encoder proposer (no Hub download)."""

from __future__ import annotations

import json
from pathlib import Path

from edgextract.benchmarks.conll04 import (
    EXPECTED_DOMAIN_RANGE,
    convert_document,
    convert_split,
    load_raw_split,
    token_char_spans,
    tokens_to_text,
)
from edgextract.benchmarks.llm_run import attach_spans, find_occurrences
from edgextract.candidates import GazetteerProposer, propose_mentions
from edgextract.eval import gold_has_spans, score_spans
from edgextract.ontology import load_ontology
from edgextract.pipeline import Extractor
from edgextract.span_encoder import EncoderProposer, FixedSpanEncoder
from edgextract.testing import start_fake_systemone
from edgextract.types import (
    ExtractedEntity,
    ExtractedRelationship,
    ExtractionResult,
    GateBand,
    Mention,
    MentionSource,
    RelationHit,
    Sentence,
    TypedMention,
)

FIXTURE = Path(__file__).parent / "fixtures" / "conll04_sample.json"
ONTOLOGY = Path(__file__).resolve().parents[1] / "data" / "ontology" / "conll04.yaml"


def test_token_char_spans_roundtrip():
    tokens = ["John", "Wilkes", "Booth"]
    text = tokens_to_text(tokens)
    spans = token_char_spans(tokens)
    assert text == "John Wilkes Booth"
    assert spans == [(0, 4), (5, 11), (12, 17)]
    assert text[spans[0][0] : spans[2][1]] == "John Wilkes Booth"


def test_convert_fixture_domain_range():
    raw = load_raw_split(FIXTURE)
    docs = convert_split(raw, split="sample")
    assert len(docs) == 3
    for doc in docs:
        assert gold_has_spans(doc)
        for rel in doc["relations"]:
            head = next(e for e in doc["entities"] if e["start"] == rel["source_start"])
            tail = next(e for e in doc["entities"] if e["start"] == rel["target_start"])
            assert (head["type"], tail["type"]) == EXPECTED_DOMAIN_RANGE[rel["type"]]
            assert doc["text"][rel["source_start"] : rel["source_end"]] == rel["source"]
            assert doc["text"][rel["target_start"] : rel["target_end"]] == rel["target"]


def test_conll04_ontology_empty_gazetteer():
    ont = load_ontology(ONTOLOGY)
    assert ont.gazetteer == {}
    assert set(ont.type_ids()) == {"PERSON", "ORGANIZATION", "LOCATION", "OTHER"}
    assert "WORKS_FOR" in ont.relation_ids()


def test_encoder_proposer_emits_mentions():
    ont = load_ontology(ONTOLOGY)
    text = "Jane Doe joined Acme Inc in Berlin."
    sent = Sentence(id="s0", text=text, start=0, end=len(text), index=0)
    encoder = FixedSpanEncoder(
        [
            (0, 8, 0.99),
            (16, 24, 0.95),
            (28, 34, 0.9),
        ]
    )
    mentions = propose_mentions(
        sent,
        ont,
        proposers=(GazetteerProposer(), EncoderProposer(encoder, threshold=0.5)),
    )
    surfaces = [m.text for m in mentions if not m.skipped_reason]
    assert surfaces == ["Jane Doe", "Acme Inc", "Berlin"]
    assert all(m.source is MentionSource.ENCODER for m in mentions if not m.skipped_reason)


def test_score_spans_exact_and_boundary():
    gold = {
        "entities": [
            {"name": "Jane Doe", "type": "PERSON", "start": 0, "end": 8},
            {"name": "Berlin", "type": "LOCATION", "start": 20, "end": 26},
        ],
        "relations": [
            {
                "source": "Jane Doe",
                "target": "Berlin",
                "type": "LIVES_IN",
                "source_start": 0,
                "source_end": 8,
                "target_start": 20,
                "target_end": 26,
            }
        ],
    }
    mentions = [
        TypedMention(
            mention=Mention(
                text="Jane Doe",
                start=0,
                end=8,
                sentence_id="s0",
                source=MentionSource.ENCODER,
            ),
            entity_type="PERSON",
            band=GateBand.ACCEPT,
            winner_prob=1.0,
        ),
        TypedMention(
            mention=Mention(
                text="Berlin",
                start=20,
                end=26,
                sentence_id="s0",
                source=MentionSource.ENCODER,
            ),
            entity_type="ORGANIZATION",  # wrong type, right span
            band=GateBand.ACCEPT,
            winner_prob=0.9,
        ),
    ]
    hits = [
        RelationHit(
            source_text="Jane Doe",
            source_type="PERSON",
            source_start=0,
            source_end=8,
            target_text="Berlin",
            target_type="ORGANIZATION",
            target_start=20,
            target_end=26,
            relation_type="LIVES_IN",
            band=GateBand.ACCEPT,
            winner_prob=0.8,
            sentence_id="s0",
        )
    ]
    pred = ExtractionResult(mentions=mentions, relation_hits=hits)
    scored = score_spans(pred, gold)
    assert scored["entities"]["tp"] == 1.0
    assert scored["entities"]["fp"] == 1.0
    assert scored["boundary_only"] == 1.0
    assert scored["relations"]["tp"] == 1.0


def test_pipeline_with_fixed_encoder():
    ont = load_ontology(ONTOLOGY)
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[1]
    doc = convert_document(raw, doc_id="sample")
    text = doc["text"]
    spans = [(e["start"], e["end"], 0.99) for e in doc["entities"]]
    encoder = FixedSpanEncoder(spans)

    def handler(body):
        questions = body.get("questions") or {}
        answers = {}
        for qid, q in questions.items():
            if q["type"] == "noul":
                answers[qid] = {"type": "noul", "noul": 0.95}
            else:
                criteria = list(q["criteria"])
                pick = criteria[0]
                for key in ("PERSON", "WORKS_FOR", "ORGANIZATION"):
                    if key in q["criteria"]:
                        pick = key
                        break
                probs = {
                    k: (0.9 if k == pick else 0.1 / max(1, len(criteria) - 1)) for k in criteria
                }
                answers[qid] = {
                    "type": "choice",
                    "choice": pick,
                    "probabilities": probs,
                    "confidence": 0.9,
                }
        return {
            "model": "fake",
            "answers": answers,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    from edgextract.systemone import SystemOneClient

    url, stop = start_fake_systemone(handler)
    try:
        client = SystemOneClient(model="fake", base_url=url, timeout=5.0)
        extractor = Extractor(
            ontology=ont,
            client=client,
            proposers=(EncoderProposer(encoder),),
        )
        sent = Sentence(id="s0", text=text, start=0, end=len(text), index=0)
        result = extractor.extract_sentences(
            [sent], document_id=doc["id"], chunk_id=f"{doc['id']}-0"
        )
        scored = score_spans(result, doc)
        assert scored["entities"]["recall"] > 0.0
        assert scored["pred_entity_spans"] >= 1.0
    finally:
        stop()


def test_llm_names_land_on_whole_words():
    text = "Anne met Ann in Berlin."
    assert find_occurrences(text, "Ann") == [(9, 12)]
    assert find_occurrences(text, "anne") == [(0, 4)]
    result = ExtractionResult(
        entities=[
            ExtractedEntity(
                name="ANN",
                entity_type="PERSON",
                description="Ann",
                display_name="Ann",
            ),
            ExtractedEntity(
                name="BERLIN",
                entity_type="LOCATION",
                description="Berlin",
                display_name="Berlin",
            ),
            ExtractedEntity(
                name="ZIGGY",
                entity_type="PERSON",
                description="Ziggy",
                display_name="Ziggy",
            ),
        ],
        relationships=[
            ExtractedRelationship(
                source="ANN",
                target="BERLIN",
                relation_type="LIVES_IN",
                description="",
            )
        ],
    )
    attached = attach_spans(result, text, document_id="d")
    scored = score_spans(
        attached,
        {
            "entities": [
                {"name": "Ann", "type": "PERSON", "start": 9, "end": 12},
                {"name": "Berlin", "type": "LOCATION", "start": 16, "end": 22},
            ],
            "relations": [
                {
                    "source": "Ann",
                    "target": "Berlin",
                    "type": "LIVES_IN",
                    "source_start": 9,
                    "source_end": 12,
                    "target_start": 16,
                    "target_end": 22,
                }
            ],
        },
    )
    assert scored["entities"]["tp"] == 2.0
    assert scored["entities"]["fp"] == 1.0
    assert scored["relations"]["tp"] == 1.0
