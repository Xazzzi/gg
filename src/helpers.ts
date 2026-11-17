import { type Emit, pulling, register } from "./devtools.ts";
import type { Source } from "./feed.ts";
import {
  type Keys,
  type Op,
  type Reads,
  type Entry as SlotOutput,
  type Val,
  watch,
} from "./select.ts";
import {
  building,
  checkOptions,
  detectStream,
  noop,
  open,
  PROMISE,
  quiet,
  quietReturn,
  relocate,
  replace,
  SHARE,
  VAL,
} from "./source.ts";

export interface Caught<T> extends AsyncIterableIterator<T, unknown, void> {
  return(value?: unknown): Promise<IteratorResult<T, unknown>>;
}

/** Gives a finished iterator result with value. */
const end = (value?: unknown): IteratorResult<any, unknown> => ({
  done: true,
  value,
});

/**
 * Reads a source as an async iterator that hands its failure to onError and then finishes.
 * HE-018 and HE-01A rule out a plain async generator here. */
export function catching<T>(
  source: Source<T>,
  onError: (error: unknown) => void | PromiseLike<void>,
): Caught<T> {
  const detected = detectStream(source);
  if (!detected)
    throw new TypeError("catching source is not a promise or iterator");
  if (typeof onError !== "function")
    throw new TypeError("catching requires onError");
  quiet(source);
  const pending: PromiseWithResolvers<IteratorResult<T, unknown>>[] = [];
  let iterator: any,
    next: any,
    finished = false;

  /** Reads one result from the source, and settles its value or catches its failure. */
  const step = async () => {
    if (finished) return end();
    let answered: any, done: any;
    try {
      if (!iterator) [iterator, next] = open(source, detected);
      const result = await next.call(iterator);
      if (Object(result) !== result)
        throw new TypeError("Iterator result is not an object");
      done = !!result.done;
      const { value } = result; // A throwing getter stays a failure with no return()
      answered = true;
      const settled = await value;
      finished ||= done;
      return { done, value: settled };
    } catch (error) {
      if (finished) return end(); // return() arrived first, so the late failure is discarded
      finished = true;
      if (answered && !done) void quietReturn(iterator);
      await onError(error);
      return end();
    }
  };

  /** Serves the queued `next()` calls one at a time, in order. */
  const pump = () => {
    const request = pending[0];
    // After return() empties pending, this shift can drop a later request and start a second step.
    // Each step returns done at once after the finish, so the order and the results stay the same.
    step()
      .then(request.resolve, request.reject)
      .then(() => {
        pending.shift();
        if (pending.length) pump();
      });
  };

  return {
    next() {
      const request = Promise.withResolvers<IteratorResult<T, unknown>>();
      if (pending.push(request) === 1) pump();
      return request.promise;
    },
    async return(value) {
      if (finished) return end(value);
      finished = true;
      for (const request of pending.splice(0)) request.resolve(end());
      const inner =
        iterator ?? (detected.kind !== PROMISE ? (source as any) : undefined);
      return typeof inner?.return === "function"
        ? inner.return(value)
        : end(value);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

export interface Derived<T>
  extends AsyncIterableIterator<T, void, void>,
    AsyncDisposable {
  return(): Promise<IteratorResult<T, void>>;
}

/** Calls each stop function of a list. */
const drop = (stops: (() => void)[]) => {
  for (const stop of stops) stop();
};

// A result of a hub: a value, the end of its source, or the failure of its source.
type Result = { value?: unknown; done?: true; failed?: true; error?: unknown };
type Hub = { subscribe(take: (result: Result) => void): () => void };

// One reader of a hub, with its subscribers and its newest result.
type Run = {
  takers: Set<(result: Result) => void>;
  iterator: AsyncIterator<unknown>;
  newest?: Result;
};

/** Gives a result to the subscribers of a run, and keeps it for later ones. */
const send = (run: Run, result: Result) => {
  run.newest = result;
  for (const take of [...run.takers]) take(result);
};

/**
 * Makes one reader of open for all subscribers, which opens at the first subscriber and returns after the last (HE-05A).
 * A new subscriber gets the newest result at once, and starts a new run after the last one finished or returned. */
const hub = (open: () => AsyncIterator<unknown>): Hub => {
  let current: Run | undefined;
  /**
   * Reads the source of a run until it finishes, fails or returns.
   * The loop ends by the iterator protocol, and a run that its subscribers left sends to none. */
  const pump = async (run: Run) => {
    let result: Result = { done: true };
    try {
      for await (const value of { [Symbol.asyncIterator]: () => run.iterator })
        send(run, { value });
    } catch (error) {
      result = { failed: true, error };
    }
    send(run, result);
    // A slot that leaves can come back, so a later subscriber reads it alone.
    if (current === run) current = undefined;
  };
  /** Opens a new run outside the pull that asks for it, and makes it current (HE-05A). */
  const start = () =>
    pulling(undefined, () => {
      const run: Run = (current = { takers: new Set(), iterator: open() });
      void pump(run);
      return run;
    });
  return {
    subscribe(take) {
      const run = current ?? start();
      run.takers.add(take);
      if (run.newest) take(run.newest);
      return () => {
        if (!run.takers.delete(take) || run.takers.size) return;
        // A subscriber of a finished run can leave after a new run started.
        if (current === run) current = undefined;
        void quietReturn(run.iterator);
      };
    },
  };
};

// The hubs of object slots by state and key, and of shared sources (HE-05A).
const slotHubs = new WeakMap<object, Map<PropertyKey, Hub>>(),
  sourceHubs = new WeakMap<object, Hub>();
/** Gives the hub of one slot of an object select, or of a shared source, or undefined for any other source. */
const hubOf = (source: any, keyed: boolean, key: unknown) => {
  if (keyed) {
    // An array slot moves, so a later derive of an index can name another slot.
    if (Array.isArray(source)) return undefined;
    let byKey = slotHubs.get(source);
    if (!byKey) slotHubs.set(source, (byKey = new Map()));
    // A number key names the slot of its string.
    const name = typeof key === "number" ? `${key}` : (key as PropertyKey);
    let made = byKey.get(name);
    if (!made) byKey.set(name, (made = hub(() => watch(source, name))));
    return made;
  }
  if (!source[SHARE]) return undefined;
  let made = sourceHubs.get(source);
  if (!made)
    sourceHubs.set(source, (made = hub(() => source[Symbol.asyncIterator]())));
  return made;
};

/** Reads a hub as an async iterator of its newest value, as a reader of a watch or of an item reads. */
const reading = (from: Hub): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator](): any {
    let held: Result | undefined, // The newest value that next() did not give
      end: Result | undefined,
      wake: (() => void) | undefined,
      off: (() => void) | undefined;
    const take = (result: Result) => {
      if (result.done || result.failed) end = result;
      else held = result;
      wake?.();
    };
    return {
      async next(): Promise<IteratorResult<unknown>> {
        off ??= from.subscribe(take);
        while (!held && !end)
          await new Promise<void>(resolve => (wake = resolve));
        wake = undefined;
        if (held) {
          const { value } = held;
          held = undefined;
          return { done: false, value };
        }
        if ((end as Result).failed) throw (end as Result).error;
        return { done: true, value: undefined };
      },
      // mapped opens this iterator only to call next(), so off exists here, and it uses no result of return().
      return() {
        (off as () => void)();
      },
    };
  },
});

/** Maps each output of one slot of a select, from `watch`, so the map runs only when that slot changes (HE-054). */
export function derive<O, K extends Keys<O>, R>(
  state: Reads<O>,
  key: K,
  map: (value: SlotOutput<O, K>) => R,
): Derived<Awaited<R>>;
/** Maps each value of an async iterable, so a dynamic prop or child follows a derived value. */
export function derive<T, R>(
  source: AsyncIterable<T>,
  map: (value: T) => R,
): Derived<Awaited<R>>;
export function derive(
  source: any,
  keyOrMap: unknown,
  mapper?: (value: unknown) => unknown,
): Derived<unknown> {
  const keyed = typeof keyOrMap !== "function",
    map = keyed ? mapper : (keyOrMap as (value: unknown) => unknown);
  if (typeof source?.[Symbol.asyncIterator] !== "function")
    throw new TypeError("derive source is not an async iterable");
  if (typeof map !== "function")
    throw new TypeError("derive map must be a function");
  // SE-160 checks the state and the key, and the watch opens only for a slot that no hub shares.
  const checked = keyed ? watch(source, keyOrMap as PropertyKey) : source,
    shared = hubOf(source, keyed, keyOrMap);
  const from = shared ? reading(shared) : checked,
    box: { emit?: Emit } = {},
    derived = mapped(from, map, box, undefined, shared);
  box.emit = register("derive", derived, { source: from, map }); // Here, so the hook finds the caller at its fixed depth (DV-003)
  return derived;
}

/** Gives `then` while the values of source are truthy and `otherwise` while they are not, and calls a function branch at each change to its side (HE-060). */
export function iff<A, B = undefined>(
  source: AsyncIterable<unknown>,
  then: A | (() => A),
  otherwise?: B | (() => B),
): Derived<Awaited<A | B>> {
  if (typeof source?.[Symbol.asyncIterator] !== "function")
    throw new TypeError("iff source is not an async iterable");
  let off: boolean | undefined; // The falsiness of the last value
  const map = (value: unknown) => {
      const branch = value ? then : otherwise;
      return typeof branch === "function"
        ? (branch as () => unknown)()
        : branch;
    },
    box: { emit?: Emit } = {},
    derived = mapped(source, map, box, value => off !== (off = !value));
  box.emit = register("derive", derived, { source, map }); // DV-003
  return derived as Derived<Awaited<A | B>>;
}

/**
 * Maps each value of source that pass takes, as an iterator whose `return()` acts at once.
 * HE-053 and HE-055 rule out a plain async generator here, as for catching. */
const mapped = (
  source: AsyncIterable<unknown>,
  map: (value: unknown) => unknown,
  box: { emit?: Emit },
  pass?: (value: unknown) => boolean,
  shared?: Hub,
): Derived<unknown> => {
  const pending: PromiseWithResolvers<IteratorResult<unknown, void>>[] = [];
  let iterator: any,
    started = false,
    finished = false,
    last: unknown,
    made: (() => void)[] = []; // What stops the elements that map built for the last output (HE-059)

  const over = () => end() as IteratorReturnResult<void>;

  /** Ends the derive, and tells devtools if it had started (DV-062). */
  const finish = () => {
    finished = true;
    if (started) box.emit?.("end");
  };

  /** Reads one value from the source and maps it, and opens the source at the first call (HE-051). */
  const step = async (): Promise<IteratorResult<unknown, void>> => {
    if (finished) return over();
    let mapping = false,
      fresh: (() => void)[] = []; // What the call for this value built
    try {
      if (!started) {
        started = true;
        box.emit?.("start");
        iterator = source[Symbol.asyncIterator]();
      }
      let result: IteratorResult<unknown>;
      do {
        result = await iterator.next();
        if (finished) return over(); // return() arrived first, so map does not run
        if (result.done) {
          finish();
          return over();
        }
      } while (pass && !pass(result.value));
      mapping = true;
      let output: unknown;
      [output, fresh] = building(() => map(result.value));
      const settled = await output;
      // A repeat of the last output keeps its elements, and a discarded output keeps none.
      if (finished || Object.is(settled, last)) drop(fresh);
      else {
        drop(made);
        made = fresh;
      }
      if (finished) return over();
      last = settled;
      box.emit?.("value", settled); // DV-061
      return { done: false, value: settled };
    } catch (error) {
      drop(fresh); // A map that rejects gives no output to own them (HE-059)
      if (finished) return over(); // return() arrived first, so the late failure is discarded
      finish();
      if (mapping) void quietReturn(iterator); // HE-057
      throw error;
    }
  };

  /** Serves the queued `next()` calls one at a time, in order. */
  const pump = () => {
    const request = pending[0];
    // After return() empties pending, this shift can drop a later request and start a second step.
    // Each step returns done at once after the finish, so the order and the results stay the same.
    step()
      .then(request.resolve, request.reject)
      .then(() => {
        pending.shift();
        if (pending.length) pump();
      });
  };

  const derived: Derived<unknown> = {
    next() {
      const request = Promise.withResolvers<IteratorResult<unknown, void>>();
      if (pending.push(request) === 1) pump();
      return request.promise;
    },
    async return() {
      if (!finished) {
        finish();
        drop(made);
        for (const request of pending.splice(0)) request.resolve(over());
        if (typeof iterator?.return === "function") await iterator.return();
      }
      return over();
    },
    async [Symbol.asyncDispose]() {
      await derived.return();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  if (shared)
    (derived as any)[BIND] = (sink: Sink, parked: boolean): Bound => {
      started = true;
      box.emit?.("start");
      let held: Result | undefined, // The newest value while parked
        turn = 0,
        off = noop;
      /**
       * Maps a value and gives the output to the sink, unless a later value or a stop came first.
       * A prop shows no node, so a binding owns nothing that map builds (JX-067). */
      const apply = async (value: unknown) => {
        // Stryker disable next-line UpdateOperator: turns only need to differ
        const mine = ++turn;
        try {
          const settled = await map(value);
          if (finished || mine !== turn) return;
          box.emit?.("value", settled); // DV-061
          sink.value(settled);
        } catch (error) {
          if (finished || mine !== turn) return;
          finish();
          off();
          sink.fail(error);
        }
      };
      const take = (result: Result) => {
        if (finished) return;
        if (result.failed) {
          finish();
          sink.fail(result.error);
        } else if (result.done)
          finish(); // The prop keeps its last output (JX-066), and the binding stays until its scope stops
        else if (parked) held = result;
        else void apply(result.value);
      };
      off = shared.subscribe(take);
      return {
        park(on) {
          parked = on;
          if (on || !held) return;
          const { value } = held;
          held = undefined;
          void apply(value);
        },
        stop() {
          if (finished) return;
          finish();
          off();
        },
      };
    };
  return derived;
};

// What binds a derive with a shared source to a host, which then gives its outputs to sink with no drive (JX-067).
export const BIND: unique symbol = Symbol() as any;
type Sink = {
  value(output: unknown): void;
  fail(error: unknown): void;
};
type Bound = { park(on: boolean): void; stop(): void };

/** Tells if a value is a `Val` that select made. */
export function isVal(value: unknown): value is Val<unknown> {
  return Object(value) === value && Object.hasOwn(value as object, VAL);
}

type ValKeys<S> = {
  [K in keyof S]-?: K extends string
    ? S[K] extends Val<any>
      ? K
      : never
    : never;
}[keyof S];

type Vals<V> = Extract<V, Val<any>>;
type Plain<V> = Exclude<V, Val<any>>;
type Fulfilled<V> = V extends { status: "fulfilled"; value: infer Y }
  ? Y
  : never;
type ValueOf<V> = Fulfilled<Vals<V>> | undefined;

type SpreadItem<V> =
  | Plain<V>
  | ([Vals<V>] extends [never]
      ? never
      : { value: ValueOf<V>; loading: boolean; error: unknown; done: boolean });

type SpreadField<V> =
  | Plain<V>
  | ([Vals<V>] extends [never] ? never : ValueOf<V>);

export type Spread<S> = S extends readonly unknown[]
  ? { [K in keyof S]: SpreadItem<S[K]> }
  : { [K in keyof S]: SpreadField<S[K]> } & {
      [K in ValKeys<S> as `${K}Loading`]: boolean;
    } & { [K in ValKeys<S> as `${K}Error`]: unknown } & {
      [K in ValKeys<S> as `${K}Done`]: boolean;
    };

/** Caches the spread fields of each `Val`, so a spread array keeps item identity. */
const fields = new WeakMap<object, object>();

/** Gives the rejection reason of a `Val`, or null. */
const errorOf = (val: Val<unknown>) =>
  val.status === "rejected" ? val.reason : null;

/** Gives the frozen `{ value, loading, error, done }` of a `Val`. */
const fieldsOf = (val: Val<unknown>) => {
  let entry = fields.get(val);
  if (!entry) {
    entry = Object.freeze({
      value: val.value,
      loading: val.status === "pending",
      error: errorOf(val),
      done: val.done,
    });
    fields.set(val, entry);
  }
  return entry;
};

/** Flattens the `Val` entries of a snapshot into plain values and `Loading`, `Error` and `Done` fields. */
export function spread<S>(snapshot: S): Spread<S> {
  if (typeof snapshot !== "object" || snapshot === null)
    return snapshot as Spread<S>;
  if (Array.isArray(snapshot))
    return snapshot.map(item => (isVal(item) ? fieldsOf(item) : item)) as any;
  const out: any = { ...snapshot };
  for (const [key, val] of Object.entries(snapshot as object)) {
    if (!isVal(val)) continue;
    const names = [`${key}Loading`, `${key}Error`, `${key}Done`] as const;
    for (const name of names)
      if (Object.hasOwn(snapshot as object, name))
        throw new TypeError(`spread field ${name} collides`);
    out[key] = val.value;
    out[names[0]] = val.status === "pending";
    out[names[1]] = errorOf(val);
    out[names[2]] = val.done;
  }
  return out;
}

type MirrorEntry<T> = T extends readonly (infer V)[] ? V : T[keyof T];

/** The default map of applyOps, which keeps the value. */
const same = (value: unknown) => value;
/** Reads an own property, and ignores inherited ones. */
const own = (target: any, key: PropertyKey) =>
  Object.hasOwn(target, key) ? target[key] : undefined;

/** Sets a property, and defines `__proto__` as data so it never sets the prototype. */
const store = (target: any, key: PropertyKey, value: unknown) => {
  if (key === "__proto__")
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  else target[key] = value;
};

// A cell of an array fold: an entry from before the call, or a fresh value that landed.
// A fresh cell links to the cell that it updates, and an entry that leaves keeps the output it had (HE-04H).
type Cell = {
  entry?: unknown;
  value?: unknown;
  link?: Cell;
  spot?: Cell; // The cell at the index where a fresh value landed, which it takes over when nothing matches it
  fresh?: boolean;
  taken?: boolean;
  changed?: boolean; // An update changed the output of the entry before it left
};
type Match = (output: unknown) => unknown;

const MINUS_ZERO = Symbol();
/** Gives a Map key that tells -0 from 0, as `Object.is` does. */
// Stryker disable next-line UnaryOperator: a symbol key for 0 instead of -0 tells them apart too
const keyOf = (value: unknown) => (Object.is(value, -0) ? MINUS_ZERO : value);
/**
 * Tells if a key is a valid array index.
 * A symbol throws a TypeError here, as HE-04F needs. */
const isIndex = (key: any) => key >>> 0 === key && key !== 2 ** 32 - 1;

/** Throws a `TypeError` for an operation that the target kind cannot replay. */
const checkFit = (op: Op, array: boolean) => {
  const fits = array
    ? op.op === "splice" ||
      op.op === "move" ||
      (op.op === "set" && isIndex(op.key))
    : op.op === "set" || op.op === "delete";
  if (!fits)
    throw new TypeError(`applyOps cannot replay ${op.op} on this target`);
};

/**
 * Checks that each operation fits an array, and counts the entries at its start and at its end that none touches.
 * A move touches every entry, and a set past the end grows the array. */
export const untouched = (ops: readonly Op[], size: number) => {
  let head = size,
    tail = size;
  for (const op of ops) {
    checkFit(op, true);
    const [start, count] =
      op.op === "set"
        ? [op.key as number, 1]
        : op.op === "splice"
          ? [op.start, op.removed.length]
          : [0, size];
    size = Math.max(size, start + count);
    head = Math.min(head, start);
    tail = Math.min(tail, size - start - count);
    if (op.op === "splice") size += op.added.length - count;
  }
  return [head, tail] as const;
};

/** Tells if a set updates what its index holds: a slot that stays, the same output, or the same key (HE-04H). */
const updates = (op: Extract<Op, { op: "set" }>, match?: Match) =>
  !!op.kept ||
  Object.is(op.value, op.prev) ||
  (!!match && Object.is(match(op.value), match(op.prev)));

/**
 * Replays ops onto cells, and gives the entries that left, in leaving order.
 * cell gives the cell at an index, which a fold of sets makes when it first needs it. */
const play = (
  cells: (Cell | undefined)[],
  ops: readonly Op[],
  cell: (at: number) => Cell | undefined,
  head: number,
  match?: Match,
) => {
  const left: Cell[] = [];
  /** Gives the entry that a leaving cell holds or updates the output it had, and a fresh cell with no link has none. */
  const leave = (at: Cell | undefined, value: unknown) => {
    const changed = !!at?.fresh;
    while (at?.fresh) at = at.link;
    if (at) {
      at.value = value;
      at.changed = changed;
      left.push(at);
    }
  };
  for (const op of ops) {
    if (op.op === "set") {
      const at = (op.key as number) - head,
        old = cell(at),
        update = updates(op, match);
      leave(old, op.prev); // An update claims its entry first, so no value matches it (HE-04H)
      cells[at] = update
        ? { fresh: true, value: op.value, link: old }
        : { fresh: true, value: op.value, spot: old };
    } else if (op.op === "move")
      relocate(cells, op.order); // A move leaves no entry untouched, so cells hold the whole target
    else {
      const { start, removed, added } = op as Extract<Op, { op: "splice" }>,
        at = start - head,
        gone = cells.slice(at, at + removed.length);
      gone.forEach((cell, index) => {
        leave(cell, removed[index]);
      });
      replace(
        cells,
        at,
        removed.length,
        added.map((value, index) => ({
          fresh: true,
          value,
          spot: gone[index],
        })),
      );
    }
  }
  return left;
};

/**
 * Gives the entry of each final cell, in index order (HE-04B, HE-04H).
 * An update takes the entry that it updates, then each other value takes the first leaving entry with its match. */
const settle = (
  finals: (Cell | undefined)[],
  left: Cell[],
  map: any,
  match?: Match,
  eager = false,
) => {
  const from: (Cell | undefined)[] = [],
    pending: number[] = [],
    byMatch = new Map<unknown, Cell[]>();
  finals.forEach((cell, i) => {
    if (!cell?.fresh) return;
    let root = cell.link;
    while (root?.fresh) root = root.link;
    if (!root) {
      pending.push(i);
      return;
    }
    root.taken = true;
    from[i] = root;
  });
  const matchOf = (value: unknown) => keyOf(match ? match(value) : value);
  for (const cell of left) {
    const key = matchOf(cell.value);
    byMatch.get(key)?.push(cell) ?? byMatch.set(key, [cell]);
  }
  const unmatched: number[] = [];
  for (const i of pending) {
    const list = byMatch.get(matchOf((finals[i] as Cell).value));
    for (let cell: Cell | undefined; (cell = list?.shift()); )
      if (!cell.taken) {
        cell.taken = true;
        from[i] = cell;
        break;
      }
    if (!from[i]) unmatched.push(i);
  }
  // Without key, a value that matches nothing takes over the entry that left its index, if no value took it.
  if (!match)
    for (const i of unmatched) {
      let spot = (finals[i] as Cell).spot;
      while (spot?.fresh) spot = spot.link ?? spot.spot;
      // Each cell lands at most once on another, so no two values share a spot.
      if (spot && !spot.taken) from[i] = spot;
    }
  // A hole in the cells reads as an undefined entry (HE-04G).
  return Array.from(finals, (cell, i) => {
    if (!cell?.fresh) return cell?.entry;
    const prev = from[i];
    return !eager &&
      prev &&
      !cell.link &&
      !prev.changed &&
      Object.is(prev.value, cell.value)
      ? prev.entry
      : map(cell.value, prev?.entry);
  });
};

/** Folds ops that are all sets, and reads only the indexes that they name (HE-04I). */
const foldSets = (
  target: any[],
  ops: readonly Op[],
  map: any,
  match?: Match,
) => {
  const cells: (Cell | undefined)[] = [];
  for (const op of ops) checkFit(op, true);
  const left = play(
    cells,
    ops,
    at =>
      cells[at] ??
      (at < target.length ? (cells[at] = { entry: target[at] }) : undefined),
    0,
    match,
  );
  const named = Object.keys(cells).map(Number),
    items = settle(
      named.map(at => cells[at]),
      left,
      map,
      match,
    );
  named.forEach((index, i) => {
    if (index >= target.length || !Object.is(target[index], items[i]))
      target[index] = items[i];
  });
  return target;
};

/**
 * Replays ops onto cells first, so each value that lands takes over a leaving entry (HE-04H).
 * Then maps each value that reuses no entry one time. */
const foldArray = (
  target: any[],
  ops: readonly Op[],
  map: any,
  match?: Match,
) => {
  // Only the entries between the untouched ones get a cell, so a short change of a long array stays short.
  const [head, tail] = untouched(ops, target.length),
    was = target.length - head - tail,
    cells: (Cell | undefined)[] = target
      .slice(head, head + was)
      .map(entry => ({ entry }));
  const left = play(cells, ops, at => cells[at], head, match),
    items = settle(cells, left, map, match);
  const common = Math.min(was, items.length);
  for (let i = 0; i < common; i++)
    if (!Object.is(target[head + i], items[i])) target[head + i] = items[i];
  if (was !== items.length)
    replace(target, head + common, was - common, items.slice(common));
  return target;
};

/** Replays ops onto an object, maps each key that ends set one time, and keeps the final key order. */
const foldObject = (target: any, ops: readonly Op[], map: any) => {
  const sets = new Map<PropertyKey, { value: unknown; prev: unknown }>(),
    gone = new Set<PropertyKey>();
  for (const op of ops) {
    checkFit(op, false);
    const { key } = op as Extract<Op, { key: unknown }>,
      name = typeof key === "number" ? `${key}` : key;
    if (op.op === "set")
      sets.set(name, { value: op.value, prev: own(target, name) });
    else {
      gone.add(name);
      sets.delete(name);
    }
  }
  // Rebuilds the final key order, which HE-04B needs, with no __proto__ setter.
  const order = Object.create(null);
  for (const key of Reflect.ownKeys(target)) if (!gone.has(key)) order[key] = 0;
  for (const key of sets.keys()) order[key] = 0;
  const entries = Reflect.ownKeys(order)
    .filter(key => sets.has(key))
    .map(key => {
      const { value, prev } = sets.get(key) as {
        value: unknown;
        prev: unknown;
      };
      return [key, map(value, prev)] as const;
    });
  for (const key of gone) delete target[key];
  for (const [key, value] of entries) store(target, key, value);
  return target;
};

/** The options of `applyOps`. */
export type ApplyOptions = {
  eager?: boolean;
  key?: (output: any) => unknown;
};

/** Replays select operations onto a mirror, and derives each entry that lands with map. */
export function applyOps<T extends object>(
  target: T,
  ops: readonly Op[],
  map?: (value: unknown, prev: MirrorEntry<T> | undefined) => MirrorEntry<T>,
  options?: ApplyOptions,
): T;
export function applyOps(
  target: any,
  ops: readonly Op[],
  map: any = same,
  options: ApplyOptions = {},
) {
  if (Object(target) !== target)
    throw new TypeError("applyOps target must be an object");
  if (typeof map !== "function")
    throw new TypeError("applyOps map must be a function");
  checkOptions(options, { eager: "boolean", key: "function" });
  const array = Array.isArray(target),
    match = options.key;
  if (!options.eager)
    return (
      !array
        ? foldObject
        : ops.every(op => op.op === "set")
          ? foldSets
          : foldArray
    )(target, ops, map, match);
  for (const op of ops) {
    checkFit(op, array);
    if (op.op === "set")
      store(
        target,
        op.key,
        map(
          op.value,
          !array || !match || updates(op, match)
            ? own(target, op.key)
            : undefined,
        ),
      );
    else if (op.op === "delete") delete target[op.key];
    else if (op.op === "move") relocate(target, op.order);
    else {
      const { start, removed, added } = op as Extract<Op, { op: "splice" }>,
        gone = removed.map((output, index) => ({
          entry: target[start + index],
          value: output,
        }));
      replace(
        target,
        start,
        removed.length,
        settle(
          added.map((value, index) => ({
            fresh: true,
            value,
            spot: gone[index],
          })),
          gone,
          map,
          match,
          true,
        ),
      );
    }
  }
  return target;
}
