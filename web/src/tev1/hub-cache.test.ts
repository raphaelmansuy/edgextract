import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEV1_HUB_REVISION,
  evictHubCacheExceptRevision,
  hubCacheUrlMatchesRevision,
  type HubCacheStorage,
} from "./runtime";

const PINNED = DEFAULT_TEV1_HUB_REVISION;
const OTHER_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function pinnedUrl(file: string): string {
  return `https://huggingface.co/raphaelmansuy/tev1-0.8b-onnx-webgpu/resolve/${PINNED}/${file}`;
}

function fakeStorage(initial: Record<string, string[]>): HubCacheStorage & {
  remaining: () => Record<string, string[]>;
  names: () => string[];
} {
  const buckets = new Map<string, Set<string>>();
  for (const [name, urls] of Object.entries(initial)) {
    buckets.set(name, new Set(urls));
  }
  return {
    keys: async () => [...buckets.keys()],
    open: async (name: string) => {
      const set = buckets.get(name) ?? new Set();
      buckets.set(name, set);
      return {
        keys: async () => [...set].map((url) => ({ url })),
        delete: async (request: { url: string }) => set.delete(request.url),
      };
    },
    remaining: () =>
      Object.fromEntries([...buckets.entries()].map(([k, v]) => [k, [...v].sort()])),
    names: () => [...buckets.keys()],
  };
}

describe("hubCacheUrlMatchesRevision", () => {
  it("keeps the pinned resolve URL", () => {
    expect(
      hubCacheUrlMatchesRevision(pinnedUrl("onnx/embed_tokens_fp16.onnx_data"), PINNED),
    ).toBe(true);
  });

  it("rejects main, other SHAs, and local /models HTML", () => {
    expect(
      hubCacheUrlMatchesRevision(
        `https://huggingface.co/raphaelmansuy/tev1-0.8b-onnx-webgpu/resolve/main/onnx/embed_tokens_fp16.onnx_data`,
        PINNED,
      ),
    ).toBe(false);
    expect(
      hubCacheUrlMatchesRevision(
        `https://huggingface.co/raphaelmansuy/tev1-0.8b-onnx-webgpu/resolve/${OTHER_SHA}/config.json`,
        PINNED,
      ),
    ).toBe(false);
    expect(hubCacheUrlMatchesRevision("/models/org/name/config.json", PINNED)).toBe(false);
  });
});

describe("evictHubCacheExceptRevision", () => {
  it("keeps pinned blobs, drops poisons, and leaves the cache name", async () => {
    const keep = pinnedUrl("onnx/embed_tokens_fp16.onnx_data");
    const dropMain = `https://huggingface.co/raphaelmansuy/tev1-0.8b-onnx-webgpu/resolve/main/onnx/decoder_model_merged_q4f16.onnx_data`;
    const dropOther = `https://huggingface.co/raphaelmansuy/tev1-0.8b-onnx-webgpu/resolve/${OTHER_SHA}/config.json`;
    const dropLocal = "/models/org/name/config.json";
    const storage = fakeStorage({
      "transformers-cache": [keep, dropMain, dropOther, dropLocal],
    });

    await evictHubCacheExceptRevision(PINNED, storage);

    expect(storage.names()).toEqual(["transformers-cache"]);
    expect(storage.remaining()["transformers-cache"]).toEqual([keep]);
  });
});
