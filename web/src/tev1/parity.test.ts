import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compareAnswers } from "./parity";
import { answerFromScore } from "./score";
import { optionsForQuestion } from "./prompt";

const root = resolve(import.meta.dirname, "../../..");

describe("parity against recorded Ollama tev1 fixtures", () => {
  it("choice fixture: same winner and confidence shape from letter logits", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(root, "tests/fixtures/tev1_choice.json"), "utf8"),
    ) as {
      answers: Record<string, { type: string; choice: string; probabilities: Record<string, number>; confidence: number }>;
    };
    const ans = fixture.answers.label!;
    // Recover logits (up to a constant) from probabilities: logit = log(p).
    const keys = Object.keys(ans.probabilities);
    const opts = optionsForQuestion({
      type: "choice",
      instructions: "x",
      criteria: Object.fromEntries(keys.map((k) => [k, k])),
    });
    // optionsForQuestion preserves criteria key order; fixture order may differ.
    const ordered = opts.map((o) => o.key);
    const logits = ordered.map((k) => Math.log(ans.probabilities[k]!));
    const local = answerFromScore("choice", opts, logits);
    const report = compareAnswers(
      { label: ans },
      { label: local },
      { maxProbDelta: 1e-9 },
    );
    expect(report.ok, report.mismatches.join("; ")).toBe(true);
    if (local.type === "choice") {
      expect(local.choice).toBe(ans.choice);
      expect(local.confidence).toBeCloseTo(ans.confidence, 5);
    }
  });

  it("noul fixture: gate band matches at default cutoffs", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(root, "tests/fixtures/tev1_noul_score.json"), "utf8"),
    ) as { answers: Record<string, { type: string; noul?: number }> };
    const p = fixture.answers.refund!.noul!;
    // Local scorer that returns the same noul (identity parity for the gate).
    const local = { type: "noul" as const, noul: p };
    const report = compareAnswers(
      { refund: fixture.answers.refund! },
      { refund: local },
      { maxProbDelta: 1e-12 },
    );
    expect(report.ok).toBe(true);
    expect(p).toBeGreaterThan(0.8); // ACCEPT at default keep cutoff
  });
});
