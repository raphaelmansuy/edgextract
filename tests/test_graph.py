"""Interactive graph HTML stays offline and lists kept names."""

from edgextract.graph_html import graph_payload, render_graph_page
from edgextract.ontology import load_ontology_named
from edgextract.types import ExtractedEntity, ExtractedRelationship, ExtractionResult


def test_graph_payload_counts_and_escapes():
    ont = load_ontology_named("tech_docs")
    result = ExtractionResult(
        entities=[
            ExtractedEntity(
                name="JANE_DOE",
                entity_type="PERSON",
                description="Jane Doe",
                display_name="Jane Doe",
            ),
            ExtractedEntity(
                name="ACME_INC",
                entity_type="ORGANIZATION",
                description="Acme Inc",
                display_name="Acme Inc",
            ),
        ],
        relationships=[
            ExtractedRelationship(
                source="JANE_DOE",
                target="ACME_INC",
                relation_type="WORKS_AT",
                description="Jane Doe joined Acme Inc.",
            )
        ],
        review=[
            {
                "kind": "relation",
                "source": "Jane Doe",
                "target": "Acme Inc",
                "type": "NONE",
            }
        ],
    )
    payload = graph_payload(result, ont)
    assert len(payload["nodes"]) == 2
    assert len(payload["edges"]) == 2
    page = render_graph_page(result, ont, title="Demo <script>alert(1)</script>")
    assert "<script>alert(1)</script>" not in page
    assert "Jane Doe works at Acme Inc." in page
    assert "unpkg" not in page
    assert "jsdelivr" not in page
    assert page.count("window.EDGEXTRACT_GRAPH") >= 1
