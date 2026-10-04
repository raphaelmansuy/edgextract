import { describe, expect, it } from "vitest";
import { commonPrefixLength, flattenTokenIds } from "./ids";

describe("commonPrefixLength", () => {
  it("is 0 for an empty list", () => {
    expect(commonPrefixLength([])).toBe(0);
  });

  it("keeps a suffix token on a single sequence", () => {
    expect(commonPrefixLength([[1, 2, 3]])).toBe(2);
  });

  it("finds the shared system/state prefix", () => {
    expect(
      commonPrefixLength([
        [10, 11, 12, 20, 21],
        [10, 11, 12, 30, 31],
        [10, 11, 12, 40],
      ]),
    ).toBe(3);
  });

  it("never consumes the whole shortest prompt", () => {
    expect(commonPrefixLength([[1, 2], [1, 2, 3]])).toBe(1);
  });
});

describe("flattenTokenIds", () => {
  it("coerces bigint ids", () => {
    expect(flattenTokenIds(BigInt64Array.from([1n, 2n]))).toEqual([1, 2]);
  });
});
