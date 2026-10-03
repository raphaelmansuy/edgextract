"""08 — Compare with a chat model.

What you will see: the same note scored two ways. Chat JSON is skipped when EDGEXTRACT_FAKE=1.
"""

from __future__ import annotations

import json
import os
import time

from edgextract.baseline_llm import LLMBaseline, LLMBaselineError
from edgextract.eval import score_result
from edgextract.pipeline import Extractor
from edgextract.systemone import SystemOneError
from examples._common import ROOT, SAMPLE_MD, client_and_maybe_stop, ontology


def main() -> None:
    ont = ontology()
    gold = json.loads((ROOT / "data/golden/labels/01_edgequake.json").read_text(encoding="utf-8"))
    client, stop = client_and_maybe_stop()
    try:
        started = time.time()
        decided = Extractor(ont, client).extract_markdown(SAMPLE_MD, document_id="01")
        print("decision model", int((time.time() - started) * 1000), "ms")
        print(" ", score_result(decided, gold))
    except SystemOneError as exc:
        print("decision skip:", exc)
        stop()
        return
    if os.environ.get("EDGEXTRACT_FAKE") == "1":
        print("chat JSON skipped when EDGEXTRACT_FAKE=1")
        stop()
        return
    try:
        started = time.time()
        chat = LLMBaseline().extract(SAMPLE_MD, ont, document_id="01")
        print("chat JSON", int((time.time() - started) * 1000), "ms")
        print(" ", score_result(chat, gold))
    except LLMBaselineError as exc:
        print("chat JSON skipped:", exc)
    stop()


if __name__ == "__main__":
    main()
