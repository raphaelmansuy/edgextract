/**
 * Compare a System One response from Ollama with one from the local letter scorer.
 * Used by unit tests with recorded fixtures and by an optional live script.
 */

import type { SystemOneAnswer } from "./score";

export interface ParityAnswer {
  type: string;
  choice?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface ParityReport {
  ok: boolean;
  mismatches: string[];
  maxProbDelta: number;
}

const BAND = (p: number, yes = 0.8, no = 0.2): "ACCEPT" | "REVIEW" | "REJECT" => {
  if (p >= yes) return "ACCEPT";
  if (p <= no) return "REJECT";
  return "REVIEW";
};

/** Compare two System One answer maps. Keys must match. */
export function compareAnswers(
  ollama: Record<string, ParityAnswer>,
  local: Record<string, SystemOneAnswer | ParityAnswer>,
  opts: { maxProbDelta?: number; noulYes?: number; noulNo?: number } = {},
): ParityReport {
  const maxProbDelta = opts.maxProbDelta ?? 0.15;
  const mismatches: string[] = [];
  let worst = 0;

  for (const id of Object.keys(ollama)) {
    const a = ollama[id]!;
    const b = local[id];
    if (!b) {
      mismatches.push(`${id}: missing in local`);
      continue;
    }
    if (a.type !== b.type) {
      mismatches.push(`${id}: type ${a.type} vs ${b.type}`);
      continue;
    }
    if (a.type === "choice" && b.type === "choice") {
      if (a.choice !== b.choice) {
        mismatches.push(`${id}: choice ${a.choice} vs ${b.choice}`);
      }
      for (const key of Object.keys(a.probabilities ?? {})) {
        const da = (a.probabilities ?? {})[key] ?? 0;
        const db = (b.probabilities ?? {})[key] ?? 0;
        const d = Math.abs(da - db);
        if (d > worst) worst = d;
        if (d > maxProbDelta) {
          mismatches.push(`${id}.${key}: Δp=${d.toFixed(3)}`);
        }
      }
    }
    if (a.type === "noul" && b.type === "noul") {
      const da = a.noul ?? 0;
      const db = b.noul ?? 0;
      const d = Math.abs(da - db);
      if (d > worst) worst = d;
      if (d > maxProbDelta) mismatches.push(`${id}: noul Δ=${d.toFixed(3)}`);
      const ba = BAND(da, opts.noulYes, opts.noulNo);
      const bb = BAND(db, opts.noulYes, opts.noulNo);
      if (ba !== bb) mismatches.push(`${id}: gate ${ba} vs ${bb}`);
    }
    if (a.type === "score" && b.type === "score") {
      const d = Math.abs((a.score ?? 0) - (b.score ?? 0));
      if (d > worst) worst = d;
      if (d > maxProbDelta) mismatches.push(`${id}: score Δ=${d.toFixed(3)}`);
    }
  }

  return { ok: mismatches.length === 0, mismatches, maxProbDelta: worst };
}
