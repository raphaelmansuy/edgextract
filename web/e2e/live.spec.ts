// Runs the page against a REAL decision model (Ollama + tev1) instead of the test double.
// Off by default because it needs a model and takes minutes:  EDGEXTRACT_LIVE=1 npm run e2e -- live
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterRun, nodeNames, openDemo, settled, shot, stat } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const OLLAMA = process.env.EDGEXTRACT_LIVE_HOST ?? "http://localhost:11434";
const MODEL = process.env.EDGEXTRACT_LIVE_MODEL ?? "tev1";

test.skip(!process.env.EDGEXTRACT_LIVE, "set EDGEXTRACT_LIVE=1 to run against a real model");
test.setTimeout(600_000);

test("an uploaded document with unlisted names is read by the real model", async ({ page }) => {
  await openDemo(page, OLLAMA, MODEL);
  // The ontology says what may be extracted; pick the one that fits the document.
  await afterRun(page, () => page.getByTestId("ontology").selectOption(process.env.EDGEXTRACT_LIVE_ONTOLOGY ?? "tech_docs"));
  const doc = readFileSync(resolve(here, "fixtures/procedural-memory.md"));
  await afterRun(page, () =>
    page.getByTestId("file").setInputFiles({ name: "procedural-memory.md", mimeType: "text/markdown", buffer: doc }),
  );
  await expect(page.getByTestId("error")).toBeHidden();
  // The names were never listed; the model was asked about them anyway.
  expect(await stat(page, "calls")).toBeGreaterThan(0);
  const names = await nodeNames(page);
  console.log("names on the graph:", names);
  expect(names.length).toBeGreaterThanOrEqual(3);
  await shot(page, `13-live-${process.env.EDGEXTRACT_LIVE_ONTOLOGY ?? "tech_docs"}`);
  console.log("links:", await stat(page, "links"), "review:", await stat(page, "review"));
  await settled(page);
});
