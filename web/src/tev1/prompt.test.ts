import { describe, expect, it } from "vitest";
import {
  LETTERS,
  TEV1_SYSTEM,
  optionsForQuestion,
  renderChatPlain,
  renderQuestion,
  renderRequest,
} from "./prompt";
import {
  answerFromScore,
  confidenceFromProbs,
  scoreLetters,
  softmax,
} from "./score";

describe("tev1 prompt", () => {
  it("expands choice criteria into A.. letters", () => {
    const opts = optionsForQuestion({
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "Payments", bug: "Defects", account: "Login" },
    });
    expect(opts.map((o) => o.label)).toEqual(["A", "B", "C"]);
    expect(opts.map((o) => o.key)).toEqual(["billing", "bug", "account"]);
  });

  it("puts noul true on A and false on B", () => {
    const opts = optionsForQuestion({
      type: "noul",
      instructions: "Refund?",
      criteria: { true: "Yes", false: "No" },
    });
    expect(opts).toEqual([
      { label: "A", key: "true", description: "Yes" },
      { label: "B", key: "false", description: "No" },
    ]);
  });

  it("renders the Together system instruction and JSON user payload", () => {
    const q = renderQuestion(
      "label",
      {
        type: "choice",
        instructions: "Which intent?",
        criteria: { bug: "A defect", billing: "A charge" },
      },
      "the card was charged twice",
    );
    expect(q.messages[0]?.content).toBe(TEV1_SYSTEM);
    const user = JSON.parse(q.messages[1]!.content);
    expect(user.state).toBe("the card was charged twice");
    expect(user.question).toBe("Which intent?");
    expect(user.options[0].label).toBe("A");
    expect(renderChatPlain(q.messages)).toContain("<|im_start|>assistant\n");
  });

  it("renders every question in a System One body", () => {
    const rendered = renderRequest({
      model: "tev1:0.8b",
      state: { ticket: "hi" },
      questions: {
        refund: { type: "noul", instructions: "Refund?" },
        urgency: {
          type: "score",
          instructions: "How urgent?",
          criteria: ["Routine", "Soon", "Urgent"],
        },
      },
    });
    expect(rendered.map((r) => r.id)).toEqual(["refund", "urgency"]);
    expect(rendered[1]!.options.map((o) => o.key)).toEqual(["0", "1", "2"]);
  });

  it("exposes 24 letters A–X", () => {
    expect(LETTERS).toHaveLength(24);
    expect(LETTERS[0]).toBe("A");
    expect(LETTERS[23]).toBe("X");
  });
});

describe("tev1 score", () => {
  it("softmaxes and picks the argmax key", () => {
    const opts = [
      { label: "A", key: "billing", description: "" },
      { label: "B", key: "bug", description: "" },
      { label: "C", key: "account", description: "" },
    ];
    // Logits shaped like the recorded tev1 choice fixture (bug wins).
    const scored = scoreLetters(opts, [1.0, 4.0, 0.0]);
    expect(scored.choiceKey).toBe("bug");
    const sum = Object.values(scored.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("matches Ollama confidence on the tev1 choice fixture probabilities", () => {
    const probs = [0.06258526071519338, 0.9160073159790056, 0.02140742330580086];
    const conf = confidenceFromProbs(probs);
    expect(conf).toBeCloseTo(0.6940771966670671, 3);
  });

  it("builds choice / noul / score answers validate_response accepts", () => {
    const choice = answerFromScore(
      "choice",
      [
        { label: "A", key: "billing", description: "pay" },
        { label: "B", key: "bug", description: "defect" },
      ],
      [0.1, 3.0],
    );
    expect(choice.type).toBe("choice");
    if (choice.type === "choice") {
      expect(choice.choice).toBe("bug");
      expect(choice.confidence).toBeGreaterThan(0.5);
    }

    const noul = answerFromScore(
      "noul",
      [
        { label: "A", key: "true", description: "Yes" },
        { label: "B", key: "false", description: "No" },
      ],
      [5.0, 0.0],
    );
    expect(noul.type).toBe("noul");
    if (noul.type === "noul") expect(noul.noul).toBeGreaterThan(0.9);

    const score = answerFromScore(
      "score",
      [
        { label: "A", key: "0", description: "Routine" },
        { label: "B", key: "1", description: "Soon" },
        { label: "C", key: "2", description: "Urgent" },
      ],
      [1.0, 2.0, 0.0],
    );
    expect(score.type).toBe("score");
    if (score.type === "score") {
      expect(score.legend["1"]).toBe("Soon");
      expect(score.score).toBeGreaterThan(0.5);
      expect(score.score).toBeLessThan(1.5);
    }
  });

  it("rejects non-finite logits", () => {
    expect(() => softmax([1, Number.NaN])).toThrow(/finite/);
  });
});
