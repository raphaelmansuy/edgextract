/// <reference lib="webworker" />
// The engine lives in a worker for two reasons: the page never freezes while a
// model answers, and a worker may make *synchronous* HTTP calls, which is what
// the Rust pipeline (one blocking `Transport`) expects.
//
// A document is read section by section. Between sections the worker yields to its
// own event loop, so a "stop" message is heard within one section, and it posts the
// graph read so far, so the page can show it growing.

import init, {
  Engine,
  bundled_ontologies,
  starter_ontology,
  validate_ontology,
  version,
  type Job,
} from "./wasm/edgextract.js";
import type { HostConfig, Plan, RunOutput, WorkerIn, WorkerOut } from "./types";

let engine: Engine | null = null;
const ready = init().then(() => {
  engine = new Engine();
});

const reply = (msg: WorkerOut) => (self as unknown as Worker).postMessage(msg);

/** A model that does not answer in this long is treated as down. */
const CALL_TIMEOUT_MS = 300_000;
/** The page repaints the graph at most this often while reading. */
const PAINT_EVERY_MS = 1200;

let calls = 0;

/** A blocking `POST /v1/systemone`, handed to Rust as its model call. */
function hostCall(host: HostConfig): (path: string, body: string) => string {
  const base = host.baseUrl.replace(/\/+$/, "");
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
        throw new Error(`cannot reach ${base}: ${(e as Error).message}`);
      }
      if (xhr.status === 0) {
        throw new Error(`cannot reach ${base} (is it running, and does it allow this origin via CORS?)`);
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`http ${xhr.status}: ${xhr.responseText.slice(0, 300)}`);
      }
      return xhr.responseText;
    } finally {
      reply({ id: 0, kind: "call", state: "end", n, ms: Math.round(performance.now() - began) });
    }
  };
}

let job: Job | null = null;
let stopRequested = false;

function prepare(msg: Extract<WorkerIn, { kind: "prepare" }>): Plan {
  if (!engine) throw new Error("engine not ready");
  job?.free();
  job = engine.start(JSON.stringify(msg.request), hostCall(msg.host));
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
      reply({ id, kind: "progress", progress, output: paint ? (JSON.parse(current.snapshot()) as RunOutput) : null });
      await tick(); // let a "stop" message in
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

/** wasm-bindgen throws plain strings; everything else is an Error. */
function message(e: unknown): string {
  return typeof e === "string" ? e : (e as Error).message ?? String(e);
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
          },
        });
        break;
      case "validate":
        reply({ id: msg.id, ok: true, data: JSON.parse(validate_ontology(msg.yaml)) });
        break;
      case "prepare":
        reply({ id: msg.id, ok: true, data: prepare(msg) });
        break;
      case "run":
        await run(msg.id, msg.limit);
        break;
      case "clear":
        engine?.clear_cache();
        reply({ id: msg.id, ok: true, data: null });
        break;
    }
  } catch (e) {
    reply({ id: msg.id, ok: false, error: message(e) });
  }
};
