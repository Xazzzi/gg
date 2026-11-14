import type { Page } from "@playwright/test";
import { expect, test } from "./page.ts";

const rows = (page: Page) => page.locator("tbody tr");
const label = (page: Page, n: number) => rows(page).nth(n).locator("td").nth(1);
const ids = (page: Page, ...at: number[]) =>
  Promise.all(
    at.map(n => rows(page).nth(n).locator("td").first().textContent()),
  );

/** Clicks a button, and gives the time in ms until the frame after it and the task after that frame. */
const timed = (page: Page, id: string) =>
  page.evaluate(async id => {
    const start = performance.now();
    (document.getElementById(id) as HTMLElement).click();
    await new Promise(resolve =>
      requestAnimationFrame(() => setTimeout(resolve)),
    );
    return Math.round((performance.now() - start) * 10) / 10;
  }, id);

test.beforeEach(async ({ page }) => {
  await page.goto("bench/");
  await expect(page.locator("#run")).toBeVisible();
});

test("the table follows each action", async ({ page }) => {
  await page.locator("#run").click();
  await expect(rows(page)).toHaveCount(1000);
  expect(await ids(page, 0, 999)).toEqual(["1", "1000"]);

  const before = await label(page, 10).textContent();
  await page.locator("#update").click();
  await expect(label(page, 10)).toHaveText(`${before} !!!`);
  await expect(label(page, 11)).not.toContainText("!!!");

  await label(page, 4).locator("a").click();
  await expect(rows(page).nth(4)).toHaveClass("danger");
  await label(page, 7).locator("a").click();
  await expect(rows(page).nth(7)).toHaveClass("danger");
  await expect(rows(page).nth(4)).toHaveClass("");

  // A property on each node shows that a swap moves the rows, and makes none.
  await rows(page).evaluateAll(list =>
    list.forEach((tr, i) => {
      (tr as any).mark = i;
    }),
  );
  await page.locator("#swaprows").click();
  await expect(rows(page).nth(1).locator("td").first()).toHaveText("999");
  expect(await ids(page, 0, 1, 2, 998, 999)).toEqual([
    "1",
    "999",
    "3",
    "2",
    "1000",
  ]);
  expect(
    await rows(page).evaluateAll(list =>
      [0, 1, 2, 998, 999].map(i => (list[i] as any).mark),
    ),
  ).toEqual([0, 998, 2, 1, 999]);

  // The icon has no size without the stylesheet of js-framework-benchmark, so no pointer can click it.
  await rows(page)
    .nth(2)
    .locator("td")
    .nth(2)
    .locator("a")
    .dispatchEvent("click");
  await expect(rows(page)).toHaveCount(999);
  expect(await ids(page, 1, 2)).toEqual(["999", "4"]);

  await page.locator("#add").click();
  await expect(rows(page)).toHaveCount(1999);
  await page.locator("#clear").click();
  await expect(rows(page)).toHaveCount(0);
  await page.locator("#runlots").click();
  await expect(rows(page)).toHaveCount(10_000);
  await page.locator("#run").click();
  await expect(rows(page)).toHaveCount(1000);
  expect(await ids(page, 0)).toEqual(["12001"]);
});

test("rows that leave are collected, with their nodes and listeners", async ({
  page,
}) => {
  const session = await page.context().newCDPSession(page);
  const counters = async () => {
    await session.send("HeapProfiler.collectGarbage");
    return session.send("Memory.getDOMCounters");
  };
  const before = await counters();
  await page.locator("#run").click();
  await expect(rows(page)).toHaveCount(1000);
  expect((await counters()).nodes).toBeGreaterThan(before.nodes + 9_000);
  await page.locator("#clear").click();
  await expect(rows(page)).toHaveCount(0);
  // A suspended generator can hold the last row, so the limit leaves room for one.
  await expect
    .poll(async () => (await counters()).nodes)
    .toBeLessThan(before.nodes + 50);
  expect((await counters()).jsEventListeners).toBeLessThan(
    before.jsEventListeners + 10,
  );
});

// Reports times and heap sizes of a real browser, and checks none of them, because they vary by machine.
test("times and heap sizes", async ({ page }, info) => {
  const session = await page.context().newCDPSession(page);
  const heap = async () => {
    await session.send("HeapProfiler.collectGarbage");
    const { usedSize } = await session.send("Runtime.getHeapUsage");
    return usedSize / 2 ** 20;
  };
  const report: Record<string, string> = {};
  const run = async (name: string, id: string) => {
    report[name] = `${await timed(page, id)} ms`;
  };
  const empty = await heap();
  for (let i = 0; i < 3; i++) {
    await timed(page, "run");
    await timed(page, "clear");
  }
  await run("create 1k", "run");
  report["heap of 1k rows"] = `${((await heap()) - empty).toFixed(1)} MB`;
  await run("update every 10th of 1k", "update");
  await run("swap rows of 1k", "swaprows");
  await run("append 1k to 1k", "add");
  await run("clear 2k", "clear");
  await run("create 10k", "runlots");
  report["heap of 10k rows"] = `${((await heap()) - empty).toFixed(1)} MB`;
  await run("update every 10th of 10k", "update");
  await run("swap rows of 10k", "swaprows");
  await run("clear 10k", "clear");
  report["heap after clear"] = `${((await heap()) - empty).toFixed(1)} MB`;
  await expect(rows(page)).toHaveCount(0);
  const text = Object.entries(report)
    .map(([name, value]) => `${name.padEnd(28)}${value.padStart(10)}`)
    .join("\n");
  console.log(`\n${text}`);
  await info.attach("bench", { body: text, contentType: "text/plain" });
});
