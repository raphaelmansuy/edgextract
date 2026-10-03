"""06 — Review queue.

What you will see: middling answers are not written into the graph.
"""

from __future__ import annotations

from edgextract.pipeline import Extractor
from edgextract.report import _review_sentence
from edgextract.systemone import SystemOneError
from examples._common import SAMPLE_MD, client_and_maybe_stop, ontology


def main() -> None:
    client, stop = client_and_maybe_stop()
    try:
        result = Extractor(ontology(), client).extract_markdown(SAMPLE_MD)
    except SystemOneError as exc:
        print("skip:", exc)
        stop()
        return
    print(f"Kept names: {len(result.entities)}")
    print(f"Kept links: {len(result.relationships)}")
    print(f"Needs a person: {len(result.review)}")
    for item in result.review[:6]:
        print(" ", _review_sentence(item))
    print("Fit cutoffs on your labels with: edgextract calibrate")
    stop()


if __name__ == "__main__":
    main()
