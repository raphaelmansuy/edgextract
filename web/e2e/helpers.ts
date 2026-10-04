import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Where the README's screenshots live. Every run refreshes them. */
export const SHOTS = resolve(here, "../../docs/img/demo");

export interface Edge {
  source: string;
  relation: string;
  target: string;
  pending: boolean;
  weight: number;
}

export async function runs(page: Page): Promise<number> {
  return Number(await page.evaluate(() => document.body.dataset.runs ?? "0"));
}

/** The deterministic test double of the model host that the suite starts. */
export const DOUBLE = "http://127.0.0.1:11435";
/** The same double, but each answer takes 150 ms, so a long read is long enough to watch. */
export const SLOW = "http://127.0.0.1:11436";

export interface OpenDemoOpts {
  host?: string;
  model?: string;
  backend?: "ollama" | "webgpu";
  /** Staged WebGPU download UX without real ONNX (`?webgpuMock=1`). */
  webgpuMock?: boolean;
  /** Wait for the first auto-extraction (default true unless backend is webgpu). */
  waitForRun?: boolean;
}

/**
 * Open the demo and wait for the first extraction to finish. The page always asks a
 * decision-model host; by default the suite points it at the test double.
 */
export async function openDemo(
  page: Page,
  hostOrOpts: string | OpenDemoOpts = DOUBLE,
  model = "test-double",
): Promise<string[]> {
  // Page default is WebGPU; the suite talks to the Ollama stand-in unless a test asks otherwise.
  const opts: OpenDemoOpts =
    typeof hostOrOpts === "string"
      ? { host: hostOrOpts, model, backend: "ollama", waitForRun: true }
      : {
          host: DOUBLE,
          model: "test-double",
          backend: "ollama",
          waitForRun: true,
          ...hostOrOpts,
          waitForRun:
            hostOrOpts.waitForRun ??
            (hostOrOpts.backend === "webgpu" || hostOrOpts.webgpuMock ? false : true),
        };

  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });

  const q = new URLSearchParams();
  if (opts.host) q.set("host", opts.host);
  if (opts.model) q.set("model", opts.model);
  if (opts.backend) q.set("backend", opts.backend);
  if (opts.webgpuMock) q.set("webgpuMock", "1");

  await page.goto(`/?${q.toString()}`);
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  if (opts.waitForRun !== false) {
    await page.waitForFunction(() => Number(document.body.dataset.runs ?? 0) >= 1);
    await settled(page);
  }
  return problems;
}

/** The page is at rest: nothing is being prepared, read or stopped. */
export const phase = (page: Page): Promise<string> =>
  page.evaluate(() => document.body.dataset.phase ?? "idle");

/**
 * Wait until no extraction is running or queued. The page debounces edits by
 * 300 ms, so the run counter must stay put for longer than that.
 */
export async function settled(page: Page): Promise<void> {
  let last = -1;
  for (let i = 0; i < 120; i++) {
    const n = await runs(page);
    const p = await phase(page);
    const busy = ["preparing", "running", "stopping"].includes(p);
    if (n === last && !busy) return;
    last = n;
    await page.waitForTimeout(380);
  }
  throw new Error("the demo never settled");
}

/** Do something that triggers an extraction, then wait for that extraction to finish. */
export async function afterRun(page: Page, action: () => Promise<unknown>): Promise<void> {
  const before = await runs(page);
  await action();
  await page.waitForFunction((n) => Number(document.body.dataset.runs ?? 0) > n, before);
  await settled(page);
}

export async function edges(page: Page): Promise<Edge[]> {
  return page.locator('[data-testid="edge"]').evaluateAll((els) =>
    els.map((e) => ({
      source: e.getAttribute("data-source") ?? "",
      relation: e.getAttribute("data-relation") ?? "",
      target: e.getAttribute("data-target") ?? "",
      pending: e.getAttribute("data-pending") === "true",
      weight: Number(e.getAttribute("data-weight")),
    })),
  );
}

export const kept = (all: Edge[]): string[] =>
  all.filter((e) => !e.pending).map((e) => `${e.source} ${e.relation} ${e.target}`).sort();

export async function nodeNames(page: Page): Promise<string[]> {
  return (
    await page.locator('[data-testid="node"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-name") ?? ""))
  ).sort();
}

export async function stat(page: Page, id: string): Promise<number> {
  return Number(await page.locator(`[data-testid="stat-${id}"] b`).innerText());
}

export async function setRange(input: Locator, value: number): Promise<void> {
  await input.fill(String(value));
}

/** Save a screenshot for the docs, and return its path. */
export async function shot(target: Page | Locator, name: string, fullPage = false): Promise<string> {
  mkdirSync(SHOTS, { recursive: true });
  const path = resolve(SHOTS, `${name}.png`);
  if (fullPage && "goto" in target) await target.screenshot({ path, animations: "disabled", fullPage: true });
  else await target.screenshot({ path, animations: "disabled" });
  return path;
}

/** Attach a screenshot to the HTML report too, so a failing run can be inspected. */
export async function attach(info: TestInfo, page: Page | Locator, name: string): Promise<void> {
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}
