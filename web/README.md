# edgextract in the browser

The Rust crate compiled to WebAssembly, behind a small Vite + TypeScript page.

```bash
make demo          # from the repo root: build wasm, install, serve http://localhost:5273
make demo-e2e      # build, then run the Playwright end-to-end and screenshot tests
make demo-build    # static site in web/dist (host it anywhere)
```

You need `rustup`, `wasm-pack` (`cargo install wasm-pack`), and Node 20+. `make wasm-setup` adds the wasm target.

## How it fits together

```
index.html + src/main.ts        the page (no framework)
src/graph.ts                    SVG force graph (d3-force)
src/names.ts                    suggests names from your text, writes them into the YAML
src/engine.ts  ── postMessage ──▶  src/worker.ts ──▶ src/wasm/  (wasm-pack output, git-ignored)
                                                      ▲
                                  rust/edgextract-wasm ┘  thin wasm-bindgen layer over rust/edgextract
```

- The engine runs in a **Web Worker**. The page never freezes while a model answers, and a worker may make the *synchronous* HTTP call the Rust pipeline expects.
- **The decision model is the only extractor.** The page POSTs closed questions to `/v1/systemone` on the host in step 3 (default `http://localhost:11434`, model `tev1`; `?host=…&model=…` in the URL pre-fills them). With Ollama, start it with `OLLAMA_ORIGINS` set to allow the page's origin. A host that cannot be reached produces an error and an empty graph, never a guess. There is no rule-based mode in the page.
- **When it runs.** Picking a sample, uploading a document or ontology, or editing the ontology starts an extraction. Typing in the text box does not (it is a real model with a real cost): press *Extract graph*. Moving a cutoff re-reads cached answers and asks the model nothing.
- Sample ontologies in `src/ontologies/*.yaml` (with a sample note each) sit beside the three that ship in the Rust crate.

## Any document, any ontology

1. **Upload or drop** a `.md` / `.txt` file (up to 2 MB), or paste text. PDF and Word files are refused with a hint to convert them first.
2. **Pick, create, or upload an ontology.** *New* starts from the template in the crate. *Edit YAML* validates as you type, with the library's own plain-English errors.
3. **Names are found for you.** Names on the ontology's list are typed for free. Every other capitalized run (`Brown University`, `GPT-4`, `Battle of Waterloo`) is proposed by `ShapeProposer` and put to the model as a closed question: is it a name this ontology can hold, and which kind? The model decides; the proposer decides nothing. You can still pin names to the ontology with one click.

The ontology bounds what can come out. A paper about AI agents read with `company_news` yields few kept names and no links, because it has no kinds for skills or methods; with `tech_docs` or `research_papers` more of it fits. If you see a sparse graph, check the **Review** tab and the kinds in step 2 first.
4. Move the cutoffs. Read the **Review** tab for what a person should decide.

## Long documents and small screens

- **Long text.** A sentence is cut at 500 characters at the source, so no question can exceed the
  model's 2050-token window. The document is read in sections (about 3000 characters). Above 40
  forecast model calls the page shows a plan first: read a preview, or everything. While it reads you
  see the section, the calls, the time left, and how long the model has been thinking. **Stop** keeps
  what was read; **Continue** picks up there; a failure keeps the partial graph and offers **Try again**.
- **The page never scrolls.** The header, with **Extract graph**, is always on screen at every size.
  Whatever is long scrolls inside its own panel. Above 1100 px you see three columns; below, three
  views (Inputs, Graph, Details) chosen from the header. `e2e/assess.spec.ts` checks the button is in
  view, 40 px tall, with no page overflow, on eight sizes from a 360 px phone to a 1600 px desktop.

## Tests

`e2e/demo.spec.ts` drives the production build in Chromium. The page always asks a host, so the suite starts a **deterministic test double** of it (`edgextract serve-standin`: rule-based, repeatable, free; it is not a model and the page cannot select it). `e2e/live.spec.ts` runs the same page against a real Ollama model: `EDGEXTRACT_LIVE=1 make demo-e2e-live`. It covers: the wasm module loads with no console errors; every sample note yields exactly the expected triples and directions; negation, hedging, passive voice, pronouns and code fences; cutoffs and the cache (0 model calls on a re-read); uploading a document and an ontology; building an ontology and its names from scratch; broken YAML; refusing non-text files; a host that works and one that is down; an uploaded document whose names no list knows (the regression behind an empty graph); dragging nodes; layout checks (nothing overlaps or leaves the canvas); three viewport sizes; and a request log proving the page talks only to its own origin and the host you named.

Screenshots are written to `docs/img/demo/` on every run. Pixel baselines (`e2e/__screenshots__/<platform>/`) are compared only on a platform that has them, because text renders differently on macOS and Linux. After a deliberate visual change: `make demo-e2e-update`.
