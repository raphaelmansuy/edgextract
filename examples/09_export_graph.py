"""09 — Export a graph.

What you will see: JSON, Cypher, and a self-contained HTML graph file.
"""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from edgextract.graph_html import write_graph
from edgextract.pipeline import Extractor
from edgextract.systemone import SystemOneError
from examples._common import SAMPLE_MD, client_and_maybe_stop, ontology


def main() -> None:
    ont = ontology()
    client, stop = client_and_maybe_stop()
    try:
        result = Extractor(ont, client).extract_markdown(SAMPLE_MD, document_id="01_edgequake")
    except SystemOneError as exc:
        print("skip:", exc)
        stop()
        return
    print(json.dumps({"names": len(result.entities), "links": len(result.relationships)}))
    for rel in result.relationships[:5]:
        print(
            f"MATCH (a {{id: {rel.source!r}}}), (b {{id: {rel.target!r}}}) "
            f"MERGE (a)-[:{rel.relation_type}]->(b);"
        )
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "graph.html"
        write_graph(path, result, ont, title="EdgeQuake note")
        print("graph html bytes", path.stat().st_size)
    stop()


if __name__ == "__main__":
    main()
