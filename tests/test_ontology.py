"""REQ-1 REQ-10 EC-12 ontology load and limits."""

from pathlib import Path

import pytest

from edgextract.ontology import (
    MAX_CHOICE_OPTIONS,
    NOT_ENTITY,
    Ontology,
    load_ontology,
    load_ontology_named,
    ontology_from_dict,
    resolve_ontology_path,
)

ROOT = Path(__file__).resolve().parents[1]


def test_tech_docs_loads():
    ont = load_ontology(ROOT / "data/ontology/tech_docs.yaml")
    assert ont.id == "tech_docs"
    assert len(ont.types) >= 2
    crit = ont.type_choice_criteria()
    assert NOT_ENTITY in crit
    assert len(crit) <= MAX_CHOICE_OPTIONS
    allowed = ont.allowed_pairs("PERSON", "ORGANIZATION")
    assert "WORKS_AT" in allowed
    assert ont.allowed_pairs("LOCATION", "PERSON") == []


def test_company_news_loads_and_has_pairs():
    ont = load_ontology_named("company_news")
    assert ont.id == "company_news"
    assert "FOUNDED" in ont.allowed_pairs("PERSON", "COMPANY")
    assert "ACQUIRED" in ont.allowed_pairs("COMPANY", "COMPANY")
    assert ont.allowed_pairs("LOCATION", "PERSON") == []


def test_resolve_bundled_name():
    path = resolve_ontology_path("tech_docs")
    assert path.exists()


def test_rejects_unknown_domain_names_the_link():
    with pytest.raises(Exception, match="starts from Z"):
        ontology_from_dict(
            {
                "id": "bad",
                "types": [{"id": "A", "description": "a"}, {"id": "B", "description": "b"}],
                "relations": [{"id": "X", "description": "x", "domain": ["Z"], "range": ["B"]}],
            }
        )


def test_rejects_too_few_types():
    with pytest.raises(ValueError):
        Ontology.model_validate(
            {"id": "x", "types": [{"id": "A", "description": "a"}], "relations": []}
        )
