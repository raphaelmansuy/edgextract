"""init-ontology and validate-ontology CLI."""

from edgextract.cli import main


def test_init_and_validate(tmp_path):
    path = tmp_path / "mine.yaml"
    assert main(["init-ontology", str(path)]) == 0
    assert path.exists()
    assert main(["validate-ontology", str(path)]) == 0
    assert main(["init-ontology", str(path)]) == 1


def test_validate_bundled_company_news(capsys):
    assert main(["validate-ontology", "company_news"]) == 0
    out = capsys.readouterr().out
    assert "FOUNDED" in out
    assert "PERSON" in out
