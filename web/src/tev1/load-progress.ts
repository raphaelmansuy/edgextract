/**
 * Honest WebGPU load progress from Transformers.js ProgressInfo events.
 *
 * First principles:
 * - Per-file `status: "progress"` resets 0→100 for every shard — never drive the bar from that alone.
 * - Prefer `status: "progress_total"` (aggregate bytes). Else sum per-file loaded/total ourselves.
 * - The bar is monotonic: it never moves backward.
 * - Stages have budgets so "tokenizer" cannot claim 90% of the UX.
 */

export type LoadPhase = "check" | "tokenizer" | "weights" | "compile" | "warm" | "ready";

/** Subset of Transformers.js ProgressInfo we care about. */
export type TfProgressInfo = {
  status?: string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  files?: Record<string, { loaded: number; total: number }>;
};

export type LoadProgressView = {
  /** Overall 0..1, monotonic. */
  frac: number;
  phase: LoadPhase;
  /** Short primary line for the progress label. */
  label: string;
  /** Optional secondary detail (bytes, file name). */
  detail: string;
};

const PHASE_BUDGET: Record<LoadPhase, { start: number; end: number }> = {
  check: { start: 0, end: 0.03 },
  tokenizer: { start: 0.03, end: 0.12 },
  weights: { start: 0.12, end: 0.88 },
  compile: { start: 0.88, end: 0.97 },
  /** One tiny prefill after weights — shader/session cold start. */
  warm: { start: 0.97, end: 1 },
  ready: { start: 1, end: 1 },
};

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function shortFile(file?: string): string {
  if (!file) return "file";
  const base = file.split("/").pop() || file;
  return base.length > 36 ? `${base.slice(0, 18)}…${base.slice(-14)}` : base;
}

export class LoadProgressTracker {
  private phase: LoadPhase = "check";
  private frac = 0;
  private fileBytes = new Map<string, { loaded: number; total: number }>();
  private lastFile = "";
  private compileStartedAt = 0;
  private warmStartedAt = 0;

  get currentPhase(): LoadPhase {
    return this.phase;
  }

  setPhase(phase: LoadPhase, note?: string): LoadProgressView {
    this.phase = phase;
    if (phase === "compile" && !this.compileStartedAt) this.compileStartedAt = performance.now();
    if (phase === "warm" && !this.warmStartedAt) this.warmStartedAt = performance.now();
    if (phase === "ready") this.frac = 1;
    else this.bumpTo(PHASE_BUDGET[phase].start);
    return this.view(note);
  }

  /** Ingest one Transformers.js progress_callback event for the current phase. */
  onTfProgress(info: TfProgressInfo): LoadProgressView | null {
    const status = info.status;
    if (!status) return null;

    if (status === "initiate" || status === "download") {
      if (info.file) this.lastFile = info.file;
      return this.view(status === "download" ? "download started" : "queued");
    }

    if (status === "progress_total") {
      const loaded = Number(info.loaded) || 0;
      const total = Number(info.total) || 0;
      if (info.files) {
        for (const [file, v] of Object.entries(info.files)) {
          this.fileBytes.set(file, { loaded: v.loaded, total: v.total });
        }
      }
      return this.applyByteProgress(loaded, total, info.file);
    }

    if (status === "progress") {
      if (info.file && info.loaded != null && info.total != null) {
        this.fileBytes.set(info.file, { loaded: info.loaded, total: info.total });
        this.lastFile = info.file;
      }
      const { loaded, total } = this.sumFiles();
      if (total > 0) return this.applyByteProgress(loaded, total, info.file);
      // Fallback: single-file ratio only, mapped into the phase budget (still monotonic).
      const p = typeof info.progress === "number" ? info.progress / 100 : 0;
      return this.applyPhaseRatio(Math.min(1, Math.max(0, p)), info.file);
    }

    if (status === "done") {
      if (info.file) {
        const prev = this.fileBytes.get(info.file);
        if (prev && prev.total > 0) {
          this.fileBytes.set(info.file, { loaded: prev.total, total: prev.total });
        } else if (prev) {
          this.fileBytes.set(info.file, { loaded: prev.loaded, total: prev.loaded });
        }
        this.lastFile = info.file;
      }
      const { loaded, total } = this.sumFiles();
      if (total > 0) return this.applyByteProgress(loaded, total, info.file);
      return this.view("file ready");
    }

    return null;
  }

  /** Call while waiting after downloads (WebGPU session compile has no byte events). */
  tickCompile(): LoadProgressView {
    this.phase = "compile";
    if (!this.compileStartedAt) this.compileStartedAt = performance.now();
    const elapsed = (performance.now() - this.compileStartedAt) / 1000;
    // Asymptotic crawl 88% → 97% over ~30s so the bar never looks frozen.
    const { start, end } = PHASE_BUDGET.compile;
    const crawl = start + (end - start) * (1 - Math.exp(-elapsed / 12));
    this.bumpTo(crawl);
    return this.view("WebGPU kernels");
  }

  /** Call while the post-load warmup prefill runs (no byte events). */
  tickWarm(): LoadProgressView {
    this.phase = "warm";
    if (!this.warmStartedAt) this.warmStartedAt = performance.now();
    const elapsed = (performance.now() - this.warmStartedAt) / 1000;
    // Crawl 97% → ~99.5% so ready (100%) is reserved for completion.
    const { start, end } = PHASE_BUDGET.warm;
    const crawl = start + (end - start) * 0.85 * (1 - Math.exp(-elapsed / 10));
    this.bumpTo(crawl);
    return this.view("first prefill");
  }

  private sumFiles(): { loaded: number; total: number } {
    let loaded = 0;
    let total = 0;
    for (const v of this.fileBytes.values()) {
      loaded += v.loaded;
      total += v.total > 0 ? v.total : v.loaded;
    }
    return { loaded, total };
  }

  private applyByteProgress(loaded: number, total: number, file?: string): LoadProgressView {
    if (file) this.lastFile = file;
    const ratio = total > 0 ? Math.min(1, loaded / total) : 0;
    return this.applyPhaseRatio(ratio, file, loaded, total);
  }

  private applyPhaseRatio(
    ratio: number,
    file?: string,
    loaded?: number,
    total?: number,
  ): LoadProgressView {
    const { start, end } = PHASE_BUDGET[this.phase];
    this.bumpTo(start + (end - start) * ratio);
    const note =
      loaded != null && total != null && total > 0
        ? `${fmtBytes(loaded)} / ${fmtBytes(total)}`
        : undefined;
    return this.view(note, file);
  }

  private bumpTo(next: number): void {
    if (next > this.frac) this.frac = Math.min(1, next);
  }

  private view(note?: string, file?: string): LoadProgressView {
    const f = file || this.lastFile;
    const phaseLabel =
      this.phase === "check"
        ? "Checking WebGPU"
        : this.phase === "tokenizer"
          ? "Downloading tokenizer"
          : this.phase === "weights"
            ? "Downloading weights"
            : this.phase === "compile"
              ? "Compiling WebGPU"
              : this.phase === "warm"
                ? "Warming WebGPU"
                : "Ready";
    const detailParts: string[] = [];
    if (note) detailParts.push(note);
    if (
      f &&
      this.phase !== "ready" &&
      this.phase !== "check" &&
      this.phase !== "warm"
    ) {
      detailParts.push(shortFile(f));
    }
    return {
      frac: this.frac,
      phase: this.phase,
      label: phaseLabel,
      detail: detailParts.join(" · "),
    };
  }
}

/** Format tracker output for the existing message + frac progress channel. */
export function formatLoadProgress(view: LoadProgressView): { message: string; frac: number } {
  const message = view.detail ? `${view.label} — ${view.detail}` : view.label;
  return { message, frac: view.frac };
}
