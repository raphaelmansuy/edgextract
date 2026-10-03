PYTHON ?= uv run python
PYTEST ?= uv run pytest

.PHONY: sync test test-live lint fmt xref article examples probe fetch-conll04

fetch-conll04:
	uv run python scripts/fetch_conll04.py

sync:
	uv sync --all-extras

test:
	uv run pytest -q --ignore=tests/test_live_systemone.py

test-live:
	uv run pytest -q -m live

lint:
	uv run ruff check src tests examples scripts
	uv run ruff format --check src tests examples scripts

fmt:
	uv run ruff check --fix src tests examples scripts
	uv run ruff format src tests examples scripts

xref:
	uv run python scripts/check_xrefs.py

probe:
	uv run python scripts/probe_systemone.py

examples:
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/01_hello_decision.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/02_pick_a_label.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/03_type_a_name.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/04_find_links.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/05_extract_a_document.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/06_review_queue.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/07_your_own_ontology.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/08_compare_with_chat_model.py
	PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/09_export_graph.py

article:
	uv run python docs/article/build_pdf.py
