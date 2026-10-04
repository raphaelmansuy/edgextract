# Third-party model notices (WebGPU / Tev1)

edgextract itself is Apache-2.0 ([`LICENSE`](../LICENSE)).
The browser demo can load ONNX graphs that are **not** edgextract’s own weights.

## Together Tev1-0.8B-experimental

| Field | Value |
| --- | --- |
| Checkpoint | [`togethercomputer/Tev1-0.8B-experimental`](https://huggingface.co/togethercomputer/Tev1-0.8B-experimental) |
| Publisher | Together AI |
| Architecture | Qwen3.5 hybrid (`model_type: qwen3_5`, `Qwen3_5ForConditionalGeneration`) |
| Intended use | Closed letter decisions (System One); see the model card |
| Training notes | [How to train your own Jev](https://www.together.ai/blog/how-to-train-your-own-jev) · [togethercomputer/tev1](https://github.com/togethercomputer/tev1) |

**License (as of the Hugging Face card, Sep 2026):** the base
[Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B) is **Apache-2.0**.
Together states that the **release license for the Tev1 fine-tuned weights is
still being finalized**. Dataset sources keep their own terms.

**What that means for edgextract**

- We **attribute** Tev1 and Together clearly in the demo, export metadata, and
  any Hub card we publish.
- We **do not** treat “license finalized” as true until Together updates the
  card. Publishing a Tev1 ONNX redistributable requires
  `--acknowledge-tev1-license-pending` on
  [`scripts/export_tev1_onnx.py`](../scripts/export_tev1_onnx.py) / publish.
- Ollama’s `tev1:0.8b` Modelfile may ship an MIT blob for *their* packaging;
  that does **not** by itself clear Hugging Face weight redistribution.

## Qwen3.5-0.8B (base)

| Field | Value |
| --- | --- |
| Checkpoint | [`Qwen/Qwen3.5-0.8B`](https://huggingface.co/Qwen/Qwen3.5-0.8B) |
| License | Apache-2.0 |
| Notice | Copyright Alibaba Cloud / Qwen team — see their [LICENSE](https://huggingface.co/Qwen/Qwen3.5-0.8B/blob/main/LICENSE) |

## Browser WebGPU graph (default demo)

| Field | Value |
| --- | --- |
| Hub id | [`raphaelmansuy/tev1-0.8b-onnx-webgpu`](https://huggingface.co/raphaelmansuy/tev1-0.8b-onnx-webgpu) |
| Weights | Together Tev1-0.8B (transplant) |
| Topology | [`onnx-community/Qwen3.5-0.8B-ONNX-OPT`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX-OPT) (fused `LinearAttention`) |
| Dtypes | embed `fp16`, decoder `q4f16`, vision `q4f16` |
| License | Tev1 fine-tune pending finalization + Qwen/onnx-community Apache-2.0 |
| Prior stand-in | [`raphaelmansuy/qwen3.5-0.8b-onnx-webgpu`](https://huggingface.co/raphaelmansuy/qwen3.5-0.8b-onnx-webgpu) (base Qwen only) |

## Export tooling (Oct 2026)

Optimum ONNX still has **no** `qwen3_5` TasksManager entry, so a naive
`optimum-cli export onnx --task text-generation-with-past` on Tev1 fails.

**What works:** Tev1’s `text_config` matches `Qwen/Qwen3.5-0.8B` exactly.
[`scripts/export_tev1_onnx.py`](../scripts/export_tev1_onnx.py) therefore
**weight-transplants** Tev1 language-model tensors into the fused
Transformers.js topology
[`onnx-community/Qwen3.5-0.8B-ONNX-OPT`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX-OPT)
(fp16 `LinearAttention` + `CausalConvWithState`), with derived `A_neg_exp` /
`conv1d.weight_3d` tensors. Validated: 320/320 Tev1 LM keys mapped. The older
unfused `Qwen3.5-0.8B-ONNX` graph is not used: it has no fused scan and is
launch-bound on WebGPU.

```bash
make demo-webgpu-export-tev1-probe
make demo-webgpu-export-tev1   # requires --acknowledge-tev1-license-pending
```

Optional Optimum text-tower / `image-text-to-text` remains a fallback.
ONNX Runtime GenAI can export hybrid graphs too, but not the Transformers.js
session layout this demo loads.
