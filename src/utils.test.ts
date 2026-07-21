import * as assert from "node:assert";
import { setTimeout } from "node:timers/promises";

export async function assertStatus(
  p: Promise<unknown>,
  status: "pending" | "resolved" | "rejected",
  afterMs = 10,
) {
  assert.strictEqual(
    await Promise.race([
      p.then(
        () => "resolved",
        () => "rejected",
      ),
      setTimeout(afterMs, "pending"),
    ]),
    status,
    "Promise status mismatch",
  );
}
