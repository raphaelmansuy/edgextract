"""02 — Pick a label, say yes or no, give a level.

What you will see: Noul is P(yes). Score is an expected level on a short scale.
"""

from __future__ import annotations

import json

from edgextract.systemone import SystemOneError
from examples._common import client_and_maybe_stop


def main() -> None:
    client, stop = client_and_maybe_stop("nimble")
    try:
        resp = client.decide(
            "I was charged twice. Please refund the extra payment.",
            {
                "refund": {
                    "type": "noul",
                    "instructions": "Is the customer requesting a refund?",
                    "criteria": {
                        "false": "No refund is requested",
                        "true": "The customer requests a refund",
                    },
                },
                "urgency": {
                    "type": "score",
                    "instructions": "How urgently does this ticket need a response?",
                    "criteria": [
                        "Routine: no time pressure",
                        "Soon: a customer is inconvenienced",
                        "Immediate: a critical service is unavailable",
                    ],
                },
            },
        )
    except SystemOneError as exc:
        print("skip:", exc)
        stop()
        return
    print(json.dumps(resp.model_dump(), indent=2))
    print("Read noul as P(yes). Abstain in your code when it is near 0.5.")
    stop()


if __name__ == "__main__":
    main()
