import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as root from "../src/index.ts";

test("Package exports the root exports the public names", () => {
  assert.deepEqual(Object.keys(root).sort(), [
    "CHAN",
    "Channel",
    "StopError",
    "abortable",
    "applyOps",
    "catching",
    "feed",
    "isVal",
    "select",
    "spread",
  ]);
});

test("Package exports set sideEffects false, with the root as the only entry", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
});
