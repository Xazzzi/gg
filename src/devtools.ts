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
