"""Closed-decision knowledge graph extraction from text and an ontology."""

from edgextract.gate import GateConfig
from edgextract.ontology import Ontology, load_ontology, load_ontology_named
from edgextract.pipeline import Extractor, extract_text, extractor_from_files
from edgextract.report import render_html, write_report
from edgextract.systemone import SystemOneClient, SystemOneError
from edgextract.types import ExtractionResult

__all__ = [
    "Extractor",
    "ExtractionResult",
    "GateConfig",
    "Ontology",
    "SystemOneClient",
    "SystemOneError",
    "extract_text",
    "extractor_from_files",
    "load_ontology",
    "load_ontology_named",
    "render_html",
    "write_report",
]
__version__ = "0.1.0"
