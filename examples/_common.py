"""Shared helpers. EDGEXTRACT_FAKE=1 skips a live Ollama. EDGEXTRACT_ONTOLOGY picks a YAML."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from edgextract.ontology import load_ontology_named
from edgextract.systemone import SystemOneClient
from edgextract.testing import start_fake_systemone


def ontology(name: str | None = None):
    chosen = name or os.environ.get("EDGEXTRACT_ONTOLOGY") or "tech_docs"
    return load_ontology_named(chosen)


def client_and_maybe_stop(model: str = "nimble", ont=None):
    loaded = ont if ont is not None else ontology()
    if os.environ.get("EDGEXTRACT_FAKE") == "1":
        from tests.fake_handler import gazetteer_handler

        print(
            "[offline demo] A stand-in model answers 'yes' to every legal link, so expect extra "
            "links.\n"
            "Run without EDGEXTRACT_FAKE=1 (and with Ollama + `ollama pull tev1`) for real answers.\n"
        )
        url, stop = start_fake_systemone(gazetteer_handler(loaded))
        return SystemOneClient(model=model, base_url=url, timeout=10), stop
    return SystemOneClient(model=model, timeout=60), lambda: None


SAMPLE_MD = (ROOT / "data/golden/docs/01_edgequake.md").read_text(encoding="utf-8")
NEWS_MD = (ROOT / "data/golden/docs/13_northwind.md").read_text(encoding="utf-8")
