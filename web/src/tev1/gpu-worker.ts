/// <reference lib="webworker" />
/**
 * Owns the Tev1 WebGPU runtime. The engine worker kicks it with postMessage
 * and waits on a SharedArrayBuffer flag so Rust can keep a synchronous Transport.
 */

import { decideLocal, parseSystemOneBody } from "./systemone";
import {
  Tev1Runtime,
  DEFAULT_TEV1_MODEL_ID,
  probeWebGpu,
  type Tev1BenchReport,
  type GraphFingerprint,
  type PrefillPackStats,
} from "./runtime";

export type GpuIn =
  | { kind: "init"; modelId: string; sab: SharedArrayBuffer }
  | { kind: "load"; modelId: string }
  | { kind: "score" }
  | { kind: "bench" }
  | { kind: "dispose" }
  | { kind: "probe" };

export type GpuOut =
  | { kind: "ready"; modelId: string }
  | { kind: "progress"; message: string; frac?: number }
  | {
      kind: "forward";
      index: number;
      total: number;
      ms: number;
      fingerprint?: GraphFingerprint;
    }
  | { kind: "probe"; ok: boolean; reason?: string }
  | { kind: "error"; error: string }
  | {
      kind: "loaded";
      modelId: string;
      fingerprint?: GraphFingerprint;
    }
  | { kind: "bench"; report: Tev1BenchReport };

/** SAB: Int32[0]=status (0 idle, 1 request, 2 done, 3 error), [1]=reqLen, [2]=resLen, then bytes. */
const STATUS = 0;
const REQ_LEN = 1;
const RES_LEN = 2;
const HEADER = 3 * 4;

let sab: SharedArrayBuffer | null = null;
let view: DataView | null = null;
let bytes: Uint8Array | null = null;
const runtime = new Tev1Runtime();

const reply = (msg: GpuOut) => (self as unknown as Worker).postMessage(msg);

/** TextDecoder rejects views of SharedArrayBuffer — copy into a owned buffer first. */
function decodeSabSlice(src: Uint8Array, start: number, end: number): string {
  const n = Math.max(0, end - start);
  const copy = new Uint8Array(n);
  copy.set(src.subarray(start, end));
  return new TextDecoder().decode(copy);
}

function readRequest(): string {
  if (!view || !bytes) throw new Error("SharedArrayBuffer not attached");
  const n = view.getInt32(REQ_LEN * 4, true);
  if (n < 0 || HEADER + n > bytes.length) throw new Error("bad request length");
  return decodeSabSlice(bytes, HEADER, HEADER + n);
}

function writeResponse(text: string, status: 2 | 3): void {
  if (!view || !bytes || !sab) throw new Error("SharedArrayBuffer not attached");
  const encoded = new TextEncoder().encode(text);
  if (HEADER + encoded.length > bytes.length) {
    const err = new TextEncoder().encode("response too large for bridge buffer");
    bytes.set(err, HEADER);
    view.setInt32(RES_LEN * 4, err.length, true);
    Atomics.store(new Int32Array(sab), STATUS, 3);
    Atomics.notify(new Int32Array(sab), STATUS);
    return;
  }
  bytes.set(encoded, HEADER);
  view.setInt32(RES_LEN * 4, encoded.length, true);
  Atomics.store(new Int32Array(sab), STATUS, status);
  Atomics.notify(new Int32Array(sab), STATUS);
}

/** Always wake the engine worker — even if encoding the error body fails. */
function forceError(message: string): void {
  try {
    writeResponse(message, 3);
  } catch {
    if (!sab) return;
    const i32 = new Int32Array(sab);
    Atomics.store(i32, STATUS, 3);
    Atomics.notify(i32, STATUS);
  }
}

async function score(): Promise<void> {
  try {
    const bodyJson = readRequest();
    const body = parseSystemOneBody(bodyJson);
    const response = await decideLocal(
      body,
      (batch, opts) => runtime.prefillMany(batch, opts),
      {
        onForward: (info) =>
          reply({
            kind: "forward",
            index: info.index,
            total: info.total,
            ms: info.ms,
            fingerprint: runtime.status().fingerprint,
          }),
        packPath: () => runtime.status().lastPack?.path,
      },
    );
    const pack: PrefillPackStats | undefined = runtime.status().lastPack;
    if (pack) {
      response.usage.pack_path = pack.path;
      response.usage.forwards = pack.forwards;
    }
    writeResponse(JSON.stringify(response), 2);
  } catch (e) {
    forceError((e as Error).message || String(e));
  }
}

self.onerror = (ev: string | Event) => {
  const msg =
    typeof ev === "string"
      ? ev
      : ev instanceof ErrorEvent
        ? ev.message
        : "Tev1 GPU worker error";
  forceError(msg || "Tev1 GPU worker error");
  return true;
};

self.onmessageerror = () => {
  forceError("Tev1 GPU worker message error");
};

self.onmessage = async (ev: MessageEvent<GpuIn>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case "init": {
        sab = msg.sab;
        view = new DataView(sab);
        bytes = new Uint8Array(sab);
        reply({ kind: "ready", modelId: msg.modelId || DEFAULT_TEV1_MODEL_ID });
        break;
      }
      case "probe": {
        const r = await probeWebGpu();
        reply({ kind: "probe", ok: r.ok, reason: r.reason });
        break;
      }
      case "load": {
        await runtime.load(msg.modelId || DEFAULT_TEV1_MODEL_ID, (message, frac) =>
          reply({ kind: "progress", message, frac }),
        );
        reply({
          kind: "loaded",
          modelId: runtime.status().modelId,
          fingerprint: runtime.status().fingerprint,
        });
        break;
      }
      case "score":
        await score();
        break;
      case "bench": {
        const report = await runtime.bench();
        reply({ kind: "bench", report });
        break;
      }
      case "dispose":
        runtime.dispose();
        reply({ kind: "ready", modelId: DEFAULT_TEV1_MODEL_ID });
        break;
    }
  } catch (e) {
    const err = (e as Error).message || String(e);
    reply({ kind: "error", error: err });
    if (msg.kind === "score") forceError(err);
  }
};
