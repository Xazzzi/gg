// Internal devtools hook. Not exported from the package, spec/devtools.md defines the contract.
export const HOOK = Symbol.for("gg.devtools");

export type Emit = (event: string, ...args: unknown[]) => void;

let owner: object | undefined, pulled: unknown;

/** Runs pull, so readers and consumers that it opens name `source` (DV-052). */
export const pulling = <R>(source: unknown, pull: () => R): R => {
  const outer = pulled;
  pulled = source;
  try {
    return pull();
  } finally {
    pulled = outer;
  }
};
/** Gives the slot source that a select pulls now, or undefined. */
export const pulledSource = () => pulled;

type Returnable = { return(value?: any): unknown };
// The consumers and readers that code opened while a drive pulled a source, which end when the host lets the source go (JX-041).
const opened = new WeakMap<object, Set<Returnable>>();
/** Binds a consumer or a reader to the source that a drive pulls now, if any, and gives the set that it leaves when it ends. */
export const bindPulled = (consumer: Returnable) => {
  if (Object(pulled) !== pulled) return;
  let set = opened.get(pulled as object);
  if (!set) opened.set(pulled as object, (set = new Set()));
  return set.add(consumer);
};
/** Returns the consumers and readers bound to a source, once. */
export const release = (source: unknown) => {
  const set = opened.get(source as object);
  if (!set) return;
  // Stryker disable next-line CallExpression: a second return() of a consumer or a reader changes nothing
  opened.delete(source as object);
  for (const consumer of set) void consumer.return();
};

/** Runs make, so registrations inside name `by` as their owner (DV-005). */
export const owned = <R>(by: object, make: () => R): R => {
  const outer = owner;
  owner = by;
  try {
    return make();
  } finally {
    owner = outer;
  }
};

/** Tells the devtools hook about a new object, and gives its event emitter if the hook returns one. A detail can name its own owner. */
export const register = (
  kind: string,
  target: object,
  detail: object,
): Emit | undefined => {
  const hook = (globalThis as any)[HOOK];
  return typeof hook === "function"
    ? hook(kind, target, { owner, ...detail })
    : undefined;
};
