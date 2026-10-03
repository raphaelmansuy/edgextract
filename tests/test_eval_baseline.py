"""REQ-9 extractive JSON baseline scoring."""

from edgextract.baseline_llm import parse_llm_json, to_result
from edgextract.eval import prf, score_result
from edgextract.types import ExtractedEntity, ExtractedRelationship, ExtractionResult


def test_parse_fenced_and_raw():
    data = parse_llm_json('```json\n{"entities":[], "relationships":[]}\n```')
    assert data["entities"] == []
    data = parse_llm_json(
        'noise {"entities":[{"name":"A","type":"PRODUCT"}], "relationships":[]} trailing'
    )
    assert data["entities"][0]["name"] == "A"


def test_score_and_to_result(ontology):
    pred = ExtractionResult(
        entities=[
            ExtractedEntity(name="JANE_DOE", entity_type="PERSON", description="Jane"),
            ExtractedEntity(name="ACME_INC", entity_type="ORGANIZATION", description="Acme"),
        ],
        relationships=[
            ExtractedRelationship(
                source="JANE_DOE",
                target="ACME_INC",
                relation_type="WORKS_AT",
                description="joined",
            )
        ],
    )
    gold = {
        "entities": [
            {"name": "Jane Doe", "type": "PERSON"},
            {"name": "Acme Inc", "type": "ORGANIZATION"},
        ],
        "relations": [{"source": "Jane Doe", "target": "Acme Inc", "type": "WORKS_AT"}],
    }
    s = score_result(pred, gold)
    assert s["entities"]["f1"] == 1.0
    assert s["relations"]["f1"] == 1.0
    assert prf(set(), {"a"})["recall"] == 0.0

    raw = {
        "entities": [{"name": "Jane Doe", "type": "PERSON", "description": "x"}],
        "relationships": [{"source": "Jane Doe", "target": "Nobody", "type": "WORKS_AT"}],
    }
    result = to_result(raw, ontology, document_id="d", chunk_id="c")
    assert result.entities[0].name == "JANE_DOE"
    assert result.relationships == []
