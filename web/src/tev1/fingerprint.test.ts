import { describe, expect, it } from "vitest";
import { fingerprintGraph } from "./runtime";

describe("fingerprintGraph", () => {
  it("returns unknown when sessions are missing", () => {
    expect(fingerprintGraph({}, null).kind).toBe("unknown");
    expect(fingerprintGraph(null, null).kind).toBe("unknown");
  });
});
