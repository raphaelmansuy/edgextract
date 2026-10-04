import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterRun, DOUBLE, edges, kept, nodeNames, openDemo, settled, shot, stat } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = DOUBLE;

async function pick(page: Page, sample: string): Promise<void> {
  await afterRun(page, () => page.getByTestId(`sample-${sample}`).click());
}

test.describe("the engine", () => {
  test("loads the Rust wasm module in the browser, with no errors", async ({ page }) => {
    const problems = await openDemo(page);
    await expect(page.getByTestId("wasm-status")).toContainText("engine ready");
    await expect(page.getByTestId("wasm-status")).toContainText("wasm");
    // The module really is a .wasm file fetched by the page, not a JS fallback.
    const wasmFiles = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => n.endsWith(".wasm")),
    );
    expect(wasmFiles.length).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  test("talks only to its own origin and to the model host you named", async ({ page }) => {
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.protocol.startsWith("http") && ![`http://localhost:4273`, HOST].includes(u.origin)) foreign.push(r.url());
    });
    await openDemo(page);
    await pick(page, "papers");
    await page.getByTestId("text").fill("Ada Lovelace founded Northwind in Paris.");
    await afterRun(page, () => page.getByTestId("run").click());
    expect(foreign).toEqual([]);
  });
});

test.describe("sample notes", () => {
  test("Northwind: four true links, each pointing the right way", async ({ page }, info) => {
    await openDemo(page);
    expect(await nodeNames(page)).toEqual(["ACME_INC", "ADA_LOVELACE", "BERLIN", "JANE_DOE", "NORTHWIND", "PARIS"]);
    const all = await edges(page);
    expect(kept(all)).toEqual([
      "ACME_INC INVESTED_IN NORTHWIND",
      "ADA_LOVELACE FOUNDED NORTHWIND",
      "JANE_DOE WORKS_FOR ACME_INC",
      "NORTHWIND HEADQUARTERED_IN PARIS",
    ]);
    // Direction: Northwind did not invest in Acme, and nobody was "acquired".
    expect(all.some((e) => e.relation === "ACQUIRED")).toBe(false);
    expect(all.some((e) => e.source === "NORTHWIND" && e.target === "ACME_INC")).toBe(false);
    expect(await stat(page, "names")).toBe(6);
    expect(await stat(page, "links")).toBe(4);
    expect(await stat(page, "review")).toBe(0);
    await expect(page.getByTestId("keep-out")).toHaveText("0.80");
    await expect(page.getByTestId("drop-out")).toHaveText("0.20");
    expect(await stat(page, "calls")).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("tab-links").locator(".count")).toHaveText("4");
    await shot(page, "01-northwind");
    info.annotations.push({ type: "screenshot", description: "docs/img/demo/01-northwind.png" });
  });

  test("hovering a link shows the sentence behind it", async ({ page }) => {
    await openDemo(page);
    await page
      .locator('[data-testid="edge"][data-relation="INVESTED_IN"] .edge-hit')
      .hover({ force: true });
    await expect(page.getByTestId("evidence-text")).toHaveText("Acme Inc invested in Northwind.");
    await expect(page.getByTestId("evidence")).toContainText("the model said 0.9");
  });

  test("document tab marks every kept name with its kind", async ({ page }) => {
    await openDemo(page);
    const marks = page.locator('[data-testid="mention"]');
    await expect(marks.first()).toBeVisible();
    const types = await marks.evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
    expect(types).toContain("PERSON");
    expect(types).toContain("COMPANY");
    expect(types).toContain("LOCATION");
    expect(await marks.evaluateAll((els) => els.every((e) => e.getAttribute("data-band") === "ACCEPT"))).toBe(true);
  });

  test("new names, hedging and negation go to a person or are dropped", async ({ page }) => {
    await openDemo(page);
    await pick(page, "unknown");
    const all = await edges(page);
    expect(kept(all)).toEqual(["ADA_LOVELACE FOUNDED NORTHWIND"]);
    // "Acme Inc might acquire Northwind" is a ghost edge, not a kept one.
    const ghost = all.filter((e) => e.pending);
    expect(ghost.map((e) => `${e.source} ${e.relation} ${e.target}`)).toEqual(["ACME_INC ACQUIRED NORTHWIND"]);
    // "Jane Doe never worked for Acme Inc" is a no: no edge of either kind.
    expect(all.some((e) => e.source === "JANE_DOE")).toBe(false);
    // Orion Labs is not on the list; the model is unsure, so it is a dashed node.
    await expect(page.locator('[data-testid="node"][data-pending="true"]')).toHaveCount(1);
    await page.getByTestId("tab-review").click();
    const rows = page.locator('[data-testid="review-row"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Orion Labs" })).toContainText("Which kind is");
    await expect(rows.filter({ hasText: "acquired" })).toContainText("between your drop cutoff");
    await expect(page.getByTestId("tab-review").locator(".count")).toHaveText("2");
    await shot(page, "02-review");
  });

  test("passive voice flips direction", async ({ page }) => {
    await openDemo(page);
    await pick(page, "film");
    expect(kept(await edges(page))).toContain("OPPENHEIMER PRODUCED_BY UNIVERSAL_PICTURES");
    expect(kept(await edges(page))).not.toContain("UNIVERSAL_PICTURES PRODUCED_BY OPPENHEIMER");
  });

  test("negation is a no and pronouns are never names", async ({ page }) => {
    await openDemo(page);
    await pick(page, "negation");
    expect(kept(await edges(page))).toEqual([]);
    await pick(page, "pronouns");
    expect(kept(await edges(page))).toEqual(["ACME_INC USES EDGEQUAKE"]);
    const surfaces = await page
      .locator('[data-testid="mention"]')
      .evaluateAll((els) => els.map((e) => (e.firstChild?.textContent ?? "").trim()));
    expect(surfaces.map((s) => s.toLowerCase())).not.toContain("she");
    expect(surfaces.map((s) => s.toLowerCase())).not.toContain("they");
  });

  test("a code fence is data, not a question", async ({ page }) => {
    await openDemo(page);
    await pick(page, "fence");
    expect(await nodeNames(page)).toEqual(["OLLAMA"]);
  });

  const DOMAINS: Record<string, { ontology: string; triples: string[]; screenshot: string }> = {
    papers: {
      ontology: "research_papers",
      screenshot: "03-research-papers",
      triples: [
        "ASHISH_VASWANI AUTHORED ATTENTION_IS_ALL_YOU_NEED",
        "ASHISH_VASWANI WORKS_AT GOOGLE_BRAIN",
        "ATTENTION_IS_ALL_YOU_NEED PROPOSES TRANSFORMER",
        "BERT BUILDS_ON TRANSFORMER",
        "TRANSFORMER EVALUATED_ON WMT_2014",
        "TRANSFORMER OUTPERFORMS LSTM",
      ],
    },
    film: {
      ontology: "movies",
      screenshot: "04-film",
      triples: [
        "CHRISTOPHER_NOLAN DIRECTED OPPENHEIMER",
        "CILLIAN_MURPHY BORN_IN CORK",
        "CILLIAN_MURPHY STARRED_IN OPPENHEIMER",
        "OPPENHEIMER PRODUCED_BY UNIVERSAL_PICTURES",
        "OPPENHEIMER SET_IN LOS_ALAMOS",
      ],
    },
    medicine: {
      ontology: "biomedical",
      screenshot: "05-medicine",
      triples: [
        "BRCA1 ASSOCIATED_WITH BREAST_CANCER",
        "IMATINIB INHIBITS BCR_ABL",
        "IMATINIB TREATS CHRONIC_MYELOID_LEUKEMIA",
        "METFORMIN TREATS TYPE_2_DIABETES",
        "TAMOXIFEN INHIBITS ESR1",
      ],
    },
    history: {
      ontology: "history",
      screenshot: "06-history",
      triples: [
        "BATTLE_OF_WATERLOO TOOK_PLACE_IN BELGIUM",
        "NAPOLEON_BONAPARTE BORN_IN CORSICA",
        "NAPOLEON_BONAPARTE FOUGHT_IN BATTLE_OF_WATERLOO",
        "NAPOLEON_BONAPARTE RULED FRANCE",
        "PARIS CAPITAL_OF FRANCE",
      ],
    },
  };

  for (const [sample, want] of Object.entries(DOMAINS)) {
    test(`ontology ${want.ontology}: the expected graph`, async ({ page }) => {
      await openDemo(page);
      await pick(page, sample);
      await expect(page.getByTestId("ontology")).toHaveValue(want.ontology);
      expect(kept(await edges(page))).toEqual(want.triples);
      await shot(page, want.screenshot);
    });
  }

  test("the tech-docs sample keeps only what the text says", async ({ page }) => {
    await openDemo(page);
    await pick(page, "edgequake");
    expect(kept(await edges(page))).toEqual(["ACME_INC USES EDGEQUAKE", "EDGEQUAKE DEPENDS_ON POSTGRESQL"]);
  });
});

test.describe("the cutoff is yours", () => {
  test("a stricter cutoff moves links to review without asking the model again", async ({ page }) => {
    await openDemo(page);
    expect(await stat(page, "links")).toBe(4);
    await afterRun(page, () => page.getByTestId("keep").fill("0.99"));
    expect(await stat(page, "links")).toBe(0);
    expect(await stat(page, "review")).toBe(4);
    // Same questions, same answers: the decision cache serves all of them.
    expect(await stat(page, "calls")).toBe(0);
    expect(await stat(page, "cached")).toBeGreaterThan(0);
    await expect(page.getByTestId("empty")).toContainText("no link passed the cutoff");
    await expect(page.getByTestId("keep-out")).toHaveText("0.99");
    await page.getByTestId("tab-review").click();
    await expect(page.locator('[data-testid="review-row"]')).toHaveCount(4);
    await shot(page, "07-strict-cutoff");
    // And back again.
    await afterRun(page, () => page.getByTestId("keep").fill("0.8"));
    expect(await stat(page, "links")).toBe(4);
    expect(await stat(page, "calls")).toBe(0);
  });

  test("the two cutoffs cannot cross", async ({ page }) => {
    await openDemo(page);
    await page.getByTestId("drop").fill("0.49");
    await page.getByTestId("keep").fill("0.5");
    const drop = Number(await page.getByTestId("drop").inputValue());
    const keep = Number(await page.getByTestId("keep").inputValue());
    expect(keep - drop).toBeGreaterThanOrEqual(0.049);
  });
});

test.describe("any document", () => {
  const NOTE = [
    "# Early radioactivity",
    "",
    "Marie Curie discovered Polonium in Paris.",
    "Marie Curie was born in Warsaw.",
    "Pierre Curie did not discover Radium.",
    "",
  ].join("\n");

  test("uploads a markdown file and reads it", async ({ page }) => {
    await openDemo(page);
    await afterRun(page, () =>
      page.getByTestId("file").setInputFiles({ name: "curie.md", mimeType: "text/markdown", buffer: Buffer.from(NOTE) }),
    );
    await expect(page.getByTestId("text")).toHaveValue(NOTE);
    await expect(page.getByTestId("file-info")).toContainText("curie.md");
    await expect(page.getByTestId("file-info")).toContainText("words");
    // The company ontology lists only Paris. The rest are asked about, not ignored:
    // every one of them reaches the graph, kept or waiting for a person.
    expect(await nodeNames(page)).toEqual(["MARIE_CURIE", "PARIS", "PIERRE_CURIE", "POLONIUM", "RADIUM", "WARSAW"]);
    expect(await stat(page, "calls")).toBeGreaterThan(0);
    await expect(page.getByTestId("empty")).toContainText("no link passed");
  });

  test("suggests the names it found, and lets you file them under your own kinds", async ({ page }) => {
    await openDemo(page);
    await afterRun(page, () =>
      page.getByTestId("file").setInputFiles({ name: "curie.md", mimeType: "text/markdown", buffer: Buffer.from(NOTE) }),
    );
    const chips = page.locator('[data-testid="suggestion"]');
    await expect(chips.filter({ hasText: "Marie Curie" })).toHaveCount(1);
    const texts = (await chips.allInnerTexts()).map((t) => t.replace(/×\d+/, "").trim());
    expect(texts).toEqual(expect.arrayContaining(["Marie Curie", "Pierre Curie", "Polonium", "Radium", "Warsaw"]));
    // Paris is already on the company ontology's list, so it is not offered.
    expect(texts).not.toContain("Paris");
    // Common first words are not offered as names.
    expect(texts).not.toContain("Early");

    // 1. Write the ontology: New starts from a commented template.
    await page.getByTestId("new-ontology").click();
    await expect(page.getByTestId("yaml")).toBeVisible();
    await expect(page.getByTestId("ontology")).toHaveValue("custom");
    await expect(page.getByTestId("yaml-msg")).toContainText("legal links");
    const science = [
      "id: science",
      "title: Early radioactivity",
      "types:",
      "  - id: SCIENTIST",
      "    description: A named researcher.",
      "    color: \"#7dd3fc\"",
      "  - id: ELEMENT",
      "    description: A named chemical element.",
      "    color: \"#fcd34d\"",
      "  - id: CITY",
      "    description: A named city.",
      "    color: \"#fda4af\"",
      "relations:",
      "  - id: DISCOVERED",
      "    description: The scientist discovered the element.",
      "    domain: [SCIENTIST]",
      "    range: [ELEMENT]",
      "  - id: BORN_IN",
      "    description: The scientist was born in the city.",
      "    domain: [SCIENTIST]",
      "    range: [CITY]",
      "gazetteer: {}",
      "",
    ].join("\n");
    await afterRun(page, () => page.getByTestId("yaml").fill(science));
    await expect(page.getByTestId("yaml-msg")).toContainText("3 kinds");
    await expect(page.getByTestId("kinds")).toContainText("scientist");
    // A new ontology lists nothing, so Paris is now a suggestion too.
    await expect(chips.filter({ hasText: "Paris" })).toHaveCount(1);

    // 2. Teach it the names, one kind at a time.
    const addAs = async (kind: string, names: string[]) => {
      await page.getByTestId("suggest-type").selectOption(kind);
      for (const n of names) {
        await afterRun(page, () => page.locator('[data-testid="suggestion"]', { hasText: n }).first().click());
      }
    };
    await addAs("SCIENTIST", ["Marie Curie", "Pierre Curie"]);
    await addAs("ELEMENT", ["Polonium", "Radium"]);
    await addAs("CITY", ["Paris", "Warsaw"]);
    await expect(page.getByTestId("yaml")).toHaveValue(/Marie Curie: SCIENTIST/);
    await expect(page.getByTestId("yaml")).toHaveValue(/Warsaw: CITY/);
    await expect(page.getByTestId("suggest")).toBeHidden();

    expect(kept(await edges(page))).toEqual([
      "MARIE_CURIE BORN_IN WARSAW",
      "MARIE_CURIE DISCOVERED POLONIUM",
    ]);
    // "Pierre Curie did not discover Radium": a no, so nothing connects them.
    expect(await nodeNames(page)).toEqual(["MARIE_CURIE", "PARIS", "PIERRE_CURIE", "POLONIUM", "RADIUM", "WARSAW"]);
    await page.getByTestId("tab-links").click();
    await expect(page.locator('[data-testid="link-row"]')).toHaveCount(2);
    await shot(page, "08-your-document-your-ontology");
  });

  test("uploads an ontology file", async ({ page }) => {
    await openDemo(page);
    const yaml = readFileSync(resolve(here, "../src/ontologies/movies.yaml"), "utf8").replace("id: movies", "id: my_cinema");
    await afterRun(page, () =>
      page.getByTestId("yaml-file").setInputFiles({ name: "my_cinema.yaml", mimeType: "text/yaml", buffer: Buffer.from(yaml) }),
    );
    await expect(page.getByTestId("ontology")).toHaveValue("my_cinema");
    await expect(page.getByTestId("kinds")).toContainText("film");
    await expect(page.getByTestId("yaml-msg")).toContainText("4 kinds");
    // And it can be applied to a document right away.
    await afterRun(page, () =>
      page.getByTestId("file").setInputFiles({
        name: "film.md",
        mimeType: "text/markdown",
        buffer: readFileSync(resolve(here, "../src/ontologies/movies.md")),
      }),
    );
    expect(kept(await edges(page))).toContain("CHRISTOPHER_NOLAN DIRECTED OPPENHEIMER");
  });

  test("a broken ontology is explained, and nothing is run on it", async ({ page }) => {
    await openDemo(page);
    await page.getByTestId("toggle-yaml").click();
    const before = await stat(page, "links");
    await page.getByTestId("yaml").fill("id: broken\ntypes: []\nrelations: []\n");
    await expect(page.getByTestId("yaml-msg")).toHaveClass(/bad/);
    await expect(page.getByTestId("yaml-msg")).toContainText("between 2 and 50 kinds");
    await settled(page);
    expect(await stat(page, "links")).toBe(before); // the last good graph stays
    await page.getByTestId("yaml").fill("this: is: not: yaml: [");
    await expect(page.getByTestId("yaml-msg")).toHaveClass(/bad/);
    await shot(page.locator(".controls"), "09-ontology-error");
  });

  test("refuses files that are not text", async ({ page }) => {
    await openDemo(page);
    await page.getByTestId("file").setInputFiles({ name: "paper.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
    await expect(page.getByTestId("text-msg")).toContainText("Convert PDF or Word files to markdown first");
    await page.getByTestId("file").setInputFiles({ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("ab\u0000cd") });
    await expect(page.getByTestId("text-msg")).toContainText("does not look like a text file");
  });

  test("your own text is read when you press Extract graph", async ({ page }) => {
    await openDemo(page);
    await page.getByTestId("text").fill("Ada Lovelace founded Acme Inc in Berlin. Acme Inc invested in Northwind.");
    // Typing never calls the model by itself; the button does.
    await expect(page.getByTestId("run-note")).toContainText("Press Extract graph");
    await afterRun(page, () => page.getByTestId("run").click());
    expect(kept(await edges(page))).toEqual(["ACME_INC INVESTED_IN NORTHWIND", "ADA_LOVELACE FOUNDED ACME_INC"]);
    await expect(page.getByTestId("sample-blurb")).toContainText("Your own text");
  });

  test("exports the graph as JSON and the ontology as YAML", async ({ page }) => {
    await openDemo(page);
    await page.getByTestId("tab-json").click();
    const json = JSON.parse(await page.getByTestId("json").innerText());
    expect(json.relationships).toHaveLength(4);
    expect(json.entities.map((e: { name: string }) => e.name)).toContain("NORTHWIND");
    expect(json.relationships[0]).toMatchObject({ relation_type: expect.any(String), description: expect.any(String) });
    const [jsonDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-json").click()]);
    expect(jsonDl.suggestedFilename()).toBe("graph.json");
    const [yamlDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-yaml").click()]);
    expect(yamlDl.suggestedFilename()).toBe("company_news.yaml");
  });
});

test.describe("the decision model host", () => {
  test("posts the closed questions to /v1/systemone and builds the graph from the answers", async ({ page }) => {
    const posts: { url: string; body: string }[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push({ url: r.url(), body: r.postData() ?? "" });
    });
    await openDemo(page);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.url === `${HOST}/v1/systemone`)).toBe(true);
    // They really are closed questions: a yes/no probability or a pick from a fixed list.
    const kinds = new Set(posts.flatMap((p) => Object.values(JSON.parse(p.body).questions ?? {}).map((q) => (q as { type: string }).type)));
    expect([...kinds].every((k) => k === "noul" || k === "choice")).toBe(true);
    expect(kept(await edges(page))).toEqual([
      "ACME_INC INVESTED_IN NORTHWIND",
      "ADA_LOVELACE FOUNDED NORTHWIND",
      "JANE_DOE WORKS_FOR ACME_INC",
      "NORTHWIND HEADQUARTERED_IN PARIS",
    ]);
    expect(await stat(page, "calls")).toBeGreaterThanOrEqual(1);
    await shot(page.locator(".controls"), "10-host-mode");
  });

  test("there is no rule-based mode to choose: the model is the only extractor", async ({ page }) => {
    await openDemo(page);
    await expect(page.getByTestId("mode-standin")).toHaveCount(0);
    await expect(page.getByTestId("backend-ollama")).toBeChecked(); // suite forces Ollama stand-in
    await expect(page.getByTestId("host-url")).toBeVisible();
    await expect(page.getByTestId("host-model")).toBeVisible();
    await expect(page.getByTestId("webgpu-fields")).toBeHidden();
    await expect(page.getByTestId("backend-switch")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Rule-based");
  });

  test("WebGPU is selected by default when available", async ({ page }) => {
    await page.goto("/?webgpuMock=1");
    await page.evaluate(() => localStorage.removeItem("edgextract.inference.v1"));
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await expect(page.getByTestId("backend-webgpu")).toBeChecked();
    await expect(page.getByTestId("webgpu-fields")).toBeVisible();
    await expect(page.getByTestId("host-fields")).toBeHidden();
    await expect(page.getByTestId("webgpu-load")).toBeVisible();
    // Header primary action is Load Tev1 until weights are ready (not a disabled Extract).
    await expect(page.getByTestId("run")).toBeEnabled();
    await expect(page.getByTestId("run")).toHaveText(/Load Tev1/);
    await expect(page.getByTestId("run-note")).toContainText(/Load Tev1/);
  });

  test("default WebGPU model id is the Hub graph", async ({ page }) => {
    await page.goto("/?webgpuMock=1");
    await page.evaluate(() => localStorage.removeItem("edgextract.inference.v1"));
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await expect(page.getByTestId("webgpu-model")).toHaveValue("raphaelmansuy/tev1-0.8b-onnx-webgpu");
    await expect(page.getByTestId("mode-note")).toContainText("raphaelmansuy/tev1-0.8b-onnx-webgpu");
  });

  test("local /models config.json is JSON when present, else a real 404 (not SPA HTML)", async ({ page }) => {
    const res = await page.request.get("/models/tev1-0.8b-onnx/config.json");
    if (res.ok()) {
      expect(res.headers()["content-type"] || "").toMatch(/json/i);
      const body = await res.text();
      expect(body.trimStart().startsWith("<!")).toBe(false);
      const cfg = JSON.parse(body);
      expect(cfg).toHaveProperty("model_type");
      // Required so ORT Web mounts sibling *.onnx_data (else MountedFiles error).
      expect(cfg["transformers.js_config"]?.use_external_data_format?.embed_tokens).toBeGreaterThan(0);
      return;
    }
    expect(res.status()).toBe(404);
    const body = await res.text();
    expect(body.trimStart().startsWith("<!")).toBe(false);
  });

  test("Hub default idle shows Load (not missing-weights)", async ({ page }) => {
    await page.goto("/?webgpuMock=1");
    await page.evaluate(() => localStorage.removeItem("edgextract.inference.v1"));
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await expect(page.getByTestId("backend-webgpu")).toBeChecked();
    await expect(page.getByTestId("webgpu-fields")).toBeVisible();
    await expect(page.getByTestId("webgpu-load")).toBeVisible();
    await expect(page.getByTestId("run")).toHaveText(/Load Tev1/);
    await expect(page.getByTestId("webgpu-status")).not.toContainText(/No ONNX|weights missing|Cannot reach/i);
    await expect(page.getByTestId("webgpu-status")).toContainText(/Load Tev1|Mock loader|Hugging Face|downloads/i);
  });

  test("missing local ONNX id fails closed on Load", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "edgextract.inference.v1",
        JSON.stringify({
          backend: "webgpu",
          hostUrl: "http://localhost:11434",
          hostModel: "tev1",
          webgpuModel: "missing-local-onnx",
        }),
      );
    });
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    if (await page.getByTestId("backend-webgpu").isDisabled()) {
      test.skip(true, "WebGPU unavailable without mock");
    }
    await expect(page.getByTestId("webgpu-model")).toHaveValue("missing-local-onnx");
    await page.getByTestId("run").click();
    await expect(page.getByTestId("webgpu-fields")).toHaveAttribute("data-webgpu-state", "error");
    await expect(page.getByTestId("webgpu-status")).toContainText(/No ONNX|\/models\/|demo-webgpu-model|Hub id|Ollama/i);
    await expect(page.getByTestId("run")).toHaveText(/Load Tev1|Try Load/);
  });

  test("remembers the selected inference backend in localStorage", async ({ page }) => {
    await page.goto("/?webgpuMock=1");
    await page.evaluate(() => localStorage.removeItem("edgextract.inference.v1"));
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await page.locator('label.backend-seg-opt:has([data-testid="backend-ollama"])').click();
    await expect(page.getByTestId("backend-ollama")).toBeChecked();
    await page.getByTestId("host-model").fill("tev1:0.8b");
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem("edgextract.inference.v1");
          return raw ? (JSON.parse(raw) as { backend: string; hostModel: string }).backend : "";
        }),
      )
      .toBe("ollama");
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    // No backend= in the URL — localStorage must win over the WebGPU HTML default.
    await expect(page.getByTestId("backend-ollama")).toBeChecked();
    await expect(page.getByTestId("host-model")).toHaveValue("tev1:0.8b");
    await expect(page.getByTestId("host-fields")).toBeVisible();
  });

  test("unavailable WebGPU leaves Ollama working", async ({ page }) => {
    await openDemo(page);
    if (!(await page.getByTestId("backend-webgpu").isDisabled())) {
      test.skip(true, "WebGPU is available in this browser; unavailable path not exercised");
    }
    await expect(page.getByTestId("backend-ollama")).toBeChecked();
    await expect(page.getByTestId("backend-unavailable")).toBeVisible();
    await expect(page.getByTestId("host-fields")).toBeVisible();
    expect(kept(await edges(page))).toContain("ADA_LOVELACE FOUNDED NORTHWIND");
  });

  test("WebGPU mock load shows progress then ready, and Extract stays fail-closed", async ({ page }) => {
    await openDemo(page, {
      host: HOST,
      model: "test-double",
      backend: "webgpu",
      webgpuMock: true,
      waitForRun: false,
    });
    await expect(page.getByTestId("backend-webgpu")).toBeChecked();
    await expect(page.getByTestId("backend-webgpu")).toBeEnabled();
    await expect(page.getByTestId("webgpu-fields")).toBeVisible();
    await expect(page.getByTestId("host-fields")).toBeHidden();
    await expect(page.getByTestId("run")).toHaveText(/Load Tev1/);
    await expect(page.getByTestId("run")).toBeEnabled();

    // Header primary action loads Tev1 (same as step-3 button).
    await page.getByTestId("run").click();
    await expect(page.getByTestId("webgpu-progress-wrap")).toBeVisible();
    await expect(page.getByTestId("webgpu-stages")).toBeVisible();
    // Warm is a first-class stage (cache → compile → warm → go).
    await expect(page.getByTestId("webgpu-progress-wrap")).toHaveAttribute("data-phase", "warm", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("webgpu-progress-label")).toContainText(/Warming|warm/i);
    await expect(page.getByTestId("webgpu-fields")).toHaveAttribute("data-webgpu-state", "ready", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("webgpu-ready")).toBeVisible();
    await expect(page.getByTestId("webgpu-ready")).toContainText(/warmed|ready/i);
    await expect(page.getByTestId("webgpu-status")).toContainText(/warm/i);
    await expect(page.getByTestId("run")).toHaveText("Extract graph");
    await expect(page.getByTestId("run")).toBeEnabled();
    await shot(page.locator(".controls"), "12-webgpu-ready");

    await afterRun(page, () => page.getByTestId("run").click());
    await expect(page.getByTestId("error")).toBeVisible();
    await expect(page.getByTestId("error")).toContainText("mock loader");
    expect(await edges(page)).toEqual([]);

    // The segmented control paints a <span> over the radio; click the label.
    await page.locator('label.backend-seg-opt:has([data-testid="backend-ollama"])').click();
    await expect(page.getByTestId("backend-ollama")).toBeChecked();
    await expect(page.getByTestId("host-fields")).toBeVisible();
    await expect(page.getByTestId("webgpu-fields")).toBeHidden();
    await expect(page.getByTestId("run-note")).toContainText("Backend changed");
  });

  test("an unreachable host fails closed: an error and an empty graph, never a guess", async ({ page }) => {
    await openDemo(page, "http://127.0.0.1:9");
    await expect(page.getByTestId("error")).toBeVisible();
    await expect(page.getByTestId("error")).toContainText("cannot reach");
    await expect(page.getByTestId("error")).toContainText("Nothing was invented");
    await expect(page.getByTestId("ollama-dialog")).toBeVisible();
    await expect(page.getByTestId("ollama-checks")).toContainText(/did not answer|could not fetch|No HTTP/i);
    await expect(page.getByTestId("ollama-dialog-cmd")).toContainText("ollama serve");
    expect(await edges(page)).toEqual([]);
    expect(await nodeNames(page)).toEqual([]);
    await shot(page, "11-host-down");
    // Point it at a host that answers and retry from the diagnostic dialog.
    await page.getByTestId("ollama-dialog-url").fill(HOST);
    await afterRun(page, () => page.getByTestId("ollama-dialog-retry").click());
    await expect(page.getByTestId("error")).toBeHidden();
    expect(await stat(page, "links")).toBe(4);
  });

  test("a document with names no list knows is still read: the model is asked about them", async ({ page }) => {
    await openDemo(page);
    const doc = readFileSync(resolve(here, "fixtures/procedural-memory.md"));
    await afterRun(page, () =>
      page.getByTestId("file").setInputFiles({ name: "procedural-memory.md", mimeType: "text/markdown", buffer: doc }),
    );
    await expect(page.getByTestId("file-info")).toContainText("procedural-memory.md");
    // Regression: this used to ask nothing (0 calls, 0 names) because no name was listed.
    expect(await stat(page, "calls")).toBeGreaterThan(0);
    const names = await nodeNames(page);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toEqual(expect.arrayContaining(["ADOBE", "BROWN_UNIVERSITY"]));
    await shot(page, "13-unlisted-names-are-asked");
  });
});

test.describe("the graph", () => {
  test("names can be dragged, and links follow", async ({ page }) => {
    await openDemo(page);
    const node = page.locator('[data-testid="node"][data-name="NORTHWIND"]');
    const edge = page.locator('[data-testid="edge"][data-target="NORTHWIND"] .edge-line').first();
    const before = { box: await node.boundingBox(), d: await edge.getAttribute("d") };
    const box = before.box!;
    await page.mouse.move(box.x + box.width / 2, box.y + 22);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + 22 + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = { box: await node.boundingBox(), d: await edge.getAttribute("d") };
    expect(Math.abs(after.box!.x - before.box!.x)).toBeGreaterThan(40);
    expect(after.d).not.toEqual(before.d);
  });

  test("nothing overlaps: every name sits inside the canvas and labels do not collide", async ({ page }) => {
    await openDemo(page);
    for (const sample of ["northwind", "edgequake", "papers", "history"]) {
      await pick(page, sample);
      const svg = (await page.getByTestId("graph").boundingBox())!;
      const boxes = await page.locator('[data-testid="node"]').evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { name: e.getAttribute("data-name"), x: r.x, y: r.y, w: r.width, h: r.height };
        }),
      );
      expect(boxes.length).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.x, `${sample}: ${b.name} left`).toBeGreaterThanOrEqual(svg.x - 1);
        expect(b.y, `${sample}: ${b.name} top`).toBeGreaterThanOrEqual(svg.y - 1);
        expect(b.x + b.w, `${sample}: ${b.name} right`).toBeLessThanOrEqual(svg.x + svg.width + 1);
        expect(b.y + b.h, `${sample}: ${b.name} bottom`).toBeLessThanOrEqual(svg.y + svg.height + 1);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const c = boxes[j];
          const overlap = a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
          expect(overlap, `${sample}: ${a.name} overlaps ${c.name}`).toBe(false);
        }
      }
    }
  });
});

test.describe("looks right", () => {
  test("the default view matches its baseline", async ({ page }, info) => {
    await openDemo(page);
    const baseline = resolve(here, "__screenshots__", process.platform, "northwind-graph.png");
    test.skip(!existsSync(baseline) && !process.env.UPDATE_BASELINES, `no ${process.platform} baseline yet; run with UPDATE_BASELINES=1`);
    await expect(page.getByTestId("graph")).toHaveScreenshot("northwind-graph.png");
    await expect(page.locator(".controls")).toHaveScreenshot("controls.png");
    await expect(page.locator(".results")).toHaveScreenshot("document-tab.png");
    info.annotations.push({ type: "baseline", description: baseline });
  });

  test("the page is not blank and fits the viewport", async ({ page }) => {
    await openDemo(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // Count the distinct colours in the graph: a blank canvas has almost none.
    const colours = await page.getByTestId("graph").screenshot().then((buf) => buf.length);
    expect(colours).toBeGreaterThan(15_000);
  });

  for (const [name, width, height] of [
    ["laptop", 1280, 800],
    ["tablet", 900, 1100],
    ["phone", 390, 900],
  ] as const) {
    test(`stays usable on a ${name} (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openDemo(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "no sideways scrolling").toBeLessThanOrEqual(1);
      await expect(page.locator('[data-testid="edge"]')).toHaveCount(4);
      const svg = await page.getByTestId("graph").boundingBox();
      expect(svg!.width).toBeGreaterThan(Math.min(300, width - 40));
      await shot(page, `12-${name}`, true);
    });
  }
});
