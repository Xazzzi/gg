import { defineConfig } from "@playwright/test";

// Real DOM checks of the examples, in the Chrome of the system, so no browser download is needed.
export default defineConfig({
  testDir: "browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:5173/examples/", channel: "chrome" },
  // Reuses a server that already runs on the port, because the user can serve the examples.
  webServer: {
    command: "npm run serve:examples -- --log-level=warning",
    url: "http://localhost:5173/examples/todomvc/",
    reuseExistingServer: true,
  },
});
