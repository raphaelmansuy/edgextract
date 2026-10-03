"""04 — Find links.

What you will see: each legal link type is its own yes-or-no, so one pair can keep two links.
"""

from __future__ import annotations

from edgextract.candidates import propose_mentions
from edgextract.decisions import CachedClient, relate_pairs, type_mentions
from edgextract.gate import GateConfig
from edgextract.markdown import split_sentences
from edgextract.systemone import SystemOneError
from examples._common import SAMPLE_MD, client_and_maybe_stop, ontology


def main() -> None:
    ont = ontology()
    client, stop = client_and_maybe_stop()
    cached = CachedClient(client)
    gate = GateConfig()
    try:
        for sent in split_sentences(SAMPLE_MD):
            mentions = propose_mentions(sent, ont)
            typed = type_mentions(sent, mentions, ont, cached, gate)
            hits, _trunc = relate_pairs(sent, typed, ont, cached, gate)
            kept = [h for h in hits if h.relation_type != "NONE"]
            if not kept:
                continue
            print(f"\n{sent.text}")
            for hit in kept:
                print(f"  {hit.source_text} -[{hit.relation_type}]-> {hit.target_text}")
    except SystemOneError as exc:
        print("skip:", exc)
    stop()


if __name__ == "__main__":
    main()
