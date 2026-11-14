import { test as base, expect } from "@playwright/test";

export { expect };
export const SVG = "http://www.w3.org/2000/svg";

// Fails a test for an uncaught error or a console error of the page, which reportError makes too.
export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(`${error}`));
      page.on("console", message => {
        // The bench page links a stylesheet of js-framework-benchmark, which the repo does not hold.
        if (message.type() === "error" && !message.text().includes("404"))
          errors.push(message.text());
      });
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
