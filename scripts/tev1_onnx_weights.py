"""Map Together Tev1 PyTorch keys onto the Qwen3.5 ONNX-OPT initializers.

Tev1 and Qwen3.5-0.8B share an identical ``text_config``. The donor is
``onnx-community/Qwen3.5-0.8B-ONNX-OPT`` (Oct 2026): fused
``com.microsoft.LinearAttention`` + ``CausalConvWithState``, no ``If`` nodes.
The older unfused community graph (960 small ops, 18 ``If``) is what made
WebGPU prefills launch-bound.
"""

from __future__ import annotations

from collections.abc import Iterable


def tev1_to_onnx_candidates(tev_key: str) -> list[str]:
    """Return ONNX initializer names that may hold ``tev_key``'s values."""
    if not tev_key.startswith("model.language_model."):
        return []

    k = tev_key.removeprefix("model.language_model.")
    base = "model." + k
    outs: list[str] = []

    def add(name: str) -> None:
        if name not in outs:
            outs.append(name)

    if k == "embed_tokens.weight":
        add("model.embed_tokens.weight")
        return outs

    if k == "norm.weight":
        # Final RMSNorm sits after the last layer in the Optimum graph.
        add("model.layers.24.final_norm_layernorm.weight")
        add("model.norm.weight")
        return outs

    gdn = base.replace(".linear_attn.", ".gdn.")
    attn = base.replace(".self_attn.", ".attn.")

    for stem in (gdn, attn, base):
        add(stem)
        if stem.endswith(".weight"):
            add(stem[: -len(".weight")] + ".MatMul.weight")
        # OPT fp16 keeps only the depthwise 3D conv weight, not the 2D source.
        if stem.endswith(".conv1d.weight"):
            add(stem + "_3d")

    add(gdn.replace(".A_log", ".A_neg_exp"))
    add(attn.replace(".q_norm.weight", ".q_norm.layernorm.weight"))
    add(attn.replace(".k_norm.weight", ".k_norm.layernorm.weight"))
    return outs


def resolve_tev1_to_onnx(tev_key: str, onnx_names: Iterable[str]) -> str | None:
    names = set(onnx_names)
    for cand in tev1_to_onnx_candidates(tev_key):
        if cand in names:
            return cand
    return None


def derived_onnx_targets(tev_key: str, onnx_name: str) -> list[tuple[str, str]]:
    """Extra ONNX tensors derived from a Tev1 tensor.

    Returns list of (onnx_name, transform) where transform is one of:
    ``copy``, ``neg_exp``, ``conv1d_to_3d``.
    """
    out: list[tuple[str, str]] = [(onnx_name, "copy")]
    if onnx_name.endswith(".gdn.A_neg_exp") or tev_key.endswith(".linear_attn.A_log"):
        # Primary mapping already points at A_neg_exp; mark transform.
        return [(onnx_name, "neg_exp")]
    if onnx_name.endswith(".gdn.conv1d.weight_3d"):
        return [(onnx_name, "conv1d_to_3d")]
    if onnx_name.endswith(".gdn.conv1d.weight"):
        out.append((onnx_name + "_3d", "conv1d_to_3d"))
    return out
