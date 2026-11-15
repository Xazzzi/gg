import type { Page } from "@playwright/test";
import { expect, test } from "./page.ts";

const row = (page: Page, name: string) =>
  page.locator(".row", { hasText: name });
const state = async (page: Page) =>
  JSON.parse((await page.locator(".state").textContent()) as string);
/** Reads the value of each control from the DOM, in the shape of the state. */
const controls = (page: Page) =>
  page.evaluate(() => {
    const field = (name: string, tag: string) =>
      [...document.querySelectorAll(".row")]
        .find(row => row.textContent?.includes(name))
        ?.querySelector(tag) as any;
    const boxes = [
      ...document.querySelectorAll("fieldset:nth-of-type(2) input"),
    ] as HTMLInputElement[];
    return {
      name: field("Name", "input").value,
      bio: field("Bio", "textarea").value,
      age: field("Age", "input").valueAsNumber,
      volume: field("Volume", "input").valueAsNumber,
      color: field("Color", "input").value,
      date: field("Date", "input").value,
      plan: (document.querySelector("input[type=radio]:checked") as any).value,
      country: field("Country", "select").value,
      features: boxes
        .slice(1)
        .filter(box => box.checked)
        .map(box => box.parentElement?.textContent?.trim()),
      languages: [...field("Languages", "select").selectedOptions].map(
        option => option.value,
      ),
      newsletter: (document.querySelector(".check input") as any).checked,
    };
  });

test.beforeEach(async ({ page }) => {
  await page.goto("forms/");
  await expect(page.locator(".state")).toContainText("Ada");
});

test("each control starts with the value of its field", async ({ page }) => {
  expect(await controls(page)).toEqual({
    name: "Ada",
    bio: "Writes notes on engines.",
    age: 36,
    volume: 40,
    color: "#3d8bfd",
    date: "1843-07-10",
    plan: "pro",
    country: "Norway",
    features: ["sync"],
    languages: ["TypeScript"],
    newsletter: true,
  });
  expect(await state(page)).toEqual(await controls(page));
  await expect(row(page, "Volume").locator("output")).toHaveText("40");
  // Some features, so the box of all is indeterminate through its live property.
  expect(
    await page
      .locator("fieldset:nth-of-type(2) input")
      .first()
      .evaluate((box: HTMLInputElement) => box.indeterminate),
  ).toBe(true);
});

test("input writes the state, and keeps the focused control", async ({
  page,
}) => {
  const name = row(page, "Name").locator("input");
  await name.press("End");
  await name.pressSequentially(" L");
  await expect(name).toHaveValue("Ada L");
  await expect(name).toBeFocused();
  await expect.poll(async () => (await state(page)).name).toBe("Ada L");
  await row(page, "Bio").locator("textarea").fill("x");
  await row(page, "Age").locator("input").fill("41");
  await row(page, "Volume").locator("input").fill("7");
  await row(page, "Date").locator("input").fill("2000-01-02");
  await row(page, "Color").locator("input").fill("#000000");
  await expect(row(page, "Volume").locator("output")).toHaveText("7");
  await expect
    .poll(() => state(page))
    .toMatchObject({
      bio: "x",
      age: 41,
      volume: 7,
      date: "2000-01-02",
      color: "#000000",
    });
});

test("choices write the state, and the state moves the other boxes", async ({
  page,
}) => {
  await page.getByLabel("team").check();
  await expect(page.getByLabel("pro", { exact: true })).not.toBeChecked();
  await row(page, "Country").locator("select").selectOption("Peru");
  await row(page, "Languages").locator("select").selectOption(["Rust", "Zig"]);
  await page.getByLabel("Newsletter").uncheck();
  await expect
    .poll(() => state(page))
    .toMatchObject({
      plan: "team",
      country: "Peru",
      languages: ["Rust", "Zig"],
      newsletter: false,
    });
  const all = page.getByLabel("all", { exact: true });
  await all.check();
  await expect(page.getByLabel("beta")).toBeChecked();
  await expect(page.getByLabel("dark mode")).toBeChecked();
  expect(await all.evaluate((box: HTMLInputElement) => box.indeterminate)).toBe(
    false,
  );
  await page.getByLabel("beta").uncheck();
  await expect(all).not.toBeChecked();
  await expect
    .poll(() => all.evaluate((box: HTMLInputElement) => box.indeterminate))
    .toBe(true);
  expect((await state(page)).features).toEqual(["dark mode", "sync"]);
});

test("a write to the state sets each control", async ({ page }) => {
  await row(page, "Name").locator("input").fill("x");
  await page.getByRole("button", { name: "Randomize" }).click();
  await expect.poll(async () => (await state(page)).name).not.toBe("x");
  await expect.poll(() => controls(page)).toEqual(await state(page));
  await page.getByRole("button", { name: "Reset" }).click();
  await expect.poll(async () => (await state(page)).name).toBe("Ada");
  await expect.poll(() => controls(page)).toEqual(await state(page));
});

test("a web component takes the languages as a property, and its custom event writes the state", async ({
  page,
}) => {
  const chips = page.locator("chip-list button");
  await expect(chips).toHaveText(["TypeScript"]);
  await row(page, "Languages")
    .locator("select")
    .selectOption(["TypeScript", "Go"]);
  await expect(chips).toHaveText(["TypeScript", "Go"]);
  await chips.first().click();
  await expect(chips).toHaveText(["Go"]);
  expect((await state(page)).languages).toEqual(["Go"]);
});
