"""05 — Extract a document.

What you will see: one markdown file becomes names, links, and a review list.
"""

from __future__ import annotations

from edgextract.pipeline import Extractor
from edgextract.systemone import SystemOneError
from examples._common import SAMPLE_MD, client_and_maybe_stop, ontology


def main() -> None:
    client, stop = client_and_maybe_stop()
    try:
        result = Extractor(ontology(), client).extract_markdown(
            SAMPLE_MD, document_id="01_edgequake"
        )
    except SystemOneError as exc:
        print("skip:", exc)
        stop()
        return
    print("Names:")
    for entity in result.entities:
        print(f"  {entity.display_name or entity.name}  ({entity.entity_type})")
    print("Links:")
    for rel in result.relationships:
        print(f"  {rel.source} -[{rel.relation_type}]-> {rel.target}")
    print(f"Needs a person: {len(result.review)}")
    stop()


if __name__ == "__main__":
    main()
