import { describe, expect, it } from "vitest";
import { decideLocal, sequentialPrefills } from "./systemone";
import { LETTERS } from "./prompt";

describe("decideLocal packed POST", () => {
  it("scores every question from one prefillMany batch", async () => {
    const letterIds = LETTERS.map((_, i) => i);
    const seen: string[][] = [];
    const res = await decideLocal(
      {
        model: "tev1:0.8b",
        state: "Acme billed twice",
        questions: {
          refund: { type: "noul", instructions: "Refund?" },
          intent: {
            type: "choice",
            instructions: "Which team?",
            criteria: { billing: "Payments", bug: "Defects" },
          },
        },
      },
      async (batch) => {
        seen.push(batch.map((m) => m[1]!.content));
        return batch.map((messages, i) => {
          JSON.parse(messages[1]!.content);
          const logits = new Float32Array(letterIds.length);
          logits[0] = 4;
          if (i === 1) {
            logits[0] = 0;
            logits[1] = 5;
          }
          return { logits, inputTokens: 40 + i, letterIds, ms: 12 + i };
        });
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(res.usage.output_tokens).toBe(2);
    expect(res.usage.input_tokens).toBe(81);
    expect(res.usage.prefill_ms).toBe(25);
    expect(res.answers.refund).toMatchObject({ type: "noul" });
    expect(res.answers.intent).toMatchObject({ type: "choice", choice: "bug" });
  });

  it("sequentialPrefills keeps one question at a time", async () => {
    const order: number[] = [];
    const many = sequentialPrefills(async (messages) => {
      order.push(messages.length);
      const letterIds = [0, 1];
      return { logits: new Float32Array([1, 0]), inputTokens: 3, letterIds, ms: 1 };
    });
    const out = await many([
      [
        { role: "system", content: "s" },
        { role: "user", content: "{}" },
      ],
      [
        { role: "system", content: "s" },
        { role: "user", content: "{}" },
      ],
    ]);
    expect(out).toHaveLength(2);
    expect(order).toEqual([2, 2]);
  });
});
