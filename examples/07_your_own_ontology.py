"""07 — Your own ontology.

What you will see: the same pipeline on company news, not software docs.
"""

from __future__ import annotations

from edgextract.pipeline import Extractor
from edgextract.systemone import SystemOneError
from examples._common import NEWS_MD, client_and_maybe_stop, ontology


def main() -> None:
    ont = ontology("company_news")
    client, stop = client_and_maybe_stop(ont=ont)
    try:
        result = Extractor(ont, client).extract_markdown(NEWS_MD, document_id="13_northwind")
    except SystemOneError as exc:
        print("skip:", exc)
        stop()
        return
    print(f"Ontology: {ont.title}")
    for entity in result.entities:
        print(f"  {entity.display_name or entity.name}  ({entity.entity_type})")
    for rel in result.relationships:
        print(f"  {rel.source} -[{rel.relation_type}]-> {rel.target}")
    stop()


if __name__ == "__main__":
    main()
