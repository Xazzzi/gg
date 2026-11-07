import type { View } from "../state.ts";

// An async iterable of strings is a text child, so the runtime changes one Text node.
export async function* Status({ view }: { view: View }) {
  for await (const { saved } of view) yield saved ? "Saved" : "Saving…";
}
