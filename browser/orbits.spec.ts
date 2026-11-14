import type { Page } from "@playwright/test";
import { expect, SVG, test } from "./page.ts";

const tick = async (page: Page) =>
  Number(
    ((await page.locator(".status").textContent()) as string).match(
      /t (\d+)/,
    )?.[1],
  );
const planets = (page: Page) => page.locator(".orrery svg > g > g");

test.beforeEach(async ({ page }) => {
  await page.goto("orbits/");
  await expect(planets(page).first()).toBeAttached();
});

test("SVG tags get the SVG namespace, and keep the case of attributes", async ({
  page,
}) => {
  const spaces = await page.evaluate(() =>
    Object.fromEntries(
      [
        "svg",
        "title",
        "radialGradient",
        "stop",
        "feGaussianBlur",
        "g",
        "polyline",
        "circle",
        "text",
      ].map(tag => [
        tag,
        document.querySelector(`.orrery ${tag}`)?.namespaceURI,
      ]),
    ),
  );
  for (const [tag, space] of Object.entries(spaces))
    expect(space, tag).toBe(SVG);
  expect(
    await page
      .locator(".orrery svg")
      .evaluate(svg => svg.hasAttribute("viewBox")),
  ).toBe(true);
  // A circle with a size shows that the browser renders the nodes as SVG.
  const box = await planets(page).first().locator("circle").boundingBox();
  expect(box?.width).toBeGreaterThan(0);
});

test("dynamic props move the bodies while the simulation runs", async ({
  page,
}) => {
  const circle = planets(page).first().locator("circle");
  const cx = await circle.getAttribute("cx");
  const start = await tick(page);
  await expect.poll(() => circle.getAttribute("cx")).not.toBe(cx);
  await expect.poll(() => tick(page)).toBeGreaterThan(start);
  await expect(planets(page).first().locator("polyline")).toHaveAttribute(
    "points",
    /,.* /,
  );
  await expect(page.locator(".chart polyline")).toHaveAttribute("points", /,/);
});

test("the list follows bodies that arrive and leave", async ({ page }) => {
  const count = await planets(page).count();
  await page.getByRole("button", { name: "+50" }).click();
  await expect.poll(() => planets(page).count()).toBeGreaterThan(count);
  const more = await planets(page).count();
  await page.getByRole("button", { name: "-50" }).click();
  await expect.poll(() => planets(page).count()).toBeLessThan(more);
});

test("a view unmounts and mounts again, while the simulation runs on", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Unmount orrery" }).click();
  await expect(page.locator(".orrery")).toBeEmpty();
  await expect(
    page.getByRole("button", { name: "Mount orrery" }),
  ).toBeVisible();
  const start = await tick(page);
  await expect.poll(() => tick(page)).toBeGreaterThan(start);
  await page.getByRole("button", { name: "Mount orrery" }).click();
  const circle = planets(page).first().locator("circle");
  await expect(circle).toBeAttached();
  const cx = await circle.getAttribute("cx");
  await expect.poll(() => circle.getAttribute("cx")).not.toBe(cx);
  await expect(page.locator(".orrery svg")).toHaveCount(1);
});

test("stop ends the changes, and the wheel sets the view box", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  const stopped = await tick(page);
  await page.waitForTimeout(200);
  expect(await tick(page)).toBe(stopped);
  const svg = page.locator(".orrery svg");
  const view = await svg.getAttribute("viewBox");
  await svg.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(view);
});
