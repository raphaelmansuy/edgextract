/**
 * WebGPU letter-logit runtime on Transformers.js / ONNX Runtime WebGPU.
 *
 * First principles:
 * 1. config.json says model_type=qwen3_5 → the JS registry must know that type
 *    (@huggingface/transformers >= 4.0; 3.8.x throws Unsupported model type).
 * 2. System One is text-only → prefer Qwen3_5ForCausalLM (embed_tokens + decoder,
 *    no vision_encoder). Cond is the fallback if the text-only graph is missing.
 * 3. System One only needs last-position letter logits (`num_logits_to_keep=1`).
 *    Packed POSTs reuse the system/state KV prefix when the cache can be cloned.
 * 4. Weights in the browser cache ≠ a warm GPU — Load runs one tiny prefill
 *    before reporting ready, so Extract does not pay cold-start in silence.
 *
 * The slow path is an unfused Gated DeltaNet: hundreds of tiny WebGPU dispatches
 * plus 18 `If` nodes (no graph capture). The published graph must be the OPT
 * topology — 18 `LinearAttention` + 18 `CausalConvWithState` — which this ORT
 * Web build already implements as one WGSL scan per layer.
 */

import { LETTERS, TEV1_SYSTEM } from "./prompt";
import { gatherLetterLogits, resolveLetterTokenIds } from "./score";
import { renderChatPlain } from "./prompt";
import { flattenTokenIds } from "./ids";
import {
  formatLoadProgress,
  LoadProgressTracker,
  type TfProgressInfo,
} from "./load-progress";

/**
 * Default WebGPU graph on the Hugging Face Hub: Together Tev1-0.8B ONNX
 * (weight-transplant into the onnx-community Qwen3.5-ONNX-OPT topology).
 * See `docs/THIRD_PARTY_NOTICES.md` — fine-tune license acknowledged at export.
 * A short local id (no `/`) resolves under `{BASE_URL}models/<id>/`.
 */
export const DEFAULT_TEV1_MODEL_ID = "raphaelmansuy/tev1-0.8b-onnx-webgpu";

/**
 * Local ONNX root for Transformers.js (`env.localModelPath`).
 * Uses Vite `BASE_URL` so project Pages (`/edgextract/`) and `./` both work.
 */
export function localModelsBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}models/`;
}

/** Absolute-or-relative URL for a short local model id folder. */
export function localModelUrl(modelId: string): string {
  const id = modelId.replace(/^\/+|\/+$/g, "");
  return `${localModelsBase()}${id}`;
}

/**
 * Pin Hub Cache Storage to the fused LinearAttention commit. Publishing a new
 * blob at `revision=main` does not change the cache URL — an open tab would keep
 * the unfused 960-node graph. Local folders ignore this.
 */
export const DEFAULT_TEV1_HUB_REVISION = "26a904f1d138eddc711f9f116e045bffc1924dbd";

/** Session dtypes for the published Tev1 slice (embed fp16 + MatMulNBits decoder). */
export const TEV1_WEBGPU_DTYPE = {
  embed_tokens: "fp16",
  decoder_model_merged: "q4f16",
  vision_encoder: "q4f16",
} as const;

/**
 * Sibling ``*.onnx_data`` chunk counts. Transformers.js only mounts external
 * weights when this is set (config.json ``transformers.js_config`` or here).
 * Without it ORT Web fails with ``Module.MountedFiles is not available``.
 */
export const TEV1_EXTERNAL_DATA_FORMAT = {
  embed_tokens: 1,
  decoder_model_merged: 1,
  vision_encoder: 1,
} as const;

/** Fail closed if cold WebGPU compile / first prefill stalls. */
export const WARM_TIMEOUT_MS = 60_000;
export const PREFILL_TIMEOUT_MS = 60_000;

/**
 * Warmup at a real System One length so Extract does not pay first-pipeline
 * compile on a toy 2-option prompt.
 */
const WARM_MESSAGES: Array<{ role: "system" | "user"; content: string }> = [
  { role: "system", content: TEV1_SYSTEM },
  {
    role: "user",
    content: JSON.stringify({
      state:
        "# Northwind raises a round\n\nAda Lovelace founded Northwind in Paris. " +
        "Northwind is headquartered in Paris. Acme Inc invested in Northwind. " +
        "Jane Doe works for Acme Inc in Berlin.",
      question: "Is Northwind a company mentioned in the text?",
      options: [
        { label: "A", key: "yes", description: "Yes" },
        { label: "B", key: "no", description: "No" },
        { label: "C", key: "unclear", description: "Not enough information" },
      ],
    }),
  },
];

/** Packed-prefill path used for the last System One POST. */
export type PrefillPackPath = "sequential" | "prefix" | "single" | "batch";

export interface PrefillPackStats {
  path: PrefillPackPath;
  questions: number;
  forwards: number;
  total_ms: number;
}

export interface GraphFingerprint {
  /** Last dim of `past_conv.0`: 3 = fused OPT, 4 = unfused legacy. */
  past_conv0_last_dim: number | null;
  kind: "fused-opt" | "unfused-legacy" | "unknown";
  revision: string | null;
}

export interface LengthSweepPoint {
  tokens: number;
  ms: number;
}

export interface Tev1BenchReport {
  fingerprint: GraphFingerprint;
  warm_ms: number;
  length_sweep: LengthSweepPoint[];
  /** Rough slope ms/token between shortest and longest sweep points. */
  ms_per_token: number | null;
  /** Max |Δ| on letter logits: unpadded vs left-padded to 2× length. */
  pad_logit_max_abs_delta: number | null;
  /** True when left-pad does not change letter scores (safe to batch). */
  pad_safe: boolean | null;
  recommendation: "sequential" | "batch" | "prefix-fork";
}

/** True for Hub ids (`org/name`); false for local folders under /models/. */
export function isHubModelId(modelId: string): boolean {
  return modelId.includes("/") && !modelId.startsWith(".") && !modelId.startsWith("/");
}

/**
 * Transformers.js stores Hub files under the remote resolve URL
 * (`{model}/resolve/{revision}/…`). A matching entry cannot be SPA HTML at
 * `/models/…` or an unfused graph at `/resolve/main/`.
 */
export function hubCacheUrlMatchesRevision(url: string, revision: string): boolean {
  return revision.length > 0 && url.includes(`/resolve/${revision}/`);
}

/** Minimal Cache Storage shape so tests can inject a fake (no browser). */
export type HubCacheBucket = {
  keys: () => Promise<readonly { url: string }[]>;
  delete: (request: { url: string }) => Promise<boolean>;
};

export type HubCacheStorage = {
  keys: () => Promise<string[]>;
  open: (name: string) => Promise<HubCacheBucket>;
};

/**
 * Drop Cache Storage *requests* that are not the pinned Hub revision.
 * Leaves the cache name in place so a hit on the pinned URL still works.
 */
export async function evictHubCacheExceptRevision(
  revision: string,
  storage: HubCacheStorage,
): Promise<void> {
  const names = await storage.keys();
  await Promise.all(
    names.map(async (name) => {
      const cache = await storage.open(name);
      const requests = await cache.keys();
      await Promise.all(
        requests.map((req) =>
          hubCacheUrlMatchesRevision(req.url, revision) ? Promise.resolve(false) : cache.delete(req),
        ),
      );
    }),
  );
}

export type LoadProgress = (msg: string, frac?: number) => void;

export interface Tev1RuntimeStatus {
  ready: boolean;
  modelId: string;
  device: "webgpu" | "wasm" | "none";
  warmed: boolean;
  error?: string;
  fingerprint?: GraphFingerprint;
  lastPack?: PrefillPackStats;
}

type PrefillOutputs = {
  logits: { data: ArrayLike<number>; dims: number[] };
  past_key_values?: { dispose?: () => Promise<void> | void; get_seq_length?: () => number };
};

type TensorLike = { data: ArrayLike<number | bigint>; dims: number[] };
type TensorCtor = new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => TensorLike;

type TokenizerLike = {
  encode: (text: string, opts?: Record<string, unknown>) => number[] | Int32Array;
  apply_chat_template?: (
    messages: Array<{ role: string; content: string }>,
    opts: Record<string, unknown>,
  ) => unknown;
  (...args: unknown[]): unknown;
};

type ModelMethods = {
  forward?: (inputs: Record<string, unknown>) => Promise<PrefillOutputs>;
  call?: (inputs: Record<string, unknown>) => Promise<PrefillOutputs>;
};
/** Transformers.js models are Callables (typeof === "function") with .forward. */
type ModelLike = ModelMethods | ((inputs: Record<string, unknown>) => Promise<PrefillOutputs>);

type SessionMeta = { name: string; shape?: Array<number | string> };
type SessionLike = { inputMetadata?: SessionMeta[]; inputNames?: string[] };
type ModelWithSessions = {
  sessions?: Record<string, SessionLike | undefined>;
};

type PretrainedCtor = {
  from_pretrained: (id: string, opts: Record<string, unknown>) => Promise<ModelLike>;
};

type TransformersNs = Record<string, unknown> & {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    useBrowserCache: boolean;
    localModelPath: string;
  };
  AutoTokenizer: {
    from_pretrained: (id: string, opts: Record<string, unknown>) => Promise<TokenizerLike>;
  };
};

/** Resolve a named export whether the module is a namespace or `{ default: ns }`. */
function exportOf<T>(mod: Record<string, unknown>, name: string): T | undefined {
  const direct = mod[name];
  if (direct != null) return direct as T;
  const def = mod.default;
  if (def && typeof def === "object" && name in (def as object)) {
    return (def as Record<string, unknown>)[name] as T;
  }
  return undefined;
}

function transformersFingerprint(mod: Record<string, unknown>): string {
  const has35 = !!exportOf(mod, "Qwen3_5ForConditionalGeneration") || !!exportOf(mod, "Qwen3_5ForCausalLM");
  const has3 = !!exportOf(mod, "Qwen3ForCausalLM");
  if (has35) return ">=4.0 (qwen3_5)";
  if (has3) return "3.x (Qwen3 only — stale cache?)";
  return "unknown / incomplete module";
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} timed out after ${Math.round(ms / 1000)}s. ` +
                `Switch to Ollama host, or reload and try Load again.`,
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Qwen3.5 is a Callable: `model(inputs)` → `_call` → multimodal text forward.
 * Prefer that path; never hang on a speculative API with no clear error.
 */
async function invokeModel(model: ModelLike, inputs: Record<string, unknown>): Promise<PrefillOutputs> {
  if (typeof model === "function") {
    return await model(inputs);
  }
  const methods = model as ModelMethods;
  if (typeof methods.call === "function") {
    return await methods.call(inputs);
  }
  if (typeof methods.forward === "function") {
    return await methods.forward(inputs);
  }
  throw new Error(
    "Tev1 model has no callable inference path. Need Transformers.js Callable / Qwen3.5 session.",
  );
}

/** Last-position vocab logits for one batch row (default row 0). */
function lastTokenLogits(logits: PrefillOutputs["logits"], batchIndex = 0): Float32Array {
  const data = logits.data;
  const dims = logits.dims;
  // [batch, seq, vocab] or [batch, vocab] when only the last position is kept.
  if (dims.length >= 3) {
    const batch = dims[0] ?? 1;
    const seq = dims[1] ?? 1;
    const vocab = dims[2] ?? data.length;
    const b = Math.min(Math.max(0, batchIndex), batch - 1);
    const offset = (b * seq + (seq - 1)) * vocab;
    const slice = new Float32Array(vocab);
    for (let i = 0; i < vocab; i++) slice[i] = Number(data[offset + i]);
    return slice;
  }
  if (dims.length === 2) {
    const batch = dims[0] ?? 1;
    const vocab = dims[1] ?? data.length;
    const b = Math.min(Math.max(0, batchIndex), batch - 1);
    const offset = b * vocab;
    const slice = new Float32Array(vocab);
    for (let i = 0; i < vocab; i++) slice[i] = Number(data[offset + i]);
    return slice;
  }
  const slice = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) slice[i] = Number(data[i]);
  return slice;
}

async function preferHighPerformanceGpu(): Promise<void> {
  const gpu =
    typeof navigator !== "undefined"
      ? (
          navigator as {
            gpu?: { requestAdapter: (opts?: { powerPreference?: string }) => Promise<unknown> };
          }
        ).gpu
      : undefined;
  if (!gpu?.requestAdapter) return;
  try {
    await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    /* ORT requests its own adapter; this is a preference hint. */
  }
}

export class Tev1Runtime {
  private tokenizer: TokenizerLike | null = null;
  private model: ModelLike | null = null;
  private letterIds: number[] | null = null;
  private Tensor: TensorCtor | null = null;
  private modelId = DEFAULT_TEV1_MODEL_ID;
  private hubRevision: string | null = null;
  private device: "webgpu" | "wasm" | "none" = "none";
  private warmed = false;
  private error: string | undefined;
  private fingerprint: GraphFingerprint = {
    past_conv0_last_dim: null,
    kind: "unknown",
    revision: null,
  };
  private lastPack: PrefillPackStats | undefined;
  private warmMs = 0;
  /** Set after warm pad-probe: left-pad does not change letter logits. */
  private batchSafe = false;

  status(): Tev1RuntimeStatus {
    return {
      ready: this.model != null && this.tokenizer != null && this.warmed,
      modelId: this.modelId,
      device: this.device,
      warmed: this.warmed,
      error: this.error,
      fingerprint: this.fingerprint,
      lastPack: this.lastPack,
    };
  }

  async load(modelId: string, onProgress?: LoadProgress): Promise<void> {
    this.modelId = modelId || DEFAULT_TEV1_MODEL_ID;
    this.error = undefined;
    this.warmed = false;
    const tracker = new LoadProgressTracker();
    const emit = (view: ReturnType<LoadProgressTracker["setPhase"]>) => {
      const { message, frac } = formatLoadProgress(view);
      onProgress?.(message, frac);
    };
    emit(tracker.setPhase("check"));

    const gpu =
      typeof navigator !== "undefined"
        ? (navigator as { gpu?: { requestAdapter: (opts?: { powerPreference?: string }) => Promise<unknown> } }).gpu
        : undefined;
    if (!gpu) {
      throw new Error(
        "WebGPU is not available in this browser. Use the Ollama host, or open the page in a browser with WebGPU.",
      );
    }
    await preferHighPerformanceGpu();

    // Namespace import — avoid fragile destructuring that can miss live bindings in workers.
    const mod = (await import("@huggingface/transformers")) as unknown as TransformersNs;
    const fp = transformersFingerprint(mod);
    const AutoTokenizer = exportOf<TransformersNs["AutoTokenizer"]>(mod, "AutoTokenizer");
    const env = exportOf<TransformersNs["env"]>(mod, "env");
    const Cond = exportOf<PretrainedCtor>(mod, "Qwen3_5ForConditionalGeneration");
    const Causal = exportOf<PretrainedCtor>(mod, "Qwen3_5ForCausalLM");
    const AutoCausal = exportOf<PretrainedCtor>(mod, "AutoModelForCausalLM");
    this.Tensor = exportOf<TensorCtor>(mod, "Tensor") ?? null;

    if (!AutoTokenizer || !env) {
      throw new Error(
        `Transformers.js module is incomplete (${fp}). Hard-reload the tab (Cmd+Shift+R), or restart the demo server.`,
      );
    }
    if (!Cond && !Causal && !AutoCausal) {
      throw new Error(
        `No model classes in Transformers.js (${fp}). Need @huggingface/transformers >= 4.0. Hard-reload, or use Ollama.`,
      );
    }

    const hub = isHubModelId(this.modelId);
    this.hubRevision = hub ? DEFAULT_TEV1_HUB_REVISION : null;
    // Hub ids: skip `/models/{org}/{name}/…`. A missing file that SPA-falls
    // through as 200 HTML is JSON.parsed as config ("Unexpected token '<'").
    env.allowLocalModels = !hub;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.localModelPath = localModelsBase();

    // Drop poisoned Cache Storage requests (SPA HTML under /models/org/name,
    // or graphs at other revisions including main). Keep the pinned resolve
    // URL so useBrowserCache can hit ~950 MB on the next Load.
    if (hub && typeof caches !== "undefined") {
      try {
        await evictHubCacheExceptRevision(DEFAULT_TEV1_HUB_REVISION, {
          keys: () => caches.keys(),
          open: async (name) => {
            const cache = await caches.open(name);
            return {
              keys: async () => (await cache.keys()).map((req) => ({ url: req.url })),
              delete: ({ url }) => cache.delete(url),
            };
          },
        });
      } catch {
        /* private mode / blocked Cache API */
      }
    }

    const hubOpts: Record<string, unknown> = hub
      ? { revision: DEFAULT_TEV1_HUB_REVISION }
      : {};

    emit(
      tracker.setPhase(
        "tokenizer",
        hub ? `${this.modelId}@${DEFAULT_TEV1_HUB_REVISION.slice(0, 8)}` : "local /models",
      ),
    );
    this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId, {
      local_files_only: !hub,
      ...hubOpts,
      progress_callback: ((info: TfProgressInfo) => {
        const view = tracker.onTfProgress(info);
        if (view) emit(view);
      }) as never,
    });

    emit(
      tracker.setPhase(
        "weights",
        hub ? `${this.modelId}@${DEFAULT_TEV1_HUB_REVISION.slice(0, 8)}` : "local /models",
      ),
    );
    // Byte events stop before ORT builds the WebGPU session — crawl so the bar never freezes.
    let compileTimer: ReturnType<typeof setInterval> | undefined;
    const startCompileCrawl = () => {
      if (compileTimer) return;
      emit(tracker.setPhase("compile"));
      compileTimer = setInterval(() => emit(tracker.tickCompile()), 250);
    };
    const stopCompileCrawl = () => {
      if (compileTimer) clearInterval(compileTimer);
      compileTimer = undefined;
    };
    const onWeightProgress = (info: TfProgressInfo) => {
      const view = tracker.onTfProgress(info);
      if (view) emit(view);
      if (info.status === "done" || (info.status === "progress_total" && (info.progress ?? 0) >= 99.5)) {
        startCompileCrawl();
      }
    };

    const session_options: Record<string, unknown> = {
      // WebGPU EP: disable CPU mem-pattern packing (ORT docs).
      enableMemPattern: false,
      // Variable System One lengths + hybrid GDN: capture needs static shapes.
      enableGraphCapture: false,
    };
    const multimodalOpts: Record<string, unknown> = {
      device: "webgpu",
      local_files_only: !hub,
      ...hubOpts,
      dtype: { ...TEV1_WEBGPU_DTYPE },
      use_external_data_format: { ...TEV1_EXTERNAL_DATA_FORMAT },
      session_options,
      progress_callback: onWeightProgress,
    };
    const textOpts: Record<string, unknown> = {
      device: "webgpu",
      local_files_only: !hub,
      ...hubOpts,
      dtype: {
        embed_tokens: TEV1_WEBGPU_DTYPE.embed_tokens,
        decoder_model_merged: TEV1_WEBGPU_DTYPE.decoder_model_merged,
      },
      use_external_data_format: {
        embed_tokens: TEV1_EXTERNAL_DATA_FORMAT.embed_tokens,
        decoder_model_merged: TEV1_EXTERNAL_DATA_FORMAT.decoder_model_merged,
      },
      session_options,
      progress_callback: onWeightProgress,
    };

    // Text-only first: System One never needs vision; CausalLM skips that session.
    const attempts: Array<{ name: string; run: () => Promise<ModelLike> }> = [];
    if (Causal) {
      attempts.push({
        name: "Qwen3_5ForCausalLM",
        run: () => Causal.from_pretrained(this.modelId, textOpts),
      });
    }
    if (AutoCausal) {
      attempts.push({
        name: "AutoModelForCausalLM",
        run: () => AutoCausal.from_pretrained(this.modelId, textOpts),
      });
    }
    if (Cond) {
      attempts.push({
        name: "Qwen3_5ForConditionalGeneration",
        run: () => Cond.from_pretrained(this.modelId, multimodalOpts),
      });
    }

    const errors: string[] = [];
    try {
      for (const attempt of attempts) {
        try {
          startCompileCrawl();
          this.model = await attempt.run();
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${attempt.name}: ${msg}`);
          if (/Unsupported model type:\s*qwen3_5/i.test(msg)) {
            throw new Error(
              `Unsupported model type: qwen3_5 — this tab still has Transformers.js 3.x (${fp}). ` +
                `Hard-reload (Cmd+Shift+R), restart \`make demo\`, ensure package >= 4.0. Or use Ollama.`,
            );
          }
        }
      }
    } finally {
      stopCompileCrawl();
    }

    if (!this.model) {
      throw new Error(
        `Failed to load qwen3_5 graph ${this.modelId} (${fp}). ` + errors.join(" | "),
      );
    }

    this.device = "webgpu";
    this.fingerprint = fingerprintGraph(this.model, this.hubRevision);
    if (this.fingerprint.kind === "unfused-legacy") {
      throw new Error(
        `Loaded unfused Qwen3.5 graph (past_conv.0 last dim=` +
          `${this.fingerprint.past_conv0_last_dim}). Need the ONNX-OPT transplant ` +
          `(LinearAttention). Hard-reload, clear site data for this origin, or use ` +
          `Hub revision ${DEFAULT_TEV1_HUB_REVISION.slice(0, 8)}.`,
      );
    }
    const encode = (text: string): number[] => {
      const out = this.tokenizer!.encode(text, { add_special_tokens: false });
      return Array.from(out as ArrayLike<number>);
    };
    this.letterIds = resolveLetterTokenIds(encode, LETTERS);

    // Weights may already be in Cache Storage; this is the compute warm.
    emit(
      tracker.setPhase(
        "warm",
        `${this.fingerprint.kind} · ${hub ? "weights cached — waking GPU" : "weights ready — waking GPU"}`,
      ),
    );
    let warmTimer: ReturnType<typeof setInterval> | undefined;
    try {
      warmTimer = setInterval(() => emit(tracker.tickWarm()), 200);
      await this.warm();
    } finally {
      if (warmTimer) clearInterval(warmTimer);
    }
    emit(tracker.setPhase("ready", `${this.fingerprint.kind} · cached · GPU warmed`));
  }

  /**
   * One System One–length letter-logit prefill after Load. Pays WebGPU/ORT
   * cold-start here (with progress), not silently on the first Extract call.
   */
  async warm(): Promise<void> {
    if (!this.model || !this.tokenizer || !this.letterIds) {
      throw new Error("Tev1 WebGPU runtime is not loaded");
    }
    const t0 = performance.now();
    const base = await this.prefill(WARM_MESSAGES, {
      timeoutMs: WARM_TIMEOUT_MS,
      label: "WebGPU warmup",
    });
    this.batchSafe = await this.probePadSafety(base.logits);
    this.warmMs = Math.round(performance.now() - t0);
    this.warmed = true;
  }

  /** Left-pad must not move letter logits — otherwise batched prefills are unsafe. */
  private async probePadSafety(baseLogits: Float32Array): Promise<boolean> {
    if (!this.Tensor || !this.tokenizer) return false;
    const { ids: baseIds } = this.tokenize(WARM_MESSAGES);
    const padId = Number(
      (this.tokenizer as { pad_token_id?: number; eos_token_id?: number }).pad_token_id ??
        (this.tokenizer as { eos_token_id?: number }).eos_token_id ??
        0,
    );
    const padLen = Math.max(8, baseIds.length);
    const padded = new Array(padLen).fill(padId).concat(baseIds);
    const padMask = padded.map((_, i) => (i < padLen ? 0 : 1));
    const padStep = await this.forwardIds(
      padded,
      this.int64Matrix(padded),
      this.int64Matrix(padMask),
      { timeoutMs: PREFILL_TIMEOUT_MS, label: "WebGPU pad-probe" },
    );
    let maxDelta = 0;
    const n = Math.min(baseLogits.length, padStep.logits.length);
    for (let i = 0; i < n; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(baseLogits[i]! - padStep.logits[i]!));
    }
    return maxDelta < 0.05;
  }

  /**
   * Microbench for the e2e harness: fingerprint + warm length-sweep.
   * Caller must have already loaded (and preferably warmed) the runtime.
   */
  async bench(lengths: number[] = [32, 128, 256]): Promise<Tev1BenchReport> {
    if (!this.model || !this.tokenizer || !this.letterIds || !this.Tensor) {
      throw new Error("Tev1 WebGPU runtime is not loaded");
    }
    // Discard one short forward so the first timed length is not a cold shader hit.
    {
      const ids = new Array(16).fill(1);
      await this.forwardIds(ids, this.int64Matrix(ids), this.int64Matrix(ids.map(() => 1)), {
        timeoutMs: PREFILL_TIMEOUT_MS,
        label: "WebGPU sweep warm",
      });
    }
    const sweep: LengthSweepPoint[] = [];
    for (const n of lengths) {
      const ids = new Array(n).fill(1);
      const inputIds = this.int64Matrix(ids);
      const mask = this.int64Matrix(ids.map(() => 1));
      const step = await this.forwardIds(ids, inputIds, mask, {
        timeoutMs: PREFILL_TIMEOUT_MS,
        label: `WebGPU sweep L=${n}`,
      });
      sweep.push({ tokens: n, ms: step.ms });
    }
    const first = sweep[0];
    const last = sweep[sweep.length - 1];
    let msPerToken: number | null = null;
    if (first && last && last.tokens > first.tokens && last.ms >= first.ms) {
      msPerToken = (last.ms - first.ms) / (last.tokens - first.tokens);
    }

    const base = await this.prefill(WARM_MESSAGES, {
      timeoutMs: PREFILL_TIMEOUT_MS,
      label: "WebGPU pad-base",
    });
    const { ids: baseIds } = this.tokenize(WARM_MESSAGES);
    const padId = Number(
      (this.tokenizer as { pad_token_id?: number; eos_token_id?: number }).pad_token_id ??
        (this.tokenizer as { eos_token_id?: number }).eos_token_id ??
        0,
    );
    const padLen = Math.max(8, baseIds.length);
    const padded = new Array(padLen).fill(padId).concat(baseIds);
    const padMask = padded.map((_, i) => (i < padLen ? 0 : 1));
    const padStep = await this.forwardIds(
      padded,
      this.int64Matrix(padded),
      this.int64Matrix(padMask),
      { timeoutMs: PREFILL_TIMEOUT_MS, label: "WebGPU pad-probe" },
    );
    let maxDelta = 0;
    const nLett = Math.min(base.logits.length, padStep.logits.length);
    for (let i = 0; i < nLett; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(base.logits[i]! - padStep.logits[i]!));
    }
    const padSafe = maxDelta < 0.05;
    this.batchSafe = padSafe;
    const flat = msPerToken != null && msPerToken < 0.5;
    const recommendation: Tev1BenchReport["recommendation"] =
      flat && padSafe ? "batch" : "sequential";
    return {
      fingerprint: this.fingerprint,
      warm_ms: this.warmMs,
      length_sweep: sweep,
      ms_per_token: msPerToken,
      pad_logit_max_abs_delta: maxDelta,
      pad_safe: padSafe,
      recommendation,
    };
  }

  /**
   * One prefill; returns vocab logits at the last prompt token.
   * Thinking is disabled via the chat template kwargs when supported.
   */
  async prefill(
    messages: Array<{ role: string; content: string }>,
    opts?: {
      timeoutMs?: number;
      label?: string;
      past_key_values?: PrefillOutputs["past_key_values"];
      keepCache?: boolean;
    },
  ): Promise<{
    logits: Float32Array;
    inputTokens: number;
    letterIds: number[];
    past_key_values?: PrefillOutputs["past_key_values"];
    ms: number;
  }> {
    if (!this.model || !this.tokenizer || !this.letterIds) {
      throw new Error("Tev1 WebGPU runtime is not loaded");
    }

    const { ids, inputIds, attentionMask } = this.tokenize(messages);
    return this.forwardIds(ids, inputIds, attentionMask, opts);
  }

  /**
   * Packed System One prefills. Transformers.js `DynamicCache` has no `clone`,
   * so a stem forward would be discarded — skip it and run independent
   * last-token prefills until a GPU fork of past_conv/recurrent exists.
   */
  async prefillMany(
    batch: Array<Array<{ role: string; content: string }>>,
    opts?: {
      timeoutMs?: number;
      onForward?: (info: { index: number; total: number; ms: number }) => void;
    },
  ): Promise<
    Array<{ logits: Float32Array; inputTokens: number; letterIds: number[]; ms: number }>
  > {
    if (batch.length === 0) {
      this.lastPack = { path: "sequential", questions: 0, forwards: 0, total_ms: 0 };
      return [];
    }
    if (batch.length === 1) {
      const one = await this.prefill(batch[0]!, opts);
      opts?.onForward?.({ index: 0, total: 1, ms: one.ms });
      this.lastPack = { path: "single", questions: 1, forwards: 1, total_ms: one.ms };
      return [one];
    }

    // Prefix reuse needs a forkable DynamicCache (TF.js 4.3 has none).
    // When left-pad is score-safe, one batched forward reads q4 weights once.
    if (this.batchSafe) {
      try {
        return await this.prefillBatched(batch, opts);
      } catch {
        /* fall through to sequential */
      }
    }
    return this.prefillSequential(batch, opts);
  }

  /**
   * Left-pad to a common length and run one decoder forward for the whole POST.
   * Requires {@link batchSafe} (LinearAttention / GQA ignore pad positions).
   */
  private async prefillBatched(
    batch: Array<Array<{ role: string; content: string }>>,
    opts?: {
      timeoutMs?: number;
      onForward?: (info: { index: number; total: number; ms: number }) => void;
    },
  ): Promise<
    Array<{ logits: Float32Array; inputTokens: number; letterIds: number[]; ms: number }>
  > {
    if (!this.model || !this.letterIds || !this.Tensor) {
      throw new Error("Tev1 WebGPU runtime is not loaded");
    }
    const tokenized = batch.map((m) => this.tokenize(m));
    const maxLen = Math.max(...tokenized.map((t) => t.ids.length));
    const padId = Number(
      (this.tokenizer as { pad_token_id?: number; eos_token_id?: number } | null)?.pad_token_id ??
        (this.tokenizer as { eos_token_id?: number } | null)?.eos_token_id ??
        0,
    );
    const B = tokenized.length;
    const idsFlat = new BigInt64Array(B * maxLen);
    const maskFlat = new BigInt64Array(B * maxLen);
    for (let b = 0; b < B; b++) {
      const ids = tokenized[b]!.ids;
      const pad = maxLen - ids.length;
      for (let i = 0; i < pad; i++) {
        idsFlat[b * maxLen + i] = BigInt(padId);
        maskFlat[b * maxLen + i] = 0n;
      }
      for (let i = 0; i < ids.length; i++) {
        idsFlat[b * maxLen + pad + i] = BigInt(ids[i]!);
        maskFlat[b * maxLen + pad + i] = 1n;
      }
    }
    const inputIds = new this.Tensor("int64", idsFlat, [B, maxLen]);
    const attentionMask = new this.Tensor("int64", maskFlat, [B, maxLen]);
    const inputs: Record<string, unknown> = {
      input_ids: inputIds,
      attention_mask: attentionMask,
      num_logits_to_keep: this.lastTokenKeep(),
    };
    const t0 = performance.now();
    const outputs = await withTimeout(
      invokeModel(this.model, inputs),
      opts?.timeoutMs ?? PREFILL_TIMEOUT_MS,
      "WebGPU batched prefill",
    );
    const ms = Math.round(performance.now() - t0);
    if (!outputs?.logits?.data || !outputs.logits.dims) {
      throw new Error("batched prefill returned no logits");
    }
    await disposeCache(outputs.past_key_values);
    const out: Array<{
      logits: Float32Array;
      inputTokens: number;
      letterIds: number[];
      ms: number;
    }> = [];
    const perMs = Math.max(1, Math.round(ms / B));
    for (let b = 0; b < B; b++) {
      const slice = lastTokenLogits(outputs.logits, b);
      const letters = gatherLetterLogits(slice, this.letterIds);
      out.push({
        logits: Float32Array.from(letters),
        inputTokens: tokenized[b]!.ids.length,
        letterIds: this.letterIds.map((_, i) => i),
        ms: perMs,
      });
      opts?.onForward?.({ index: b, total: B, ms: perMs });
    }
    this.lastPack = {
      path: "batch",
      questions: B,
      forwards: 1,
      total_ms: ms,
    };
    return out;
  }

  private async prefillSequential(
    batch: Array<Array<{ role: string; content: string }>>,
    opts?: {
      timeoutMs?: number;
      onForward?: (info: { index: number; total: number; ms: number }) => void;
    },
  ): Promise<
    Array<{ logits: Float32Array; inputTokens: number; letterIds: number[]; ms: number }>
  > {
    const out: Array<{
      logits: Float32Array;
      inputTokens: number;
      letterIds: number[];
      ms: number;
    }> = [];
    let totalMs = 0;
    for (let i = 0; i < batch.length; i++) {
      const step = await this.prefill(batch[i]!, opts);
      totalMs += step.ms;
      opts?.onForward?.({ index: i, total: batch.length, ms: step.ms });
      out.push(step);
    }
    this.lastPack = {
      path: "sequential",
      questions: batch.length,
      forwards: batch.length,
      total_ms: totalMs,
    };
    return out;
  }

  private tokenize(messages: Array<{ role: string; content: string }>): {
    ids: number[];
    inputIds: TensorLike;
    attentionMask?: TensorLike;
  } {
    if (!this.tokenizer) throw new Error("Tev1 tokenizer is not loaded");
    let inputIds: TensorLike;
    let attentionMask: TensorLike | undefined;
    try {
      const applied = this.tokenizer.apply_chat_template?.(messages, {
        tokenize: true,
        return_tensor: "pt",
        add_generation_prompt: true,
        enable_thinking: false,
      }) as Record<string, TensorLike> | TensorLike;

      if (applied && typeof applied === "object" && "input_ids" in applied) {
        inputIds = applied.input_ids as TensorLike;
        attentionMask = applied.attention_mask as TensorLike | undefined;
      } else if (applied && typeof applied === "object" && "data" in applied && "dims" in applied) {
        inputIds = applied as TensorLike;
      } else {
        throw new Error("chat template returned unexpected shape");
      }
    } catch {
      const text = renderChatPlain(
        messages as Array<{ role: "system" | "user"; content: string }>,
      );
      const encoded = this.tokenizer(text, { return_tensor: "pt" }) as Record<string, TensorLike>;
      if (!encoded?.input_ids) {
        throw new Error("Tokenizer failed to produce input_ids for Tev1 prefill");
      }
      inputIds = encoded.input_ids;
      attentionMask = encoded.attention_mask;
    }
    if (!inputIds?.dims?.length) {
      throw new Error("Tev1 prefill got empty input_ids — check the chat template / tokenizer");
    }
    return { ids: flattenTokenIds(inputIds.data), inputIds, attentionMask };
  }

  private int64Matrix(ids: number[]): TensorLike {
    if (!this.Tensor) throw new Error("Transformers.js Tensor is missing");
    const data = BigInt64Array.from(ids.map((n) => BigInt(n)));
    return new this.Tensor("int64", data, [1, ids.length]);
  }

  private lastTokenKeep(): TensorLike | 1n {
    if (!this.Tensor) return 1n;
    return new this.Tensor("int64", BigInt64Array.from([1n]), []);
  }

  private async forwardIds(
    ids: number[],
    inputIds: TensorLike,
    attentionMask: TensorLike | undefined,
    opts?: {
      timeoutMs?: number;
      label?: string;
      past_key_values?: PrefillOutputs["past_key_values"];
      position_ids?: TensorLike;
      keepCache?: boolean;
    },
  ): Promise<{
    logits: Float32Array;
    inputTokens: number;
    letterIds: number[];
    past_key_values?: PrefillOutputs["past_key_values"];
    ms: number;
  }> {
    if (!this.model || !this.letterIds) {
      throw new Error("Tev1 WebGPU runtime is not loaded");
    }
    const inputs: Record<string, unknown> = {
      input_ids: inputIds,
      num_logits_to_keep: this.lastTokenKeep(),
    };
    if (attentionMask) inputs.attention_mask = attentionMask;
    if (opts?.past_key_values) inputs.past_key_values = opts.past_key_values;
    if (opts?.position_ids) inputs.position_ids = opts.position_ids;

    const t0 = performance.now();
    const outputs = await withTimeout(
      invokeModel(this.model, inputs),
      opts?.timeoutMs ?? PREFILL_TIMEOUT_MS,
      opts?.label ?? "WebGPU prefill",
    );
    const ms = Math.round(performance.now() - t0);

    if (!outputs?.logits?.data || !outputs.logits.dims) {
      throw new Error("Tev1 prefill returned no logits — model call path is wrong for Qwen3.5");
    }

    const slice = lastTokenLogits(outputs.logits);
    const letters = gatherLetterLogits(slice, this.letterIds);
    const compact = Float32Array.from(letters);
    const letterIds = this.letterIds.map((_, i) => i);
    const past = outputs.past_key_values;
    if (!opts?.keepCache) await disposeCache(past);

    return {
      logits: compact,
      inputTokens: ids.length,
      letterIds,
      past_key_values: opts?.keepCache ? past : undefined,
      ms,
    };
  }

  dispose(): void {
    this.model = null;
    this.tokenizer = null;
    this.letterIds = null;
    this.Tensor = null;
    this.device = "none";
    this.warmed = false;
    this.hubRevision = null;
    this.lastPack = undefined;
    this.warmMs = 0;
    this.batchSafe = false;
    this.fingerprint = { past_conv0_last_dim: null, kind: "unknown", revision: null };
  }
}

async function disposeCache(cache: PrefillOutputs["past_key_values"]): Promise<void> {
  try {
    await cache?.dispose?.();
  } catch {
    /* cache may already be consumed */
  }
}

/** Read `past_conv.0` last dim from the decoder session (3 = fused OPT, 4 = legacy). */
export function fingerprintGraph(
  model: unknown,
  revision: string | null,
): GraphFingerprint {
  const sessions = (model as ModelWithSessions | null)?.sessions;
  const decoder =
    sessions?.decoder_model_merged ??
    sessions?.["decoder_model_merged"] ??
    Object.values(sessions ?? {})[0];
  let dim: number | null = null;
  const metas = decoder?.inputMetadata;
  if (Array.isArray(metas)) {
    const past = metas.find((m) => m.name === "past_conv.0" || m.name.endsWith("past_conv.0"));
    const shape = past?.shape;
    if (Array.isArray(shape) && shape.length > 0) {
      const last = shape[shape.length - 1];
      if (typeof last === "number") dim = last;
    }
  }
  const kind: GraphFingerprint["kind"] =
    dim === 3 ? "fused-opt" : dim === 4 ? "unfused-legacy" : "unknown";
  return { past_conv0_last_dim: dim, kind, revision };
}

/** Probe whether this browsing context can try WebGPU Tev1. */
export async function probeWebGpu(): Promise<{ ok: boolean; reason?: string }> {
  const gpu =
    typeof navigator !== "undefined"
      ? (navigator as { gpu?: { requestAdapter: (opts?: { powerPreference?: string }) => Promise<unknown> } }).gpu
      : undefined;
  if (!gpu) {
    return { ok: false, reason: "This browser has no WebGPU (navigator.gpu)." };
  }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ok: false, reason: "No WebGPU adapter is available." };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "WebGPU probe failed." };
  }
}
