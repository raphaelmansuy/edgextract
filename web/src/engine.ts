import type {
  HostConfig,
  OntologyFile,
  OntologyInfo,
  Plan,
  Progress,
  RunOutput,
  RunRequest,
  WorkerIn,
  WorkerOut,
} from "./types";

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** The engine failed part-way. `partial` is whatever it had read before that. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly partial?: RunOutput,
  ) {
    super(message);
  }
}

export interface CallEvent {
  state: "start" | "end";
  n: number;
  ms?: number;
  /** Mean GPU prefill time inside a packed System One POST (WebGPU). */
  prefillMs?: number;
  questions?: number;
  forwards?: number;
  packPath?: string;
}

export interface RunHandlers {
  /** Called after every section. `output` is present when the graph should be repainted. */
  onProgress?: (progress: Progress, output: RunOutput | null) => void;
}

export interface RunResult {
  output: RunOutput;
  /** True when it was stopped before the end. */
  stopped: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: RunHandlers["onProgress"];
}

/** Promise wrapper around the engine worker. */
export class EngineClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private next = 1;
  /** Fired around every model call, from inside the worker. */
  onCall: (e: CallEvent) => void = () => {};

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      if ("kind" in m && m.kind === "call") {
        this.onCall({
          state: m.state,
          n: m.n,
          ms: m.ms,
          prefillMs: m.prefillMs,
          questions: m.questions,
          forwards: m.forwards,
          packPath: m.packPath,
        });
        return;
      }
      if ("kind" in m && m.kind === "webgpu-progress") {
        this.onWebGpuProgress(m.message, m.frac);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      if ("kind" in m && m.kind === "progress") {
        p.onProgress?.(m.progress, m.output);
        return;
      }
      this.pending.delete(m.id);
      if ("ok" in m && m.ok) p.resolve(m.data);
      else if ("ok" in m) p.reject(new EngineError(m.error, m.partial));
    };
    this.worker.onerror = (ev) => {
      const err = new EngineError(ev.message || "the engine worker crashed");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private send<T>(msg: DistributiveOmit<WorkerIn, "id">, onProgress?: Pending["onProgress"]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...msg, id });
    });
  }

  /** Fired while WebGPU Tev1 weights download, shaders compile, or GPU warms. */
  onWebGpuProgress: (message: string, frac?: number) => void = () => {};

  init(): Promise<{
    ontologies: OntologyFile[];
    starter: string;
    version: string;
    crossOriginIsolated: boolean;
  }> {
    return this.send({ kind: "init" });
  }

  validate(yaml: string): Promise<OntologyInfo> {
    return this.send({ kind: "validate", yaml });
  }

  /** Split the document into sections and forecast the work. Asks the model nothing. */
  prepare(request: RunRequest, host: HostConfig): Promise<Plan> {
    return this.send({ kind: "prepare", request, host });
  }

  /** Read the prepared document (or carry on where it stopped). */
  run(handlers: RunHandlers = {}, limit?: number): Promise<RunResult> {
    return this.send({ kind: "run", limit }, handlers.onProgress);
  }

  /** Ask a running read to stop after the section it is on. */
  stop(): void {
    this.worker.postMessage({ kind: "stop", id: 0 });
  }

  clearCache(): Promise<null> {
    return this.send({ kind: "clear" });
  }

  probeWebGpu(): Promise<{ ok: boolean; reason?: string }> {
    return this.send({ kind: "webgpu-probe" });
  }

  /** Enable the staged mock loader (`?webgpuMock=1`) for CI / UX demos. */
  setWebGpuMock(enabled: boolean): Promise<null> {
    return this.send({ kind: "webgpu-mock", enabled });
  }

  loadWebGpu(modelId: string): Promise<{ modelId: string; fingerprint?: unknown }> {
    return this.send({ kind: "webgpu-load", modelId });
  }

  /** Fingerprint + length sweep on the loaded Tev1 WebGPU runtime. */
  benchWebGpu(): Promise<unknown> {
    return this.send({ kind: "webgpu-bench" });
  }
}
