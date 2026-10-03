"""Record live /v1/systemone responses into tests/fixtures when models are present."""

from __future__ import annotations

import json
from pathlib import Path

from edgextract.systemone import SystemOneClient, SystemOneError

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
MODELS = ("nimble", "tev1", "clef", "clef-flash")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for model in MODELS:
        client = SystemOneClient(model=model, timeout=120)
        try:
            choice = client.decide(
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
            noul = client.decide(
                "The customer asks for a refund of a double charge.",
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
            print(f"{model}: skip ({exc})")
            continue
        (OUT / f"{model}_choice.json").write_text(
            json.dumps(choice.model_dump(), indent=2), encoding="utf-8"
        )
        (OUT / f"{model}_noul_score.json").write_text(
            json.dumps(noul.model_dump(), indent=2), encoding="utf-8"
        )
        print(f"{model}: wrote fixtures")


if __name__ == "__main__":
    main()
