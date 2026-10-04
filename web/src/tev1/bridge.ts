/**
 * Synchronous System One transport backed by the WebGPU worker.
 *
 * Rust’s Transport is blocking. The engine worker writes the request into a
 * SharedArrayBuffer, kicks the GPU worker, then Atomics.wait until the response
 * is ready. Requires crossOriginIsolated (COOP/COEP headers from Vite).
 */

import type { GpuIn, GpuOut } from "./gpu-worker";
import {
  DEFAULT_TEV1_MODEL_ID,
  type GraphFingerprint,
  type Tev1BenchReport,
} from "./runtime";

const STATUS = 0;
const REQ_LEN = 1;
const RES_LEN = 2;
const HEADER = 12;
/** 4 MiB is well above Ollama’s 64 KiB System One body cap. */
const SAB_BYTES = 4 * 1024 * 1024;

export class Tev1Bridge {
  private worker: Worker | null = null;
  private sab: SharedArrayBuffer | null = null;
  private view: DataView | null = null;
  private bytes: Uint8Array | null = null;
  private i32: Int32Array | null = null;
  private loaded = false;
  private modelId = DEFAULT_TEV1_MODEL_ID;
  private loadWaiters: Array<(v: { fingerprint?: GraphFingerprint }) => void> = [];
  private loadRejecters: Array<(e: Error) => void> = [];
  private probeWaiters: Array<(v: { ok: boolean; reason?: string }) => void> = [];
  private benchWaiters: Array<(v: Tev1BenchReport) => void> = [];
  private benchRejecters: Array<(e: Error) => void> = [];
  private fingerprint: GraphFingerprint | undefined;
  /** Optional progress hook while weights download / compile / warm. */
  onProgress: (message: string, frac?: number) => void = () => {};

  get ready(): boolean {
    return this.loaded;
  }

  get graphFingerprint(): GraphFingerprint | undefined {
    return this.fingerprint;
  }

  get isolated(): boolean {
    return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  }

  private attachWorker(): void {
    if (this.worker) return;
    this.sab = new SharedArrayBuffer(SAB_BYTES);
    this.view = new DataView(this.sab);
    this.bytes = new Uint8Array(this.sab);
    this.i32 = new Int32Array(this.sab);
    Atomics.store(this.i32, STATUS, 0);
    this.worker = new Worker(new URL("./gpu-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<GpuOut>) => this.onGpu(ev.data);
    this.worker.onerror = (ev) => {
      this.failBridge(ev.message || "Tev1 GPU worker crashed");
    };
    this.worker.onmessageerror = () => {
      this.failBridge("Tev1 GPU worker message error");
    };
    this.post({ kind: "init", modelId: this.modelId, sab: this.sab });
  }

  /**
   * If the GPU worker dies mid-score, wake the Atomics.wait with an error
   * so Extract cannot sit until the 10-minute bridge timeout.
   */
  private failBridge(message: string): void {
    const err = new Error(message);
    for (const r of this.loadRejecters) r(err);
    this.loadWaiters = [];
    this.loadRejecters = [];
    if (!this.i32 || !this.view || !this.bytes) return;
    if (Atomics.load(this.i32, STATUS) !== 1) return;
    const encoded = new TextEncoder().encode(message);
    const n = Math.min(encoded.length, this.bytes.length - HEADER);
    this.bytes.set(encoded.subarray(0, n), HEADER);
    this.view.setInt32(RES_LEN * 4, n, true);
    Atomics.store(this.i32, STATUS, 3);
    Atomics.notify(this.i32, STATUS);
  }

  async start(modelId: string = DEFAULT_TEV1_MODEL_ID): Promise<{ fingerprint?: GraphFingerprint }> {
    if (!this.isolated) {
      throw new Error(
        "WebGPU Tev1 needs a cross-origin isolated page (COOP/COEP). Restart the demo server and hard-reload.",
      );
    }
    this.modelId = modelId || DEFAULT_TEV1_MODEL_ID;
    this.attachWorker();
    if (this.loaded) return { fingerprint: this.fingerprint };
    return await new Promise<{ fingerprint?: GraphFingerprint }>((resolve, reject) => {
      this.loadWaiters.push(resolve);
      this.loadRejecters.push(reject);
      this.post({ kind: "load", modelId: this.modelId });
    });
  }

  /** Async length-sweep + fingerprint (does not use the blocking SAB score path). */
  async bench(): Promise<Tev1BenchReport> {
    if (!this.loaded) {
      throw new Error("WebGPU Tev1 is not loaded");
    }
    this.attachWorker();
    return await new Promise((resolve, reject) => {
      this.benchWaiters.push(resolve);
      this.benchRejecters.push(reject);
      this.post({ kind: "bench" });
    });
  }

  async probe(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.isolated) {
      return {
        ok: false,
        reason: "Page is not cross-origin isolated (COOP/COEP). WebGPU Tev1 cannot use the sync bridge.",
      };
    }
    this.attachWorker();
    return new Promise((resolve) => {
      this.probeWaiters.push(resolve);
      this.post({ kind: "probe" });
    });
  }

  /**
   * Blocking System One call for Rust’s JsTransport.
   * Must run on a Worker thread (Atomics.wait is not allowed on the page).
   */
  call(path: string, body: string): string {
    if (path !== "/v1/systemone") {
      throw new Error(`WebGPU Tev1 only serves /v1/systemone, got ${path}`);
    }
    if (!this.loaded || !this.sab || !this.view || !this.bytes || !this.i32 || !this.worker) {
      throw new Error("WebGPU Tev1 is not loaded. Pick WebGPU and wait for the weights, or use Ollama.");
    }
    const encoded = new TextEncoder().encode(body);
    if (HEADER + encoded.length > this.bytes.length) {
      throw new Error("System One body is too large for the WebGPU bridge");
    }
    this.bytes.set(encoded, HEADER);
    this.view.setInt32(REQ_LEN * 4, encoded.length, true);
    Atomics.store(this.i32, STATUS, 1);
    this.worker.postMessage({ kind: "score" } satisfies GpuIn);

    // Loop: early notify is safe; spurious wakeups must not return a half-written body.
    const deadline = Date.now() + 600_000;
    while (Atomics.load(this.i32, STATUS) === 1) {
      const left = Math.max(1, deadline - Date.now());
      const wait = Atomics.wait(this.i32, STATUS, 1, left);
      if (wait === "timed-out" && Atomics.load(this.i32, STATUS) === 1) {
        Atomics.store(this.i32, STATUS, 0);
        throw new Error("WebGPU Tev1 timed out after 10 minutes");
      }
    }
    const status = Atomics.load(this.i32, STATUS);
    const n = Math.max(0, this.view.getInt32(RES_LEN * 4, true));
    // TextDecoder rejects SharedArrayBuffer views; copy before decode.
    const copy = new Uint8Array(n);
    copy.set(this.bytes.subarray(HEADER, HEADER + n));
    const text = new TextDecoder().decode(copy);
    Atomics.store(this.i32, STATUS, 0);
    if (status === 3) throw new Error(text || "WebGPU Tev1 failed");
    if (status !== 2) throw new Error(`WebGPU Tev1 bridge status ${status}`);
    return text;
  }

  dispose(): void {
    this.worker?.postMessage({ kind: "dispose" } satisfies GpuIn);
    this.worker?.terminate();
    this.worker = null;
    this.sab = null;
    this.view = null;
    this.bytes = null;
    this.i32 = null;
    this.loaded = false;
  }

  private post(msg: GpuIn): void {
    this.worker?.postMessage(msg);
  }

  private onGpu(msg: GpuOut): void {
    switch (msg.kind) {
      case "loaded":
        this.loaded = true;
        this.modelId = msg.modelId;
        this.fingerprint = msg.fingerprint;
        for (const w of this.loadWaiters) w({ fingerprint: msg.fingerprint });
        this.loadWaiters = [];
        this.loadRejecters = [];
        break;
      case "error": {
        const err = new Error(msg.error);
        for (const r of this.loadRejecters) r(err);
        this.loadWaiters = [];
        this.loadRejecters = [];
        for (const r of this.benchRejecters) r(err);
        this.benchWaiters = [];
        this.benchRejecters = [];
        break;
      }
      case "probe":
        for (const w of this.probeWaiters) w({ ok: msg.ok, reason: msg.reason });
        this.probeWaiters = [];
        break;
      case "bench":
        for (const w of this.benchWaiters) w(msg.report);
        this.benchWaiters = [];
        this.benchRejecters = [];
        break;
      case "progress":
        this.onProgress(msg.message, msg.frac);
        break;
      case "forward":
        // Engine worker is usually blocked on Atomics.wait during score — main
        // estimates forward progress from call.start questions instead.
        break;
      case "ready":
        break;
    }
  }
}
