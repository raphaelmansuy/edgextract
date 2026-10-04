/// <reference lib="webworker" />
// The engine lives in a worker for two reasons: the page never freezes while a
// model answers, and a worker may make *synchronous* model calls, which is what
// the Rust pipeline (one blocking `Transport`) expects.
//
// Backends:
//   ollama  — synchronous POST /v1/systemone (XHR)
//   webgpu  — Tev1 scored in a nested GPU worker via SharedArrayBuffer
//   webgpu + mock — staged download UX for CI; scoring fails closed

import init, {
  Engine,
  bundled_ontologies,
  starter_ontology,
  validate_ontology,
  version,
  type Job,
} from "./wasm/edgextract.js";
import type { HostConfig, Plan, RunOutput, WorkerIn, WorkerOut } from "./types";
import { Tev1Bridge } from "./tev1/bridge";
import { DEFAULT_TEV1_MODEL_ID } from "./tev1/runtime";

let engine: Engine | null = null;
const ready = init().then(() => {
  engine = new Engine();
});

const reply = (msg: WorkerOut) => (self as unknown as Worker).postMessage(msg);

const tev1 = new Tev1Bridge();
tev1.onProgress = (message, frac) =>
  reply({ id: 0, kind: "webgpu-progress", message, frac });

/** Staged progress for `?webgpuMock=1` (no real ONNX). */
let webgpuMock = false;
let mockLoaded = false;

/** A model that does not answer in this long is treated as down. */
const CALL_TIMEOUT_MS = 300_000;
/** The page repaints the graph at most this often while reading. */
const PAINT_EVERY_MS = 1200;

let calls = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function mockLoad(modelId: string): Promise<void> {
  const stages: Array<[string, number, number?]> = [
    ["Checking WebGPU", 0.03],
    ["Downloading tokenizer — 2.0 MB / 18 MB · tokenizer.json", 0.1],
    ["Downloading weights — 120 MB / 600 MB · decoder…onnx_data", 0.35],
    ["Downloading weights — 360 MB / 600 MB · decoder…onnx_data", 0.55],
    ["Downloading weights — 600 MB / 600 MB · embed_tokens…", 0.88],
    ["Compiling WebGPU — WebGPU kernels", 0.93],
    // Real Load finishes with a tiny prefill; mock mirrors that warm beat for e2e/UX.
    ["Warming WebGPU — weights cached — waking GPU", 0.97, 220],
    ["Warming WebGPU — first prefill", 0.99, 280],
    [`Ready — cached · GPU warmed · ${modelId}`, 1, 120],
  ];
  for (const [message, frac, hold] of stages) {
    reply({ id: 0, kind: "webgpu-progress", message, frac });
    await sleep(hold ?? 160);
  }
  mockLoaded = true;
}

/** Prefer IPv4 loopback — `localhost` often tries ::1 first and hangs for ~60s. */
function ollamaBase(url: string): string {
  const raw = url.trim() || "http://127.0.0.1:11434";
  try {
    const u = new URL(raw);
    if (u.hostname === "localhost") u.hostname = "127.0.0.1";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "").replace(/^http:\/\/localhost\b/i, "http://127.0.0.1");
  }
}

function ollamaDownMessage(base: string, detail: string): string {
  return (
    `cannot reach ${base}: ${detail} ` +
    `Start Ollama (\`ollama serve\`) and pull \`tev1\`, or switch to WebGPU.`
  );
}

/** A blocking `POST /v1/systemone`, handed to Rust as its model call. */
function ollamaCall(host: HostConfig): (path: string, body: string) => string {
  const base = ollamaBase(host.baseUrl);
  return (path, body) => {
    const n = ++calls;
    const began = performance.now();
    reply({ id: 0, kind: "call", state: "start", n });
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", base + path, false);
      xhr.timeout = CALL_TIMEOUT_MS;
      xhr.setRequestHeader("Content-Type", "application/json");
      try {
        xhr.send(body);
      } catch (e) {
        throw new Error(ollamaDownMessage(base, (e as Error).message));
      }
      if (xhr.status === 0) {
        throw new Error(
          ollamaDownMessage(base, "is it running, and does it allow this origin via CORS?"),
        );
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`http ${xhr.status}: ${xhr.responseText.slice(0, 300)}`);
      }
      return xhr.responseText;
    } finally {
      reply({
        id: 0,
        kind: "call",
        state: "end",
        n,
        ms: Math.round(performance.now() - began),
      });
    }
  };
}

function questionCount(body: string): number {
  try {
    const q = (JSON.parse(body) as { questions?: Record<string, unknown> }).questions;
    if (q && typeof q === "object" && !Array.isArray(q)) return Math.max(1, Object.keys(q).length);
  } catch {
    /* packed POST count is optional */
  }
  return 1;
}

function webgpuCall(): (path: string, body: string) => string {
  return (path, body) => {
    const n = ++calls;
    const began = performance.now();
    const questions = questionCount(body);
    reply({ id: 0, kind: "call", state: "start", n, questions });
    try {
      if (webgpuMock) {
        throw new Error(
          "WebGPU mock loader; not a model. Export Tev1 ONNX for real inference, or use the Ollama host.",
        );
      }
      const text = tev1.call(path, body);
      const wall = Math.round(performance.now() - began);
      let prefillMs: number | undefined;
      let forwards: number | undefined;
      let packPath: string | undefined;
      try {
        const usage = (
          JSON.parse(text) as {
            usage?: {
              prefill_ms?: number;
              output_tokens?: number;
              forwards?: number;
              pack_path?: string;
            };
          }
        ).usage;
        const nPrefill = usage?.output_tokens ?? questions;
        if (usage?.prefill_ms != null && nPrefill > 0) {
          prefillMs = Math.round(usage.prefill_ms / nPrefill);
        }
        forwards = usage?.forwards;
        packPath = usage?.pack_path;
      } catch {
        /* usage is optional */
      }
      reply({
        id: 0,
        kind: "call",
        state: "end",
        n,
        ms: wall,
        prefillMs: prefillMs ?? Math.round(wall / questions),
        questions,
        forwards,
        packPath,
      });
      return text;
    } catch (e) {
      reply({
        id: 0,
        kind: "call",
        state: "end",
        n,
        ms: Math.round(performance.now() - began),
        questions,
      });
      throw e;
    }
  };
}

function modelCall(host: HostConfig): (path: string, body: string) => string {
  if (host.backend === "webgpu") return webgpuCall();
  return ollamaCall(host);
}

let job: Job | null = null;
let stopRequested = false;

async function prepare(msg: Extract<WorkerIn, { kind: "prepare" }>): Promise<Plan> {
  if (!engine) throw new Error("engine not ready");
  if (msg.host.backend === "webgpu") {
    const id = msg.host.model || DEFAULT_TEV1_MODEL_ID;
    if (webgpuMock) {
      if (!mockLoaded) await mockLoad(id);
    } else if (!tev1.ready) {
      await tev1.start(id);
    }
  }
  job?.free();
  job = engine.start(JSON.stringify(msg.request), modelCall(msg.host));
  return JSON.parse(job.plan()) as Plan;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Read the prepared document to the end, or until told to stop. */
async function run(id: number, limit?: number): Promise<void> {
  const current = job;
  if (!current) throw new Error("nothing is prepared to read");
  if (limit) current.limit_sections(limit);
  stopRequested = false;
  let lastPaint = 0;
  try {
    while (!current.done() && !stopRequested) {
      const progress = JSON.parse(current.step());
      const now = performance.now();
      const paint = current.done() || now - lastPaint >= PAINT_EVERY_MS;
      if (paint) lastPaint = now;
      reply({
        id,
        kind: "progress",
        progress,
        output: paint ? (JSON.parse(current.snapshot()) as RunOutput) : null,
      });
      await tick();
    }
    const finished = current.done();
    const output = JSON.parse(finished ? current.finish() : current.snapshot()) as RunOutput;
    reply({ id, ok: true, data: { output, stopped: !finished } });
  } catch (e) {
    let partial: RunOutput | undefined;
    try {
      partial = JSON.parse(current.snapshot()) as RunOutput;
    } catch {
      /* nothing was read yet */
    }
    reply({ id, ok: false, error: message(e), partial });
  }
}

function message(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error).message ?? String(e));
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.kind === "stop") {
    stopRequested = true;
    return;
  }
  try {
    await ready;
    switch (msg.kind) {
      case "init":
        reply({
          id: msg.id,
          ok: true,
          data: {
            ontologies: JSON.parse(bundled_ontologies()),
            starter: starter_ontology(),
            version: version(),
            crossOriginIsolated:
              typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
          },
        });
        break;
      case "validate":
        reply({ id: msg.id, ok: true, data: JSON.parse(validate_ontology(msg.yaml)) });
        break;
      case "prepare":
        reply({ id: msg.id, ok: true, data: await prepare(msg) });
        break;
      case "run":
        await run(msg.id, msg.limit);
        break;
      case "clear":
        engine?.clear_cache();
        reply({ id: msg.id, ok: true, data: null });
        break;
      case "webgpu-mock":
        webgpuMock = msg.enabled;
        if (!msg.enabled) mockLoaded = false;
        reply({ id: msg.id, ok: true, data: null });
        break;
      case "webgpu-probe": {
        if (webgpuMock) {
          reply({ id: msg.id, ok: true, data: { ok: true } });
          break;
        }
        const r = await tev1.probe();
        reply({ id: msg.id, ok: true, data: r });
        break;
      }
      case "webgpu-load": {
        const id = msg.modelId || DEFAULT_TEV1_MODEL_ID;
        if (webgpuMock) {
          mockLoaded = false;
          await mockLoad(id);
          reply({ id: msg.id, ok: true, data: { modelId: id } });
        } else {
          const loaded = await tev1.start(id);
          reply({
            id: msg.id,
            ok: true,
            data: { modelId: id, fingerprint: loaded.fingerprint ?? tev1.graphFingerprint },
          });
        }
        break;
      }
      case "webgpu-bench": {
        if (webgpuMock) {
          reply({
            id: msg.id,
            ok: false,
            error: "WebGPU mock loader has no bench path",
          });
          break;
        }
        const report = await tev1.bench();
        reply({ id: msg.id, ok: true, data: report });
        break;
      }
    }
  } catch (e) {
    reply({ id: msg.id, ok: false, error: message(e) });
  }
};
