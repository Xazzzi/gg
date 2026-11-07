// Stryker needs one failure, so exit at the first one and skip the rest of the suite.
// biome-ignore lint/correctness/useYield: Node needs a generator, and this reporter prints nothing
export default async function* (source: AsyncIterable<any>) {
  for await (const event of source)
    if (event.type === "test:fail") process.exit(1);
}
