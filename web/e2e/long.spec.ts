import { expect, test, type Page } from "@playwright/test";
import { openDemo, phase, SLOW, settled, shot, stat } from "./helpers";

/**
 * A long, awkward document, shaped like the wiki dumps that broke the first version:
 * headings, long paragraphs, bullet lists with no full stops, tables, and one very long
 * line. The model host the suite starts refuses any prompt over 2050 tokens, exactly
 * like the real one, so a sentence that is too long fails here too.
 */
function wikiDocument(sections: number): string {
  const first = ["Ada", "Boris", "Chloe", "Dmitri", "Elena", "Farid", "Greta", "Hugo", "Irene", "Jonas", "Kira", "Louis"];
  const last = ["Marlow", "Novak", "Okafor", "Petrov", "Quinn", "Rossi", "Sato", "Tanaka", "Ueda", "Varga", "Weber", "Young"];
  const org = ["Orion Dynamics", "Helix Partners", "Atlas Leasing", "Boreal Capital", "Cobalt Aviation", "Delta Ventures"];
  const city = ["Dublin", "Lisbon", "Oslo", "Prague", "Zurich", "Vienna"];
  const out: string[] = ["# Long fund wiki", ""];
  for (let s = 0; s < sections; s++) {
    const person = (k: number) => `${first[(s + k) % first.length]} ${last[(s * 3 + k) % last.length]}`;
    const company = (k: number) => org[(s + k) % org.length];
    const town = (k: number) => city[(s + k) % city.length];
    out.push(`## Section ${s + 1}: ${company(0)}`, "");
    out.push(
      `${person(0)} works for ${company(0)} in ${town(0)}. ${person(1)} founded ${company(1)} and later joined ${company(2)}. ` +
        `${company(0)} is headquartered in ${town(1)}, and ${person(2)} leads the team there. ` +
        `${person(3)} met ${person(4)} while ${company(3)} was moving to ${town(2)}.`,
      "",
    );
    // List items have no full stops, so a naive splitter glues them into one huge "sentence".
    for (let k = 0; k < 6; k++) out.push(`- ${person(k)}, ${company(k)}, ${town(k)}, board member since ${2001 + k}`);
    out.push("", "| Name | Employer | City |", "|---|---|---|");
    for (let k = 0; k < 5; k++) out.push(`| ${person(k + 5)} | ${company(k + 1)} | ${town(k + 2)} |`);
    out.push("");
    // One enormous line, the kind a pasted export produces.
    out.push(Array.from({ length: 70 }, (_, k) => `${person(k)} of ${company(k)}`).join(", ") + ".", "");
  }
  return out.join("\n");
}

async function upload(page: Page, name: string, text: string): Promise<void> {
  await page.getByTestId("file").setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(text) });
}

async function waitPhase(page: Page, want: string, timeout = 60_000): Promise<void> {
  await expect.poll(() => phase(page), { timeout }).toBe(want);
}

const errorText = (page: Page) => page.getByTestId("error");

test.describe("a long document", () => {
  test("asks before spending many model calls, then reads in sections without a 400", async ({ page }, info) => {
    test.setTimeout(90_000);
    await openDemo(page);
    const doc = wikiDocument(10);
    expect(doc.length).toBeGreaterThan(30_000);

    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/v1/systemone")) posts.push(r.url());
    });
    await upload(page, "fund-wiki.md", doc);

    // 1. A plan, not a silent wait. Nothing was sent to the model yet.
    await waitPhase(page, "planned");
    await expect(page.getByTestId("plan")).toBeVisible();
    await expect(page.getByTestId("plan-body")).toContainText("sections");
    await expect(page.getByTestId("plan-body")).toContainText("words");
    expect(posts.length, "no model call before the reader agrees").toBe(0);
    await shot(page, "14-long-plan");

    // 2. A preview: only the first sections are read, and it says so.
    await page.getByTestId("plan-preview").click();
    await waitPhase(page, "paused");
    await expect(errorText(page)).toBeHidden();
    await expect(page.getByTestId("notice")).toBeVisible();
    await expect(page.getByTestId("notice")).toContainText(/first \d+ of \d+ sections/i);
    const previewCalls = posts.length;
    expect(previewCalls).toBeGreaterThan(0);
    const previewLinks = await stat(page, "links");
    await shot(page, "15-long-preview");

    // 3. Continue: the rest is read, and the graph only grows.
    await page.getByTestId("continue").click();
    await waitPhase(page, "done");
    await expect(errorText(page)).toBeHidden();
    await expect(page.getByTestId("notice")).toBeHidden();
    expect(posts.length).toBeGreaterThan(previewCalls);
    expect(await stat(page, "links")).toBeGreaterThanOrEqual(previewLinks);

    // 4. The graph is capped so the page stays quick, and says how.
    const drawn = await page.locator('[data-testid="node"]').count();
    expect(drawn).toBeLessThanOrEqual(80);
    expect(drawn).toBeGreaterThan(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await info.attach("done", { body: await page.screenshot(), contentType: "image/png" });
    await shot(page, "16-long-done");
  });

  test("a single line far past the model's window is cut at the source, never refused", async ({ page }) => {
    await openDemo(page);
    // 6,000 characters with no full stop and no new line.
    const wall = Array.from({ length: 400 }, (_, i) => `Acme Inc, Northwind Corp and word${i}`).join(", ");
    expect(wall.length).toBeGreaterThan(10_000);
    await upload(page, "wall.md", `${wall}.\n`);
    // Either it is small enough to run straight away, or it offers a plan.
    await expect.poll(() => phase(page)).toMatch(/planned|done/);
    if ((await phase(page)) === "planned") await page.getByTestId("plan-all").click();
    await waitPhase(page, "done");
    await expect(errorText(page)).toBeHidden();
  });

  test("while it reads you see progress, can stop with a partial graph, and continue", async ({ page }) => {
    test.setTimeout(150_000);
    await openDemo(page, SLOW);
    await upload(page, "fund-wiki.md", wikiDocument(3));
    await waitPhase(page, "planned");
    await page.getByTestId("plan-all").click();

    // Progress is on screen and says where the read is.
    await expect(page.getByTestId("progress")).toBeVisible();
    await expect(page.getByTestId("progress-title")).toContainText(/section/i);
    await expect(page.getByTestId("progress-detail")).toContainText(/call/i);
    await expect(page.locator("#bar")).toHaveAttribute("aria-valuenow", /\d+/);

    // Wait for the first partial graph, then stop.
    await expect.poll(() => page.locator('[data-testid="node"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByTestId("stop").click();
    await waitPhase(page, "paused");
    await expect(page.getByTestId("notice")).toContainText(/stopped|first/i);
    const partial = await page.locator('[data-testid="node"]').count();
    expect(partial).toBeGreaterThan(0);

    // Continue: it picks up where it stopped, the graph does not shrink.
    await page.getByTestId("continue").click();
    await waitPhase(page, "done", 120_000);
    expect(await page.locator('[data-testid="node"]').count()).toBeGreaterThanOrEqual(partial);
    await expect(errorText(page)).toBeHidden();
  });

  test("if the host dies half way, what was read stays on screen and Try again finishes", async ({ page }) => {
    await openDemo(page);
    let dead = false;
    await page.route("**/v1/systemone", async (route) => {
      if (dead) return route.abort("connectionrefused");
      return route.continue();
    });
    await upload(page, "fund-wiki.md", wikiDocument(8));
    await waitPhase(page, "planned");
    await page.getByTestId("plan-all").click();
    // The host goes away once a couple of sections are behind us.
    await expect(page.getByTestId("progress-title")).toContainText(/section [3-9]/i, { timeout: 60_000 });
    dead = true;
    await waitPhase(page, "error", 60_000);

    await expect(errorText(page)).toBeVisible();
    await expect(errorText(page)).toContainText(/section/i);
    await expect(page.getByTestId("retry")).toBeVisible();
    expect(await page.locator('[data-testid="node"]').count(), "partial result kept").toBeGreaterThan(0);

    dead = false;
    await page.getByTestId("retry").click();
    await waitPhase(page, "done", 60_000);
    await expect(errorText(page)).toBeHidden();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("three views, one at a time, with room to tap and no sideways scroll", async ({ page }) => {
    await openDemo(page);
    const nav = page.getByTestId("view-graph");
    await expect(nav).toBeVisible();

    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    // Graph first: it is the point of the page.
    await expect(page.locator('[data-testid="edge"]')).toHaveCount(4);
    await expect(page.locator(".controls")).toBeHidden();
    await expect(page.locator(".results")).toBeHidden();
    expect(await overflow()).toBeLessThanOrEqual(1);
    await shot(page, "17-phone-graph");

    await page.getByTestId("view-inputs").click();
    await expect(page.locator(".controls")).toBeVisible();
    await expect(page.locator(".stage")).toBeHidden();
    await expect(page.getByTestId("run")).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
    await shot(page, "18-phone-inputs");

    await page.getByTestId("view-results").click();
    await expect(page.locator(".results")).toBeVisible();
    await expect(page.locator(".controls")).toBeHidden();
    expect(await overflow()).toBeLessThanOrEqual(1);
    await shot(page, "19-phone-details");

    // Tap targets are at least 40 px tall.
    for (const id of ["view-inputs", "view-graph", "view-results"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height, id).toBeGreaterThanOrEqual(40);
    }
    await page.getByTestId("view-inputs").click();
    expect((await page.getByTestId("run").boundingBox())!.height).toBeGreaterThanOrEqual(40);
  });

  test("starting an extraction takes you to the graph", async ({ page }) => {
    await openDemo(page);
    await page.getByTestId("view-inputs").click();
    await page.getByTestId("run").click();
    await expect(page.locator(".stage")).toBeVisible();
    await settled(page);
    await expect(page.locator(".controls")).toBeHidden();
  });
});
