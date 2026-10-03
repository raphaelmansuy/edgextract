"""01 — Hello, decision.

What you will see: a closed question returns a label and a probability, not a paragraph.
"""

from __future__ import annotations

import json

from edgextract.systemone import SystemOneError
from examples._common import client_and_maybe_stop


def main() -> None:
    print("A support app needs a branch, not an essay.")
    client, stop = client_and_maybe_stop("nimble")
    try:
        resp = client.decide(
            "Our checkout has returned 500 errors since 9am.",
            {
                "label": {
                    "type": "choice",
                    "instructions": "Which label fits this ticket?",
                    "criteria": {
                        "billing": "Payments and refunds",
                        "bug": "Software errors",
                        "account": "Login and account access",
                    },
                }
            },
        )
    except SystemOneError as exc:
        print("Could not reach a decision model:", exc)
        print("Start Ollama 0.35+, run `ollama pull nimble`, or set EDGEXTRACT_FAKE=1")
        stop()
        raise SystemExit(0) from exc
    print(json.dumps(resp.model_dump(), indent=2))
    ans = resp.answers["label"]
    print(f"Winner: {ans['choice']}  P={ans['probabilities'][ans['choice']]:.3f}")
    print("Your code still owns the cutoff.")
    stop()


if __name__ == "__main__":
    main()
