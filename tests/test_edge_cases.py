"""EC-11 EC-12 EC-13 REQ-10 REQ-9 pair cap, two-stage types, opaque names, report."""

from pathlib import Path

from tests.fake_handler import gazetteer_handler

from edgextract.assemble import assemble
from edgextract.ontology import ontology_from_dict
from edgextract.pipeline import Extractor
from edgextract.report import render_html
from edgextract.systemone import SystemOneClient
from edgextract.testing import start_fake_systemone
from edgextract.types import (
    ExtractedEntity,
    GateBand,
    Mention,
    MentionSource,
    TypedMention,
)


def test_pair_cap_reports_truncated(ontology):
    url, stop = start_fake_systemone(gazetteer_handler(ontology))
    try:
        client = SystemOneClient(model="n", base_url=url, timeout=5)
        ext = Extractor(ontology, client, max_pairs=1)
        text = (
            Path(__file__)
            .resolve()
            .parents[1]
            .joinpath("data/golden/docs/01_edgequake.md")
            .read_text()
        )
        result = ext.extract_markdown(text)
        assert result.metadata["stats"]["pairs_truncated"] >= 1
    finally:
        stop()


def test_two_stage_typing_does_not_raise():
    types = [{"id": f"T{i:02d}", "description": f"type {i}"} for i in range(30)]
    ont = ontology_from_dict(
        {
            "id": "wide",
            "types": types,
            "relations": [
                {
                    "id": "REL",
                    "description": "r",
                    "domain": ["T00"],
                    "range": ["T01"],
                }
            ],
        }
    )
    assert ont.needs_two_stage_typing()
    groups = ont.group_choice_criteria()
    assert "NOT_ENTITY" in groups
    assert len(groups) <= 26


def test_opaque_name_rejected():
    mention = Mention(
        text="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        start=0,
        end=32,
        sentence_id="s",
        source=MentionSource.SHAPE,
    )
    tm = TypedMention(
        mention=mention,
        entity_type="PERSON",
        band=GateBand.ACCEPT,
        winner_prob=0.9,
        probabilities={"PERSON": 0.9},
    )
    ont = ontology_from_dict(
        {
            "id": "x",
            "types": [
                {"id": "PERSON", "description": "p"},
                {"id": "ORG", "description": "o"},
            ],
            "relations": [],
        }
    )
    result = assemble([tm], [], ont, document_id="d", chunk_id="c")
    assert result.entities == []
    assert any(x.get("reason") == "opaque_or_empty_name" for x in result.rejected)


def test_report_contains_review_and_legend(ontology):
    result = Extractor.__new__(Extractor)
    from edgextract.types import ExtractionResult

    html = render_html(
        "Jane Doe joined Acme Inc.",
        ExtractionResult(
            entities=[
                ExtractedEntity(
                    name="JANE_DOE",
                    entity_type="PERSON",
                    description="Jane Doe",
                    display_name="Jane Doe",
                )
            ],
            review=[{"kind": "entity", "text": "maybe"}],
            metadata={"model": "nimble", "stats": {"systemone_calls": 1}, "gate_fitted": False},
            mentions=[
                TypedMention(
                    mention=Mention(
                        text="Jane Doe",
                        start=0,
                        end=8,
                        sentence_id="s",
                        source=MentionSource.GAZETTEER,
                    ),
                    entity_type="PERSON",
                    band=GateBand.ACCEPT,
                    winner_prob=0.9,
                )
            ],
        ),
        ontology,
        title="Demo",
    )
    assert "Jane Doe" in html
    assert "Review" in html
    assert "person" in html
    assert "Check whether" in html
    assert "{'kind'" not in html
    assert "unpkg" not in html
    assert "jsdelivr" not in html
    assert "cdnjs" not in html
    assert "Knowledge graph" in html
    del result
