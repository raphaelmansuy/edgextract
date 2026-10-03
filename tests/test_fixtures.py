"""REQ-2 recorded contract fixtures."""

from pathlib import Path

from edgextract.systemone import validate_response


def test_release_note_fixtures_validate():
    root = Path(__file__).resolve().parent / "fixtures"
    for name in ("notes_v0350_choice.json", "notes_v0351_noul.json"):
        data = __import__("json").loads((root / name).read_text())
        validate_response(data)
