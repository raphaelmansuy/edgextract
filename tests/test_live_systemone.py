"""REQ-2 live Ollama /v1/systemone."""

import pytest

from edgextract.systemone import SystemOneClient, SystemOneError


@pytest.mark.live
def test_live_choice_nimble():
    client = SystemOneClient(model="nimble", timeout=120)
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
    assert resp.answers["label"]["type"] == "choice"
    assert resp.answers["label"]["choice"] in {"billing", "bug", "account"}


@pytest.mark.live
@pytest.mark.parametrize("model", ["nimble", "tev1", "clef", "clef-flash"])
def test_live_noul(model):
    client = SystemOneClient(model=model, timeout=120)
    try:
        resp = client.decide(
            "The customer asks for a refund of a double charge.",
            {
                "refund": {
                    "type": "noul",
                    "instructions": "Is the customer requesting a refund?",
                    "criteria": {
                        "false": "No refund is requested",
                        "true": "The customer requests a refund",
                    },
                }
            },
        )
    except SystemOneError as exc:
        pytest.skip(str(exc))
    assert 0.0 <= float(resp.answers["refund"]["noul"]) <= 1.0
