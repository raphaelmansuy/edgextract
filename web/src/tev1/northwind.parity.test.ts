import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compareAnswers } from "./parity";
import { answerFromScore } from "./score";
import { optionsForQuestion } from "./prompt";

const root = resolve(import.meta.dirname, "../../..");
const reportPath = resolve(root, "docs/results/tev1-webgpu-parity-ollama.json");

/**
 * Northwind gate bands recorded from a live Ollama `tev1` System One call
 * (scripts/tev1_webgpu_parity.py). The WebGPU letter scorer must land in the
 * same ACCEPT / REJECT bands for these two questions.
 */
describe("Northwind Ollama ↔ WebGPU gate bands", () => {
  it("founded stays ACCEPT and acquired stays REJECT at default cutoffs", () => {
    expect(existsSync(reportPath), `run scripts/tev1_webgpu_parity.py first`).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      answers: Record<string, { type: string; noul: number }>;
      bands: Record<string, string>;
    };

    expect(report.bands.founded).toBe("ACCEPT");
    expect(report.bands.acquired).toBe("REJECT");

    for (const [id, ans] of Object.entries(report.answers)) {
      const opts = optionsForQuestion({
        type: "noul",
        instructions: id,
        criteria: { true: "Yes", false: "No" },
      });
      // Reconstruct logits that recover the recorded noul (P(true)).
      const p = ans.noul;
      const logits = [Math.log(Math.max(p, 1e-12)), Math.log(Math.max(1 - p, 1e-12))];
      const local = answerFromScore("noul", opts, logits);
      const cmp = compareAnswers({ [id]: ans }, { [id]: local }, { maxProbDelta: 1e-9 });
      expect(cmp.ok, cmp.mismatches.join("; ")).toBe(true);
    }
  });
});
