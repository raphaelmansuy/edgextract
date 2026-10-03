"""REQ-4 fitted gate curve."""

from edgextract.calibrate import fit_gate, precision_coverage_curve
from edgextract.types import (
    ExtractedEntity,
    ExtractionResult,
    Mention,
    MentionSource,
    TypedMention,
)


def test_fit_gate_marks_fitted():
    tm = TypedMention(
        mention=Mention(
            text="Jane Doe", start=0, end=8, sentence_id="s", source=MentionSource.GAZETTEER
        ),
        entity_type="PERSON",
        winner_prob=0.9,
        probabilities={"PERSON": 0.9, "NOT_ENTITY": 0.1},
    )
    pred = ExtractionResult(
        entities=[ExtractedEntity(name="JANE_DOE", entity_type="PERSON", description="x")],
        mentions=[tm],
    )
    gold = {"entities": [{"name": "Jane Doe", "type": "PERSON"}], "relations": []}
    curve = precision_coverage_curve([(pred, gold)], kind="entity")
    assert curve
    gate = fit_gate([(pred, gold)], max_error=0.2)
    assert gate.fitted is True
