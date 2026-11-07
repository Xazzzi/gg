import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as root from "../src/index.ts";

test("Package exports the root exports the public names", () => {
  assert.deepEqual(Object.keys(root).sort(), [
    "CHAN",
    "Channel",
    "Fragment",
    "StopError",
    "abortable",
    "applyOps",
    "catching",
    "changes",
    "each",
    "feed",
    "isVal",
    "jsx",
    "jsxDEV",
    "jsxs",
    "mount",
    "select",
    "spread",
  ]);
});

test("Package exports set sideEffects false, with the root and the JSX runtime as entries", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(Object.keys(manifest.exports), [
    ".",
    "./jsx-runtime",
    "./jsx-dev-runtime",
  ]);
  assert.deepEqual(
    manifest.exports["./jsx-runtime"],
    manifest.exports["./jsx-dev-runtime"],
  );
});

test("JSX runtime exports its public names, which the root exports too", async () => {
  const runtime = await import("../src/jsx.ts");
  assert.deepEqual(Object.keys(runtime).sort(), [
    "Fragment",
    "each",
    "jsx",
    "jsxDEV",
    "jsxs",
    "mount",
  ]);
  const roots = new Map(Object.entries(root));
  for (const [name, value] of Object.entries(runtime))
    assert.equal(roots.get(name), value);
});
