"""REQ-5 canonical names."""

from edgextract.names import normalize_entity_name


def test_basic():
    assert normalize_entity_name("Jane Doe") == "JANE_DOE"
    assert normalize_entity_name("the Apache AGE") == "APACHE_AGE"
    assert normalize_entity_name("Acme Inc.") == "ACME_INC"


def test_opaque_and_empty():
    assert normalize_entity_name("") == ""
    assert normalize_entity_name("42") == ""
    assert normalize_entity_name("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") == ""
