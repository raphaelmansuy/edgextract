/**
 * System One request → System One response, scored from letter logits.
 * Packed POSTs share one `prefillMany` (prefix KV + last-token letter logits).
 */

import { renderRequest, type SystemOneRequest } from "./prompt";
import {
  answerFromScore,
  gatherLetterLogits,
  type SystemOneAnswer,
} from "./score";

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
  /** Sum of GPU prefill wall times in this POST. */
  prefill_ms: number;
  /** How the packed POST was executed (sequential until DynamicCache can fork). */
  pack_path?: "sequential" | "prefix" | "single" | "batch";
  /** Number of decoder forwards inside this POST. */
  forwards?: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage;
}

export type PrefillResult = {
  logits: ArrayLike<number>;
  inputTokens: number;
  letterIds: number[];
  ms?: number;
};

export type PrefillFn = (
  messages: Array<{ role: string; content: string }>,
) => Promise<PrefillResult>;

export type PrefillManyFn = (
  batch: Array<Array<{ role: string; content: string }>>,
  opts?: {
    onForward?: (info: { index: number; total: number; ms: number }) => void;
  },
) => Promise<PrefillResult[]>;

/** One GPU session: score questions in order, never in parallel. */
export function sequentialPrefills(prefill: PrefillFn): PrefillManyFn {
  return async (batch) => {
    const out: PrefillResult[] = [];
    for (const messages of batch) out.push(await prefill(messages));
    return out;
  };
}

/** Score every question in a System One body. */
export async function decideLocal(
  body: SystemOneRequest,
  prefillMany: PrefillManyFn,
  opts?: {
    onForward?: (info: { index: number; total: number; ms: number }) => void;
    packPath?: () => "sequential" | "prefix" | "single" | "batch" | undefined;
  },
): Promise<SystemOneResponse> {
  const rendered = renderRequest(body);
  const answers: Record<string, SystemOneAnswer> = {};
  let inputTokens = 0;
  let prefillMs = 0;
  let forwards = 0;

  const results = await prefillMany(
    rendered.map((q) => q.messages),
    {
      onForward: (info) => {
        forwards = info.total;
        opts?.onForward?.(info);
      },
    },
  );
  if (results.length !== rendered.length) {
    throw new Error(
      `packed prefill returned ${results.length} logits for ${rendered.length} questions`,
    );
  }

  for (let i = 0; i < rendered.length; i++) {
    const q = rendered[i]!;
    const { logits, inputTokens: n, letterIds, ms } = results[i]!;
    inputTokens += n;
    if (ms != null) prefillMs += ms;
    const letterLogits = gatherLetterLogits(
      logits,
      letterIds.slice(0, q.options.length),
    );
    answers[q.id] = answerFromScore(q.type, q.options, letterLogits);
  }

  return {
    model: body.model || "tev1:0.8b",
    answers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: rendered.length,
      prefill_ms: prefillMs,
      pack_path: opts?.packPath?.() ?? (rendered.length === 1 ? "single" : "sequential"),
      forwards: forwards || rendered.length,
    },
  };
}

/** Parse the JSON body the Rust transport posts. */
export function parseSystemOneBody(bodyJson: string): SystemOneRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson);
  } catch (e) {
    throw new Error(`non-json body: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("body is not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.model !== "string" || !o.model) throw new Error("missing model");
  if (o.state === undefined || o.state === null) throw new Error("missing state");
  if (!o.questions || typeof o.questions !== "object" || Array.isArray(o.questions)) {
    throw new Error("questions must be an object");
  }
  return {
    model: o.model,
    state: o.state,
    questions: o.questions as SystemOneRequest["questions"],
  };
}
