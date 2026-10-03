"""REQ-3 REQ-4 REQ-5 REQ-6 REQ-7 REQ-8 EC-10 EC-14 EC-15 EC-16 EC-17 e2e fake HTTP."""

from pathlib import Path

from tests.fake_handler import gazetteer_handler

from edgextract.cache import DecisionCache
from edgextract.gate import GateConfig
from edgextract.pipeline import Extractor
from edgextract.systemone import SystemOneClient
from edgextract.testing import start_fake_systemone

ROOT = Path(__file__).resolve().parents[1]


def test_e2e_edgequake_doc(ontology, tmp_path):
    url, stop = start_fake_systemone(gazetteer_handler(ontology))
    try:
        client = SystemOneClient(model="nimble", base_url=url, timeout=5)
        cache = DecisionCache(tmp_path / "c.sqlite")
        ext = Extractor(ontology, client, gate=GateConfig(), cache=cache)
        text = (ROOT / "data/golden/docs/01_edgequake.md").read_text()
        result = ext.extract_markdown(text, document_id="01_edgequake")
        names = {e.name for e in result.entities}
        assert "ACME_INC" in names
        assert "JANE_DOE" in names
        assert "EDGEQUAKE" in names
        types = {e.name: e.entity_type for e in result.entities}
        assert types["JANE_DOE"] == "PERSON"
        assert types["POSTGRESQL"] == "TECHNOLOGY"
        rels = {(r.source, r.relation_type, r.target) for r in result.relationships}
        assert ("JANE_DOE", "WORKS_AT", "ACME_INC") in rels
        assert result.metadata["stats"]["systemone_calls"] >= 1
        # second run hits cache
        result2 = ext.extract_markdown(text, document_id="01_edgequake")
        assert result2.metadata["stats"]["cache_hits"] >= 1
        assert all(e.source_chunk_ids for e in result.entities)
        assert all(r.source_chunk_ids for r in result.relationships)
    finally:
        stop()


def test_e2e_negation_no_relation(ontology):
    url, stop = start_fake_systemone(gazetteer_handler(ontology))
    try:
        client = SystemOneClient(model="nimble", base_url=url, timeout=5)
        ext = Extractor(ontology, client)
        text = (ROOT / "data/golden/docs/05_negation.md").read_text()
        result = ext.extract_markdown(text, document_id="05")
        assert result.entities
        assert result.relationships == []
    finally:
        stop()


def test_e2e_pronouns_skipped(ontology):
    url, stop = start_fake_systemone(gazetteer_handler(ontology))
    try:
        client = SystemOneClient(model="nimble", base_url=url, timeout=5)
        ext = Extractor(ontology, client)
        text = (ROOT / "data/golden/docs/10_pronouns.md").read_text()
        result = ext.extract_markdown(text, document_id="10")
        names = {e.name for e in result.entities}
        assert "SHE" not in names
        assert "THEY" not in names
        assert "JANE_DOE" in names
    finally:
        stop()


def test_e2e_empty_doc(ontology):
    url, stop = start_fake_systemone(gazetteer_handler(ontology))
    try:
        client = SystemOneClient(model="nimble", base_url=url, timeout=5)
        result = Extractor(ontology, client).extract_markdown("   \n")
        assert result.entities == []
        assert result.relationships == []
        assert result.metadata["stats"]["systemone_calls"] == 0
    finally:
        stop()


def test_e2e_self_loop_dropped(ontology):
    url, stop = start_fake_systemone(gazetteer_handler(ontology))
    try:
        client = SystemOneClient(model="nimble", base_url=url, timeout=5)
        text = (ROOT / "data/golden/docs/11_selfloop.md").read_text()
        result = Extractor(ontology, client).extract_markdown(text)
        loops = [r for r in result.relationships if r.source == r.target]
        assert loops == []
    finally:
        stop()


def test_transport_404_fails_closed(ontology):
    def boom(body):
        del body
        raise RuntimeError("nope")

    url, stop = start_fake_systemone(boom)
    try:
        from edgextract.systemone import SystemOneError

        client = SystemOneClient(model="nimble", base_url=url, timeout=5)
        try:
            Extractor(ontology, client).extract_markdown("Jane Doe joined Acme Inc.")
            raised = False
        except SystemOneError:
            raised = True
        assert raised
    finally:
        stop()


def test_atomic_noul_accepts_each_legal_predicate(ontology):
    """Two ontology-legal relations on one pair can both be accepted."""

    def handler(body):
        questions = body["questions"]
        answers = {}
        for qid, q in questions.items():
            if q.get("type") != "noul":
                raise AssertionError(f"relation questions are noul, got {q.get('type')}")
            text = q.get("instructions") or ""
            yes = "USES" in text or "DEPENDS_ON" in text
            answers[qid] = {"type": "noul", "noul": 0.95 if yes else 0.05}
        return {"model": "n", "answers": answers, "usage": {"input_tokens": 1, "output_tokens": 1}}

    url, stop = start_fake_systemone(handler)
    try:
        client = SystemOneClient(model="n", base_url=url, timeout=5)
        result = Extractor(ontology, client).extract_markdown("EdgeQuake depends on PostgreSQL.")
        rels = {(r.source, r.relation_type, r.target) for r in result.relationships}
        assert ("EDGEQUAKE", "USES", "POSTGRESQL") in rels
        assert ("EDGEQUAKE", "DEPENDS_ON", "POSTGRESQL") in rels
        assert {r.weight for r in result.relationships} == {0.95}
        assert ("EDGEQUAKE", "PART_OF", "POSTGRESQL") not in rels
    finally:
        stop()


def test_option_flip_goes_to_review(ontology):
    calls = {"n": 0}

    def flipper(body):
        calls["n"] += 1
        questions = body["questions"]
        answers = {}
        for qid, q in questions.items():
            if q.get("type") == "noul":
                answers[qid] = {"type": "noul", "noul": 0.95}
                continue
            keys = list(q["criteria"])
            winner = keys[0] if calls["n"] % 2 else keys[-1]
            rest = [k for k in keys if k != winner]
            leftover = 0.08 / max(len(rest), 1)
            probs = {winner: 0.92}
            for k in rest:
                probs[k] = leftover
            probs[winner] += 1 - sum(probs.values())
            answers[qid] = {
                "type": "choice",
                "choice": winner,
                "probabilities": probs,
                "confidence": 0.2,  # forces rotation
            }
        return {"model": "n", "answers": answers, "usage": {"input_tokens": 1, "output_tokens": 1}}

    url, stop = start_fake_systemone(flipper)
    try:
        client = SystemOneClient(model="n", base_url=url, timeout=5)
        from edgextract.span_encoder import EncoderProposer, FixedSpanEncoder

        result = Extractor(
            ontology,
            client,
            gate=GateConfig(rotate_below_confidence=1.0),
            proposers=(EncoderProposer(FixedSpanEncoder([(0, 5, 0.99)])),),
        ).extract_markdown("Ziggy joined Acme Inc.")
        assert result.review or any(h.flipped for h in result.relation_hits)
    finally:
        stop()
