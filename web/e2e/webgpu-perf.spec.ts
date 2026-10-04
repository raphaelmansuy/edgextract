/**
 * Live WebGPU Tev1 perf + graph fingerprint.
 *
 *   EDGEXTRACT_WEBGPU_PERF=1 npx playwright test e2e/webgpu-perf.spec.ts
 *
 * Clears Cache Storage so Hub cannot keep an unfused graph. Records cold/warm
 * Northwind extracts, a length sweep, and pack path into
 * docs/results/tev1-webgpu-perf-browser.json.
 */
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const outPath = resolve(root, "docs/results/tev1-webgpu-perf-browser.json");
const northwind = readFileSync(resolve(root, "data/golden/docs/13_northwind.md"), "utf8");

const enabled = process.env.EDGEXTRACT_WEBGPU_PERF === "1";
const hubId = "raphaelmansuy/tev1-0.8b-onnx-webgpu";
const localId = "tev1-0.8b-onnx";

test.use({
  headless: false,
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,UseSkiaRenderer",
      "--use-angle=metal",
      "--ignore-gpu-blocklist",
    ],
  },
});

async function clearCaches(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  });
}

async function waitExtractDone(page: Page, runsBefore: number): Promise<number> {
  const t0 = Date.now();
  await page.waitForFunction(
    (before) => {
      const phase = document.body.dataset.phase ?? "";
      const runs = Number(document.body.dataset.runs ?? 0);
      const plan = document.getElementById("plan");
      const planVisible = !!plan && !plan.hidden;
      const errText = (document.getElementById("error-text")?.textContent ?? "").trim();
      const err = document.querySelector("[data-testid='error']") as HTMLElement | null;
      const errVisible = !!err && !err.hidden && errText.length > 0;
      return (
        planVisible ||
        errVisible ||
        (runs > before && (phase === "done" || phase === "paused" || phase === "idle"))
      );
    },
    runsBefore,
    { timeout: 600_000 },
  );
  if (await page.locator("#plan").isVisible()) {
    await page.getByTestId("plan-all").click();
    await page.waitForFunction(
      (before) => {
        const phase = document.body.dataset.phase ?? "";
        const runs = Number(document.body.dataset.runs ?? 0);
        const errText = (document.getElementById("error-text")?.textContent ?? "").trim();
        const err = document.querySelector("[data-testid='error']") as HTMLElement | null;
        const errVisible = !!err && !err.hidden && errText.length > 0;
        return (
          errVisible ||
          (runs > before && (phase === "done" || phase === "paused" || phase === "idle"))
        );
      },
      runsBefore + 1,
      { timeout: 600_000 },
    );
  }
  return Date.now() - t0;
}

async function loadModel(page: Page, modelId: string): Promise<{ loadMs: number; graph?: string; pastConv?: string }> {
  await page.goto(`/?backend=webgpu&model=${encodeURIComponent(modelId)}`);
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  await clearCaches(page);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "true");

  await page.getByTestId("backend-webgpu").check({ force: true });
  await expect(page.getByTestId("backend-webgpu")).toBeChecked();

  // Expand advanced so Hub/local id is editable when collapsed.
  const details = page.locator("#webgpu-advanced");
  if (await details.count()) {
    await details.evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
  }
  const modelInput = page.getByTestId("webgpu-model");
  await modelInput.fill(modelId);
  await modelInput.dispatchEvent("change");

  const loadBtn = page.getByTestId("webgpu-load");
  const loadT0 = Date.now();
  const state = await page.getByTestId("webgpu-fields").getAttribute("data-webgpu-state");
  if (state !== "ready") {
    await loadBtn.click();
    await expect(page.getByTestId("webgpu-fields")).toHaveAttribute("data-webgpu-state", "ready", {
      timeout: 300_000,
    });
  }
  const loadMs = Date.now() - loadT0;
  const graph = await page.evaluate(() => document.body.dataset.webgpuGraph);
  const pastConv = await page.evaluate(() => document.body.dataset.webgpuPastConv);
  return { loadMs, graph, pastConv };
}

test.describe("WebGPU Tev1 live perf", () => {
  test.skip(!enabled, "set EDGEXTRACT_WEBGPU_PERF=1");

  test("measure local + Hub fused graph", async ({ page, browserName }) => {
    test.setTimeout(900_000);
    test.skip(browserName !== "chromium", "WebGPU path is Chromium-only here");

    page.on("console", (m) => {
      if (m.type() === "error") console.error("console.error", m.text());
    });
    page.on("pageerror", (e) => console.error("pageerror", e.message));

    await page.goto("/?backend=webgpu&model=tev1-0.8b-onnx");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const gpuProbe = await page.evaluate(async () => {
      const g = (navigator as { gpu?: { requestAdapter: (o?: object) => Promise<unknown> } }).gpu;
      if (!g) return { ok: false, reason: "no navigator.gpu" };
      try {
        const a = await g.requestAdapter({ powerPreference: "high-performance" });
        return { ok: !!a, reason: a ? "adapter" : "null adapter" };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    });
    console.log("gpu probe", gpuProbe);
    test.skip(!gpuProbe.ok, `no WebGPU in this Chromium: ${gpuProbe.reason}`);

    const runs: Record<string, unknown> = { gpu: gpuProbe, at: new Date().toISOString() };

    for (const modelId of [localId, hubId]) {
      console.log("=== model", modelId);
      try {
        const loaded = await loadModel(page, modelId);
        console.log("load_ms", loaded.loadMs, "graph", loaded.graph, "past_conv", loaded.pastConv);
        if (loaded.graph === "unfused-legacy") {
          runs[modelId] = { error: "unfused-legacy graph", ...loaded };
          continue;
        }

        await expect(page.getByTestId("run")).toHaveText(/Extract/i, { timeout: 30_000 });
        await page.getByTestId("text").fill(northwind);

        const coldBefore = Number(await page.evaluate(() => document.body.dataset.runs ?? "0"));
        await page.getByTestId("run").click();
        const coldMs = await waitExtractDone(page, coldBefore);
        const coldDetail = await page.locator("#progress-detail").textContent();
        console.log("cold_ms", coldMs, coldDetail);

        const warmBefore = Number(await page.evaluate(() => document.body.dataset.runs ?? "0"));
        await page.getByTestId("run").click();
        const warmMs = await waitExtractDone(page, warmBefore);
        const warmDetail = await page.locator("#progress-detail").textContent();
        console.log("warm_ms", warmMs, warmDetail);

        const sweep = await page.evaluate(async () => {
          const eng = (
            window as unknown as { __edgextractEngine?: { benchWebGpu: () => Promise<unknown> } }
          ).__edgextractEngine;
          if (!eng?.benchWebGpu) {
            return {
              graph: document.body.dataset.webgpuGraph ?? null,
              past_conv: document.body.dataset.webgpuPastConv ?? null,
            };
          }
          return eng.benchWebGpu();
        });
        console.log("bench", JSON.stringify(sweep));

        runs[modelId] = {
          load_ms: loaded.loadMs,
          fingerprint: {
            kind: loaded.graph,
            past_conv0_last_dim: loaded.pastConv ? Number(loaded.pastConv) : null,
          },
          cold_extract_ms: coldMs,
          warm_extract_ms: warmMs,
          cold_detail: coldDetail,
          warm_detail: warmDetail,
          bench: sweep,
        };
      } catch (e) {
        const status = await page.getByTestId("webgpu-status").innerText().catch(() => "");
        runs[modelId] = {
          error: e instanceof Error ? e.message : String(e),
          webgpu_status: status,
        };
        console.error("model failed", modelId, runs[modelId]);
      }
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(runs, null, 2) + "\n");
    console.log("wrote", outPath, JSON.stringify(runs, null, 2));

    const local = runs[localId] as {
      warm_extract_ms?: number;
      fingerprint?: { kind?: string };
      error?: string;
    };
    expect(local.error, `local failed: ${local.error}`).toBeUndefined();
    expect(local.warm_extract_ms ?? 0).toBeGreaterThan(0);
    expect(local.fingerprint?.kind === "unfused-legacy").toBe(false);
  });
});
