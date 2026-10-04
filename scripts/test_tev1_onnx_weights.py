"""Unit tests for Tev1 → ONNX initializer name mapping."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tev1_onnx_weights import derived_onnx_targets, resolve_tev1_to_onnx, tev1_to_onnx_candidates

ONNX_SAMPLE = {
    "model.embed_tokens.weight",
    "model.layers.0.input_layernorm.weight",
    "model.layers.0.gdn.conv1d.weight",
    "model.layers.0.gdn.conv1d.weight_3d",
    "model.layers.0.gdn.A_neg_exp",
    "model.layers.0.gdn.dt_bias",
    "model.layers.0.gdn.in_proj_qkv.MatMul.weight",
    "model.layers.0.mlp.gate_proj.MatMul.weight",
    "model.layers.11.attn.q_norm.layernorm.weight",
    "model.layers.11.attn.q_proj.MatMul.weight",
    "model.layers.24.final_norm_layernorm.weight",
    "lm_head.MatMul.weight",
}


class Tev1OnnxMapTest(unittest.TestCase):
    def test_embed(self) -> None:
        self.assertEqual(
            resolve_tev1_to_onnx("model.language_model.embed_tokens.weight", ONNX_SAMPLE),
            "model.embed_tokens.weight",
        )

    def test_gdn_matmul(self) -> None:
        self.assertEqual(
            resolve_tev1_to_onnx(
                "model.language_model.layers.0.linear_attn.in_proj_qkv.weight",
                ONNX_SAMPLE,
            ),
            "model.layers.0.gdn.in_proj_qkv.MatMul.weight",
        )

    def test_a_log(self) -> None:
        self.assertEqual(
            resolve_tev1_to_onnx(
                "model.language_model.layers.0.linear_attn.A_log",
                ONNX_SAMPLE,
            ),
            "model.layers.0.gdn.A_neg_exp",
        )
        targets = derived_onnx_targets(
            "model.language_model.layers.0.linear_attn.A_log",
            "model.layers.0.gdn.A_neg_exp",
        )
        self.assertEqual(targets, [("model.layers.0.gdn.A_neg_exp", "neg_exp")])

    def test_final_norm(self) -> None:
        self.assertEqual(
            resolve_tev1_to_onnx("model.language_model.norm.weight", ONNX_SAMPLE),
            "model.layers.24.final_norm_layernorm.weight",
        )

    def test_attn_q_norm(self) -> None:
        self.assertEqual(
            resolve_tev1_to_onnx(
                "model.language_model.layers.11.self_attn.q_norm.weight",
                ONNX_SAMPLE,
            ),
            "model.layers.11.attn.q_norm.layernorm.weight",
        )

    def test_opt_conv1d_weight_3d_only(self) -> None:
        names = {"model.layers.0.gdn.conv1d.weight_3d"}
        resolved = resolve_tev1_to_onnx(
            "model.language_model.layers.0.linear_attn.conv1d.weight",
            names,
        )
        self.assertEqual(resolved, "model.layers.0.gdn.conv1d.weight_3d")
        self.assertEqual(
            derived_onnx_targets(
                "model.language_model.layers.0.linear_attn.conv1d.weight",
                resolved or "",
            ),
            [("model.layers.0.gdn.conv1d.weight_3d", "conv1d_to_3d")],
        )

    def test_conv1d_derived(self) -> None:
        targets = derived_onnx_targets(
            "model.language_model.layers.0.linear_attn.conv1d.weight",
            "model.layers.0.gdn.conv1d.weight",
        )
        self.assertIn(("model.layers.0.gdn.conv1d.weight_3d", "conv1d_to_3d"), targets)

    def test_ignores_vision(self) -> None:
        self.assertEqual(tev1_to_onnx_candidates("model.visual.foo.weight"), [])


if __name__ == "__main__":
    unittest.main()
