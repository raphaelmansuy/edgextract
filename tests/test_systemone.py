"""REQ-2 EC-8 EC-9 EC-18 System One contract validation."""

import pytest

from edgextract.systemone import SystemOneError, reverse_criteria, validate_response


def test_valid_choice():
    resp = validate_response(
        {
            "model": "nimble",
            "answers": {
                "label": {
                    "type": "choice",
                    "choice": "bug",
                    "probabilities": {"billing": 0.01, "bug": 0.98, "account": 0.01},
                    "confidence": 0.89,
                }
            },
            "usage": {"input_tokens": 10, "output_tokens": 1},
        },
        expected_ids=["label"],
    )
    assert resp.answers["label"]["choice"] == "bug"


def test_noul_range():
    validate_response({"model": "clef-flash", "answers": {"q": {"type": "noul", "noul": 0.2}}})
    with pytest.raises(SystemOneError):
        validate_response({"model": "x", "answers": {"q": {"type": "noul", "noul": 1.5}}})


def test_choice_not_in_keys():
    with pytest.raises(SystemOneError):
        validate_response(
            {
                "model": "n",
                "answers": {
                    "q": {
                        "type": "choice",
                        "choice": "other",
                        "probabilities": {"a": 0.5, "b": 0.5},
                    }
                },
            }
        )


def test_probs_must_sum():
    with pytest.raises(SystemOneError):
        validate_response(
            {
                "model": "n",
                "answers": {
                    "q": {
                        "type": "choice",
                        "choice": "a",
                        "probabilities": {"a": 0.1, "b": 0.1},
                    }
                },
            }
        )


def test_missing_answers_and_server_error():
    with pytest.raises(SystemOneError):
        validate_response({"model": "n"}, expected_ids=["q"])
    with pytest.raises(SystemOneError):
        validate_response({"error": "model is required"})


def test_reverse_criteria_order():
    rev = reverse_criteria({"a": "A", "b": "B"})
    assert list(rev.keys()) == ["b", "a"]
