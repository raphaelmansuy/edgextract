import { expect, test } from "@playwright/test";
import { openDemo, shot } from "./helpers";

/**
 * The Extract button, and the whole page, are on screen at every size and on every view.
 * The page itself never scrolls: whatever is long scrolls inside its own panel.
 */
const SIZES: [string, number, number][] = [
  ["desktop 1600x1000", 1600, 1000],
  ["laptop 1440x800", 1440, 800],
  ["small laptop 1280x720", 1280, 720],
  ["tablet landscape 1024x768", 1024, 768],
  ["tablet portrait 768x1024", 768, 1024],
  ["phone 390x844", 390, 844],
  ["small phone 360x640", 360, 640],
  ["phone landscape 844x390", 844, 390],
];

for (const [name, w, h] of SIZES) {
  test(`${name}: Extract is always in view, and the page does not scroll`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openDemo(page);
    for (const view of ["inputs", "graph", "results"]) {
      const nav = page.getByTestId(`view-${view}`);
      if (await nav.isVisible()) await nav.click();
      // Scroll a panel as far as it goes: the button must not move.
      await page.evaluate(() => document.querySelectorAll(".controls, .tabpane").forEach((e) => e.scrollTo(0, 1e6)));
      const m = await page.evaluate(() => {
        const b = document.getElementById("run")!.getBoundingClientRect();
        const de = document.documentElement;
        return {
          top: b.top,
          bottom: b.bottom,
          width: b.width,
          height: b.height,
          scrollY: window.scrollY,
          pageOverflowY: de.scrollHeight - window.innerHeight,
          pageOverflowX: de.scrollWidth - window.innerWidth,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
        };
      });
      const why = `${name} / ${view}`;
      expect(m.width, why).toBeGreaterThan(80);
      expect(m.top, why).toBeGreaterThanOrEqual(0);
      expect(m.bottom, why).toBeLessThanOrEqual(m.innerHeight);
      expect(m.pageOverflowY, why).toBeLessThanOrEqual(1);
      expect(m.pageOverflowX, why).toBeLessThanOrEqual(1);
      expect(m.scrollY, why).toBe(0);
      expect(m.height, `${why}: tap target`).toBeGreaterThanOrEqual(40);
    }
    if (await page.getByTestId("view-graph").isVisible()) await page.getByTestId("view-graph").click();
    await page.getByTestId("run").click();
    await expect(page.getByTestId("run")).toBeVisible();
  });
}

test("the button shows what it is about to do and glows when the text changed", async ({ page }) => {
  await openDemo(page);
  await page.getByTestId("text").fill("Marie Curie worked in Paris.");
  await expect(page.getByTestId("run-note")).toContainText("Press Extract graph");
  await expect(page.getByTestId("run")).toBeInViewport();
  await shot(page, "20-text-changed");
});
