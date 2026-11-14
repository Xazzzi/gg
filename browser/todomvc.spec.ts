import type { Page } from "@playwright/test";
import { expect, test } from "./page.ts";

const add = async (page: Page, ...titles: string[]) => {
  for (const title of titles) {
    await page.locator(".new-todo").fill(title);
    await page.locator(".new-todo").press("Enter");
  }
};
const rows = (page: Page) => page.locator(".todo-list li");
const labels = (page: Page) => page.locator(".todo-list li label");

test.beforeEach(async ({ page }) => {
  await page.goto("todomvc/");
});

test("an empty list hides main and footer, and focuses the input", async ({
  page,
}) => {
  await expect(page.locator(".new-todo")).toBeFocused();
  await expect(page.locator(".main")).toBeHidden();
  await expect(page.locator(".footer")).toBeHidden();
  await expect(page.locator(".main")).toHaveAttribute("hidden", "");
});

test("add renders rows in order, and counts them", async ({ page }) => {
  await add(page, "a", "b", "c");
  await expect(labels(page)).toHaveText(["a", "b", "c"]);
  await expect(page.locator(".new-todo")).toHaveValue("");
  await expect(page.locator(".todo-count")).toHaveText("3 items left");
  await expect(page.locator(".footer")).toBeVisible();
  // A dynamic prop that gives false removes the attribute (JX-063).
  expect(await page.locator(".main").getAttribute("hidden")).toBeNull();
});

test("toggle completes a row, and toggle-all follows the rows", async ({
  page,
}) => {
  await add(page, "a", "b");
  await rows(page).nth(0).locator(".toggle").check();
  await expect(rows(page).nth(0)).toHaveClass("completed");
  await expect(page.locator(".todo-count")).toHaveText("1 item left");
  await expect(page.locator(".clear-completed")).toBeVisible();
  await expect(page.locator("#toggle-all")).not.toBeChecked();
  await rows(page).nth(1).locator(".toggle").check();
  // checked is a live property, so the box follows with no attribute.
  await expect(page.locator("#toggle-all")).toBeChecked();
  expect(await page.locator("#toggle-all").getAttribute("checked")).toBeNull();
  await page.locator("#toggle-all").dispatchEvent("click");
  await expect(rows(page).locator(".toggle:checked")).toHaveCount(0);
  await expect(page.locator(".clear-completed")).toBeHidden();
});

test("a filter sets the class of the list, and marks its link", async ({
  page,
}) => {
  await add(page, "a", "b");
  await rows(page).nth(0).locator(".toggle").check();
  await page.locator(".filters a", { hasText: "Active" }).click();
  await expect(page.locator(".todo-list")).toHaveClass(
    "todo-list filter-active",
  );
  await expect(page.locator(".filters a.selected")).toHaveText("Active");
  await expect(rows(page).nth(0)).toBeHidden();
  await expect(rows(page).nth(1)).toBeVisible();
  await page.locator(".filters a", { hasText: "Completed" }).click();
  await expect(rows(page).nth(0)).toBeVisible();
  await expect(rows(page).nth(1)).toBeHidden();
  await page.locator(".filters a", { hasText: "All" }).click();
  await expect(page.locator(".filters a.selected")).toHaveText("All");
  // A dynamic prop that gives null removes the attribute.
  expect(
    await page
      .locator(".filters a", { hasText: "Active" })
      .getAttribute("class"),
  ).toBeNull();
});

test("edit saves on Enter, discards on Escape, and removes an empty title", async ({
  page,
}) => {
  await add(page, "a", "b");
  const first = rows(page).nth(0);
  await first.locator("label").dblclick();
  await expect(first).toHaveClass("editing");
  await expect(first.locator(".edit")).toBeFocused();
  await first.locator(".edit").fill("A");
  await first.locator(".edit").press("Enter");
  await expect(labels(page)).toHaveText(["A", "b"]);
  await first.locator("label").dblclick();
  await first.locator(".edit").fill("x");
  await first.locator(".edit").press("Escape");
  await expect(labels(page)).toHaveText(["A", "b"]);
  await first.locator("label").dblclick();
  await first.locator(".edit").fill("");
  await first.locator(".edit").press("Enter");
  await expect(labels(page)).toHaveText(["b"]);
});

test("a removal keeps the nodes of the other rows", async ({ page }) => {
  await add(page, "a", "b", "c");
  // A property on the node shows that the row is the same node later.
  await rows(page).evaluateAll(list =>
    list.forEach((li, i) => {
      (li as any).mark = i;
    }),
  );
  await rows(page).nth(0).hover();
  await rows(page).nth(0).locator(".destroy").click();
  await expect(labels(page)).toHaveText(["b", "c"]);
  expect(
    await rows(page).evaluateAll(list => list.map(li => (li as any).mark)),
  ).toEqual([1, 2]);
  await rows(page).nth(0).locator(".toggle").check();
  await page.locator(".clear-completed").click();
  await expect(labels(page)).toHaveText(["c"]);
  expect(
    await rows(page).evaluateAll(list => list.map(li => (li as any).mark)),
  ).toEqual([2]);
});

test("the list saves, and a reload restores it", async ({ page }) => {
  await add(page, "a", "b");
  await rows(page).nth(1).locator(".toggle").check();
  await expect(page.locator(".saved")).toHaveText("Saving…");
  await expect(page.locator(".saved")).toHaveText("Saved");
  await page.reload();
  await expect(labels(page)).toHaveText(["a", "b"]);
  await expect(rows(page).nth(1)).toHaveClass("completed");
  await expect(rows(page).nth(1).locator(".toggle")).toBeChecked();
});
