import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEV1_HUB_REVISION,
  DEFAULT_TEV1_MODEL_ID,
  TEV1_WEBGPU_DTYPE,
  fingerprintGraph,
} from "./runtime";

describe("WebGPU Tev1 graph", () => {
  it("defaults to the published Tev1 ONNX Hub id", () => {
    expect(DEFAULT_TEV1_MODEL_ID).toBe("raphaelmansuy/tev1-0.8b-onnx-webgpu");
  });

  it("pins Hub Cache Storage to the fused LinearAttention commit", () => {
    expect(DEFAULT_TEV1_HUB_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });

  it("loads embed fp16 + decoder q4f16 (MatMulNBits transplant slice)", () => {
    expect(TEV1_WEBGPU_DTYPE).toEqual({
      embed_tokens: "fp16",
      decoder_model_merged: "q4f16",
      vision_encoder: "q4f16",
    });
  });

  it("fingerprints fused OPT vs unfused legacy from past_conv.0", () => {
    const fused = fingerprintGraph(
      {
        sessions: {
          decoder_model_merged: {
            inputMetadata: [{ name: "past_conv.0", shape: ["batch_size", 6144, 3] }],
          },
        },
      },
      "abc",
    );
    expect(fused).toEqual({ past_conv0_last_dim: 3, kind: "fused-opt", revision: "abc" });
    const legacy = fingerprintGraph(
      {
        sessions: {
          decoder_model_merged: {
            inputMetadata: [{ name: "past_conv.0", shape: ["batch_size", 6144, 4] }],
          },
        },
      },
      null,
    );
    expect(legacy.kind).toBe("unfused-legacy");
  });
});
