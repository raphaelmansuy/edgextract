"""03 — Type a name.

What you will see: known names are looked up. Unknown spans get a yes-or-no, then a kind.
"""

from __future__ import annotations

from edgextract.candidates import propose_mentions
from edgextract.decisions import CachedClient, type_mentions
from edgextract.gate import GateConfig
from edgextract.markdown import split_sentences
from edgextract.systemone import SystemOneError
from examples._common import SAMPLE_MD, client_and_maybe_stop, ontology


def main() -> None:
    ont = ontology()
    client, stop = client_and_maybe_stop()
    cached = CachedClient(client)
    try:
        for sent in split_sentences(SAMPLE_MD)[:3]:
            mentions = propose_mentions(sent, ont)
            typed = type_mentions(sent, mentions, ont, cached, GateConfig())
            print(f"\n{sent.text}")
            for item in typed:
                print(f"  {item.mention.text!r} is {item.entity_type} ({item.band.value})")
    except SystemOneError as exc:
        print("skip:", exc)
    stop()


if __name__ == "__main__":
    main()
