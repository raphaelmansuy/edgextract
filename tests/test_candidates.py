"""REQ-3 EC-5 EC-6 EC-7 mention proposal."""

from pathlib import Path

from edgextract.candidates import merge_mentions, propose_mentions
from edgextract.markdown import split_sentences
from edgextract.ontology import load_ontology
from edgextract.types import Mention, MentionSource, Sentence

ONT = load_ontology(Path(__file__).resolve().parents[1] / "data/ontology/tech_docs.yaml")


def _sent(text: str) -> Sentence:
    return split_sentences(text)[0]


def test_gazetteer_and_pronouns():
    s = _sent("She joined Acme Inc in Berlin.")
    mentions = propose_mentions(s, ONT)
    skipped = [m for m in mentions if m.skipped_reason == "pronoun"]
    names = {m.text for m in mentions if not m.skipped_reason}
    assert skipped
    assert "Acme Inc" in names
    assert "Berlin" in names


def test_longest_match_apache_age():
    s = _sent("The **Apache AGE** graph extension sits on PostgreSQL.")
    mentions = [m for m in propose_mentions(s, ONT) if not m.skipped_reason]
    names = [m.text for m in mentions]
    assert any("Apache AGE" in n for n in names)
    assert "Apache" not in names


def test_merge_keeps_longer():
    a = Mention(text="Apache", start=0, end=6, sentence_id="s", source=MentionSource.SHAPE)
    b = Mention(text="Apache AGE", start=0, end=10, sentence_id="s", source=MentionSource.GAZETTEER)
    kept = merge_mentions([a, b])
    assert [m.text for m in kept if not m.skipped_reason] == ["Apache AGE"]
