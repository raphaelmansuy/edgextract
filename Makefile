PYTHON ?= uv run python
PYTEST ?= uv run pytest

.PHONY: sync test test-live lint fmt xref article examples probe fetch-conll04 rust-test \
	wasm-setup wasm wasm-check web-install demo demo-build demo-preview demo-e2e demo-e2e-live demo-e2e-update demo-clean \
	demo-webgpu-model demo-webgpu-publish demo-webgpu-export-tev1-probe demo-webgpu-export-tev1 \
	demo-space-publish

fetch-conll04:
	uv run python scripts/fetch_conll04.py

sync:
	uv sync --all-extras

test:
	uv run pytest -q --ignore=tests/test_live_systemone.py

rust-test:
	cargo test --workspace

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

# ---------------------------------------------------------------------------
# Browser demo: the Rust crate compiled to WebAssembly + a Vite/TypeScript page.
#   make demo        build the wasm, then serve the demo at http://localhost:5273
#   make demo-e2e    build, then run the Playwright end-to-end + screenshot tests
# Needs: rustup, wasm-pack (cargo install wasm-pack), Node 20+.
# ---------------------------------------------------------------------------

WEB := web
WASM_OUT := ../../web/src/wasm

wasm-setup:
	rustup target add wasm32-unknown-unknown
	@command -v wasm-pack >/dev/null || { echo "wasm-pack missing: cargo install wasm-pack"; exit 1; }

# The core crate must keep compiling for the browser without the `native` feature.
wasm-check:
	cargo build -p edgextract --no-default-features --target wasm32-unknown-unknown

wasm:
	wasm-pack build rust/edgextract-wasm --release --target web --out-dir $(WASM_OUT) --out-name edgextract

web-install:
	# --ignore-scripts: @huggingface/transformers pulls sharp for Node; the demo is browser-only.
	cd $(WEB) && npm install --ignore-scripts

demo: wasm web-install
	cd $(WEB) && npm run dev -- --open

# Optional local cache (~1 GB Tev1 ONNX) under web/public/models/tev1-0.8b-onnx (gitignored).
# The demo default is the Hub id raphaelmansuy/tev1-0.8b-onnx-webgpu.
demo-webgpu-model:
	$(PYTHON) scripts/fetch_tev1_webgpu_model.py

# Publish the local slice to Hugging Face (requires: hf auth login).
demo-webgpu-publish:
	$(PYTHON) scripts/publish_tev1_webgpu_model.py

# Real Tev1 ONNX: weight transplant into the fused ONNX-OPT topology.
# See docs/THIRD_PARTY_NOTICES.md (fine-tune license still pending on HF).
demo-webgpu-export-tev1-probe:
	$(PYTHON) scripts/export_tev1_onnx.py --probe

demo-webgpu-export-tev1:
	$(PYTHON) scripts/export_tev1_onnx.py --acknowledge-tev1-license-pending

# Hugging Face Static Space (COOP/COEP headers). Needs a write token: hf auth login
demo-space-publish: demo-build
	$(PYTHON) scripts/publish_edgextract_space.py --src $(WEB)/dist

demo-build: wasm web-install
	cd $(WEB) && npm run build

demo-preview: demo-build
	cd $(WEB) && npm run preview -- --open

demo-e2e: wasm web-install
	cd $(WEB) && npx playwright install chromium
	cd $(WEB) && npx playwright test

# The same page against a real Ollama model (default tev1 on localhost:11434).
demo-e2e-live: wasm web-install
	cd $(WEB) && npx playwright install chromium
	cd $(WEB) && EDGEXTRACT_LIVE=1 npx playwright test live

# Rewrite the screenshot baselines for this platform (after a deliberate visual change).
demo-e2e-update: wasm web-install
	cd $(WEB) && npx playwright install chromium
	cd $(WEB) && UPDATE_BASELINES=1 npx playwright test --update-snapshots

demo-clean:
	rm -rf $(WEB)/dist $(WEB)/test-results $(WEB)/playwright-report $(WEB)/src/wasm
