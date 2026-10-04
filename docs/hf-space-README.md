---
title: edgextract
emoji: 🕸️
colorFrom: slate
colorTo: indigo
sdk: static
app_file: index.html
pinned: false
license: apache-2.0
short_description: Markdown in, a knowledge graph out. Tev1 scores in the tab on WebGPU.
custom_headers:
  cross-origin-embedder-policy: credentialless
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

# edgextract

Turn markdown into a knowledge graph with an ontology you write and a cutoff you own.
It runs **in this tab** (Rust → WebAssembly + Tev1 on WebGPU). Your text never goes to our server.

**Open the Space on [*.hf.space](https://raphaelmansuy-edgextract.hf.space)** (not only the Hub iframe) so `SharedArrayBuffer` / WebGPU isolation works.

- First **Load Tev1** downloads ~1&nbsp;GB from [`raphaelmansuy/tev1-0.8b-onnx-webgpu`](https://huggingface.co/raphaelmansuy/tev1-0.8b-onnx-webgpu) into the browser cache.
- Chromium with WebGPU.
- This hosted page cannot call `127.0.0.1` Ollama. Optional remote host: `?backend=ollama&host=https://…` plus `OLLAMA_ORIGINS`.

Source: [github.com/raphaelmansuy/edgextract](https://github.com/raphaelmansuy/edgextract) · also on [GitHub Pages](https://raphaelmansuy.github.io/edgextract/). Attribution: [third-party notices](https://github.com/raphaelmansuy/edgextract/blob/master/docs/THIRD_PARTY_NOTICES.md).
