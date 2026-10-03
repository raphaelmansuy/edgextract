"""REQ-4 accept review reject."""

from edgextract.gate import GateConfig
from edgextract.ontology import NOT_ENTITY
from edgextract.types import GateBand


def test_accept_reject_review():
    g = GateConfig()
    assert g.band_choice("PERSON", 0.9, 0.8, null_labels=frozenset({NOT_ENTITY})) is GateBand.ACCEPT
    assert g.band_choice("PERSON", 0.2, 0.9, null_labels=frozenset({NOT_ENTITY})) is GateBand.REJECT
    assert (
        g.band_choice("PERSON", 0.55, 0.4, null_labels=frozenset({NOT_ENTITY})) is GateBand.REVIEW
    )
    assert (
        g.band_choice("PERSON", 0.99, 0.99, null_labels=frozenset({NOT_ENTITY}), flipped=True)
        is GateBand.REVIEW
    )
    assert (
        g.band_choice(NOT_ENTITY, 0.95, 0.9, null_labels=frozenset({NOT_ENTITY})) is GateBand.REJECT
    )


def test_noul_bands():
    g = GateConfig()
    assert g.band_noul(0.9) is GateBand.ACCEPT
    assert g.band_noul(0.1) is GateBand.REJECT
    assert g.band_noul(0.5) is GateBand.REVIEW
