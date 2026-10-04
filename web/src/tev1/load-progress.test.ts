import { describe, expect, it } from "vitest";
import { LoadProgressTracker, formatLoadProgress } from "./load-progress";

describe("LoadProgressTracker", () => {
  it("never moves the bar backward across files", () => {
    const t = new LoadProgressTracker();
    t.setPhase("weights");
    const a = t.onTfProgress({
      status: "progress",
      file: "onnx/a.onnx_data",
      progress: 100,
      loaded: 100,
      total: 100,
    })!;
    expect(a.frac).toBeGreaterThan(0.12);
    const mid = a.frac;
    // Next file starts at 0% — bar must not jump back.
    const b = t.onTfProgress({
      status: "progress",
      file: "onnx/b.onnx_data",
      progress: 0,
      loaded: 0,
      total: 400,
    })!;
    expect(b.frac).toBeGreaterThanOrEqual(mid);
  });

  it("prefers progress_total aggregate bytes", () => {
    const t = new LoadProgressTracker();
    t.setPhase("weights");
    const v = t.onTfProgress({
      status: "progress_total",
      progress: 50,
      loaded: 250,
      total: 500,
      files: {
        "a.bin": { loaded: 250, total: 250 },
        "b.bin": { loaded: 0, total: 250 },
      },
    })!;
    expect(v.label).toBe("Downloading weights");
    expect(v.detail).toMatch(/250/);
    expect(v.frac).toBeGreaterThan(0.4);
    expect(v.frac).toBeLessThan(0.6);
  });

  it("compile tick crawls but stays in budget", () => {
    const t = new LoadProgressTracker();
    t.setPhase("compile");
    const a = t.tickCompile();
    expect(a.frac).toBeGreaterThanOrEqual(0.88);
    expect(a.frac).toBeLessThan(0.97);
    expect(a.label).toMatch(/Compiling/);
  });

  it("warm phase is monotonic after compile and labels clearly", () => {
    const t = new LoadProgressTracker();
    t.setPhase("compile");
    const compile = t.tickCompile();
    const warmStart = t.setPhase("warm", "weights cached — waking GPU");
    expect(warmStart.frac).toBeGreaterThanOrEqual(compile.frac);
    expect(warmStart.label).toBe("Warming WebGPU");
    expect(warmStart.detail).toMatch(/waking GPU|cached/i);
    const mid = t.tickWarm();
    expect(mid.frac).toBeGreaterThanOrEqual(warmStart.frac);
    expect(mid.frac).toBeLessThan(1);
    expect(mid.label).toBe("Warming WebGPU");
    const ready = t.setPhase("ready", "cached · GPU warmed");
    expect(ready.frac).toBe(1);
    expect(ready.frac).toBeGreaterThanOrEqual(mid.frac);
  });

  it("formatLoadProgress joins label and detail", () => {
    const { message, frac } = formatLoadProgress({
      frac: 0.5,
      phase: "weights",
      label: "Downloading weights",
      detail: "100 MB / 200 MB · model.onnx",
    });
    expect(frac).toBe(0.5);
    expect(message).toContain("Downloading weights");
    expect(message).toContain("100 MB");
  });
});
