"""Canonical entity names, copied in spirit from EdgeQuake EntityId."""

from __future__ import annotations

import re
import unicodedata

_ARTICLES = frozenset({"a", "an", "the"})
_OPAQUE = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[0-9a-f]{32,}"
    r"|\d+)$",
    re.I,
)
_NON_ALNUM = re.compile(r"[^0-9a-z]+")
_POSSESSIVE = re.compile(r"'s\b", re.I)


def normalize_entity_name(raw: str) -> str:
    """NFC, drop articles and possessives, UPPERCASE_UNDERSCORE. Empty if opaque."""
    text = unicodedata.normalize("NFC", (raw or "").strip())
    if not text:
        return ""
    text = _POSSESSIVE.sub("", text)
    lowered = text.casefold()
    if _OPAQUE.match(lowered.replace(" ", "")):
        return ""
    tokens = [t for t in _NON_ALNUM.split(lowered) if t and t not in _ARTICLES]
    if not tokens:
        return ""
    joined = "_".join(tokens)
    if _OPAQUE.match(joined):
        return ""
    return joined.upper()
