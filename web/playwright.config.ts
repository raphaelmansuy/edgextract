import { defineConfig, devices } from "@playwright/test";

const PORT = 4273; // `vite preview` of the production build
const SLOW_PORT = 11436; // the same double, but every answer takes 150 ms, like a real model
const HOST_PORT = 11435; // a rule-based TEST DOUBLE of the model host (not a model), over HTTP

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // Baselines live next to the specs and are per platform: text is rendered
  // differently on macOS and Linux, so a baseline is only compared on the
  // platform that made it.
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.012, animations: "disabled" },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "dark",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1600, height: 1000 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command:
        `cargo run -q --manifest-path ../rust/edgextract/Cargo.toml -- serve-standin ` +
        `--addr 127.0.0.1:${SLOW_PORT} --delay-ms 150 --ontology company_news --ontology tech_docs --ontology conll04 ` +
        `--ontology-file src/ontologies/*.yaml`,
      port: SLOW_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      // Build the real site (wasm + worker + bundle) and serve what would ship.
      command: `npm run build && npx vite preview --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // A deterministic double of the model host (POST /v1/systemone). The page always
      // asks a host; the suite points it here so runs are repeatable and free.
      command:
        `cargo run -q --manifest-path ../rust/edgextract/Cargo.toml -- serve-standin ` +
        `--addr 127.0.0.1:${HOST_PORT} --ontology company_news --ontology tech_docs --ontology conll04 ` +
        `--ontology-file src/ontologies/*.yaml`,
      port: HOST_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
