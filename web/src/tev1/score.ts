/**
 * Turn last-position letter logits into a System One answer object.
 *
 * Softmax is over the legal option letters only (the rest of the vocab is
 * masked). Confidence is 1 − H(p) / ln(n), matching Ollama’s documented
 * “how peaked” measure on the tev1 choice fixture.
 */

import type { LetterOption, QuestionType } from "./prompt";

export interface SoftmaxResult {
  probabilities: Record<string, number>;
  /** Same order as `options`. */
  probs: number[];
  choiceKey: string;
  confidence: number;
}

/** Softmax over finite logits; returns probabilities that sum to 1. */
export function softmax(logits: number[]): number[] {
  if (logits.length === 0) throw new Error("softmax needs at least one logit");
  let max = -Infinity;
  for (const x of logits) {
    if (!Number.isFinite(x)) throw new Error("logit is not finite");
    if (x > max) max = x;
  }
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** 1 − normalised Shannon entropy; 1 when one option has all the mass. */
export function confidenceFromProbs(probs: number[]): number {
  const n = probs.length;
  if (n < 2) return 1;
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * Math.log(p);
  }
  const norm = h / Math.log(n);
  const c = 1 - norm;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

/**
 * Map per-letter logits onto option keys.
 * `letterLogits[i]` is the logit for `options[i].label`.
 */
export function scoreLetters(options: LetterOption[], letterLogits: number[]): SoftmaxResult {
  if (options.length !== letterLogits.length) {
    throw new Error(
      `logit count ${letterLogits.length} does not match option count ${options.length}`,
    );
  }
  const probs = softmax(letterLogits);
  const probabilities: Record<string, number> = {};
  let best = 0;
  for (let i = 0; i < options.length; i++) {
    probabilities[options[i]!.key] = probs[i]!;
    if (probs[i]! > probs[best]!) best = i;
  }
  return {
    probabilities,
    probs,
    choiceKey: options[best]!.key,
    confidence: confidenceFromProbs(probs),
  };
}

export type SystemOneAnswer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { type: "noul"; noul: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

/** Build the answer object `validate_response` accepts. */
export function answerFromScore(
  type: QuestionType,
  options: LetterOption[],
  letterLogits: number[],
): SystemOneAnswer {
  const scored = scoreLetters(options, letterLogits);
  switch (type) {
    case "choice":
      return {
        type: "choice",
        choice: scored.choiceKey,
        probabilities: scored.probabilities,
        confidence: scored.confidence,
      };
    case "noul": {
      const pTrue = scored.probabilities.true;
      if (pTrue == null) {
        throw new Error("noul scoring needs a true option");
      }
      return { type: "noul", noul: pTrue };
    }
    case "score": {
      let expected = 0;
      const legend: Record<string, string> = {};
      for (const opt of options) {
        const level = Number(opt.key);
        expected += level * (scored.probabilities[opt.key] ?? 0);
        legend[opt.key] = opt.description;
      }
      return {
        type: "score",
        score: expected,
        legend,
        probabilities: scored.probabilities,
        confidence: scored.confidence,
      };
    }
  }
}

/**
 * Pick letter token ids from a tokenizer vocab.
 * Tries bare "A", leading-space " A", and common SentencePiece forms.
 */
export function resolveLetterTokenIds(
  encode: (text: string) => number[],
  letters: string[],
): number[] {
  const ids: number[] = [];
  for (const letter of letters) {
    const candidates = [letter, ` ${letter}`, `\n${letter}`];
    let found: number | null = null;
    for (const c of candidates) {
      const toks = encode(c);
      // Prefer a single-token encoding of the letter (with optional space).
      if (toks.length === 1) {
        found = toks[0]!;
        break;
      }
      if (toks.length === 2 && found == null) {
        // space + letter as two tokens: take the letter token
        found = toks[1]!;
      }
    }
    if (found == null) {
      throw new Error(`cannot resolve token id for letter ${letter}`);
    }
    ids.push(found);
  }
  return ids;
}

/** Read one logit per letter id from a flat vocab logit vector. */
export function gatherLetterLogits(vocabLogits: ArrayLike<number>, letterIds: number[]): number[] {
  return letterIds.map((id) => {
    if (id < 0 || id >= vocabLogits.length) {
      throw new Error(`letter token id ${id} out of range ${vocabLogits.length}`);
    }
    return Number(vocabLogits[id]);
  });
}
