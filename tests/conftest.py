"""Shared fixtures."""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def ontology():
    from edgextract.ontology import load_ontology

    return load_ontology(ROOT / "data/ontology/tech_docs.yaml")


@pytest.fixture
def repo_root() -> Path:
    return ROOT
