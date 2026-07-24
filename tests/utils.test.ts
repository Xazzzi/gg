import * as assert from "node:assert";
import { inspect } from "node:util";

export function assertStatus(
  p: Promise<unknown>,
  status: "pending" | "resolved" | "rejected",
) {
  const str = inspect(p);
  const actual = str.includes("<pending>")
    ? "pending"
    : str.includes("<rejected>")
      ? "rejected"
      : "resolved";

  assert.strictEqual(actual, status, "Promise status mismatch");
}
