import { attached, Channel, type ChannelOptions, failed } from "./channel.ts";
import { pulledSource, pulling, register } from "./devtools.ts";
import {
  checkOptions,
  isThenable,
  noop,
  quiet,
  quietReturn,
  relocate,
  replace,
  thenOf,
  VAL,
} from "./source.ts";

export const CHAN: unique symbol = Symbol.for("gg.CHAN") as any;
declare const OUTPUTS: unique symbol; // Type only, so changes infers the outputs

export type SelectShape = Record<string | symbol, unknown> | readonly unknown[];

export type Val<T> =
  | { status: "pending"; value: undefined; reason: undefined; done: false }
  | { status: "fulfilled"; value: T; reason: undefined; done: boolean }
  | { status: "rejected"; value: undefined; reason: unknown; done: true };

export type Op =
  | { op: "set"; key: string | symbol | number; value: unknown; prev: unknown }
  | { op: "delete"; key: string | symbol; prev: unknown }
  | { op: "splice"; start: number; removed: unknown[]; added: unknown[] }
  | { op: "move"; order: number[] };

export type SelectOptions<S, R> = ChannelOptions & {
  autoStart?: boolean;
  autoClose?: boolean;
  backPressure?: boolean;
  nonYielding?: boolean;
  unwrap?: boolean;
  onChanges?: (ops: Op[]) => void;
  mapSnapshot?: (snapshot: S) => R;
};

type Returned<R> = 0 extends 1 & R
  ? never
  : // biome-ignore lint/suspicious/noConfusingVoidType: a void return has no value to yield
    [R] extends [void]
    ? never
    : Awaited<R>;

type Settled<V> =
  V extends PromiseLike<infer Y>
    ? { y: Awaited<Y> }
    : V extends AsyncIterable<infer Y, infer R>
      ? { y: Awaited<Y> | Returned<R> }
      : V extends AsyncIterator<infer Y, infer R>
        ? { y: Awaited<Y> | Returned<R> }
        : V extends Iterator<infer Y, infer R>
          ? { y: Awaited<Y> | Returned<R> }
          : { plain: V };

type SnapshotOf<S> = S extends { y: infer Y }
  ? Val<Y>
  : S extends { plain: infer P }
    ? P
    : never;
type UnwrappedOf<S> = S extends { y: infer Y }
  ? Y | undefined
  : S extends { plain: infer P }
    ? P
    : never;

export type Snapshot<T> = T extends readonly unknown[]
  ? SnapshotOf<Settled<T[number]>>[]
  : { [K in keyof T]: SnapshotOf<Settled<T[K]>> };
export type Unwrapped<T> = T extends readonly unknown[]
  ? UnwrappedOf<Settled<T[number]>>[]
  : { [K in keyof T]: UnwrappedOf<Settled<T[K]>> };

// Extends V[], so a state stays assignable to V[], and reverse overloads to keep sortOutputs.
type SelectArray<V, O> = {
  sortOutputs(
    compare?: (a: Exclude<O, undefined>, b: Exclude<O, undefined>) => number,
  ): SelectArray<V, O>;
  reverse(): SelectArray<V, O>;
} & V[];

type Mutable<T, O> = T extends readonly unknown[]
  ? SelectArray<T[number], O extends readonly (infer E)[] ? E : never>
  : T;

export type State<T, R, O = Snapshot<T>> = Mutable<T, O> &
  AsyncIterable<R> &
  Disposable & { [CHAN]: Channel<R>; readonly [OUTPUTS]?: O };

export type Changes<O> = Disposable & {
  readonly outputs: O;
  next(): Promise<IteratorResult<Op[], undefined>>;
  return(): Promise<IteratorReturnResult<undefined>>;
  [Symbol.asyncIterator](): Changes<O>;
};

export type Watch<V> = Disposable & {
  next(): Promise<IteratorResult<V, undefined>>;
  return(): Promise<IteratorReturnResult<undefined>>;
  [Symbol.asyncIterator](): Watch<V>;
};

// A state of unknown outputs, such as an any, takes any key.
type Keys<O> = unknown extends O
  ? PropertyKey
  : O extends readonly unknown[]
    ? number
    : keyof O;
type Slice<O, K> = unknown extends O
  ? any
  : O extends readonly unknown[]
    ? O
    : { [P in K & keyof O]?: O[P] };
type Entry<O, K> = unknown extends O
  ? unknown
  : O extends readonly (infer E)[]
    ? E
    : O[K & keyof O];
type Reads<O> = { [CHAN]: Channel<any>; readonly [OUTPUTS]?: O };

/** Checks the keys of a slice reader, and opens a reader, of all slots without keys. */
type Opener = {
  check(keys: unknown): void;
  open(keys?: readonly PropertyKey[]): Changes<unknown>;
};
/** Maps each select proxy to its opener of `changes` readers. */
const openers = new WeakMap<object, Opener>();
/** Tells if a value is a select proxy. */
export const isState = (value: unknown) => openers.has(value as object);

/** Opens a reader that gives the outputs now, then the operations of each report since the last read. */
export function changes<O>(state: Reads<O>): Changes<O>;
/** Opens a reader of some slots, which gives their outputs now, then their operations of each report since the last read. */
export function changes<O, const K extends Keys<O>>(
  state: Reads<O>,
  keys: readonly K[],
): Changes<Slice<O, K>>;
export function changes(state: any, keys?: readonly PropertyKey[]) {
  const opener = openers.get(state);
  if (!opener) throw new TypeError("changes needs a select proxy");
  if (keys !== undefined) opener.check(keys);
  return opener.open(keys);
}

const finished = { done: true, value: undefined } as const;

/** Gives the output of one slot, then each new output, from a slice reader that opens at the first next(). */
export function watch<O, K extends Keys<O>>(
  state: Reads<O>,
  key: K,
): Watch<Entry<O, K>>;
export function watch(state: any, key: PropertyKey): Watch<unknown> {
  const opener = openers.get(state);
  if (!opener) throw new TypeError("watch needs a select proxy");
  opener.check([key]);
  let reader: Changes<any> | undefined,
    current: unknown, // The last output that the reads give the slot
    last: unknown,
    given = false, // SE-163 compares with the last given output
    present: boolean, // Set when the reader opens
    done = false,
    tail: Promise<unknown> = Promise.resolve();
  /** Opens the reader at the first next(), so an index names the slot at that call (SE-161). */
  const begin = () => {
    reader = opener.open([key]);
    const { outputs } = reader;
    const values = Array.isArray(outputs)
      ? outputs
      : Reflect.ownKeys(outputs).map(name => outputs[name]);
    present = values.length > 0;
    current = values[0];
  };
  /** Reads until the slot has a new output, or the reader finishes. */
  const step = async (): Promise<IteratorResult<unknown, undefined>> => {
    if (done) return finished;
    while (!present || (given && Object.is(current, last))) {
      // A rejection finishes the reader, so later reads end (SE-14A)
      const result = await (reader as Changes<any>).next();
      if (result.done || done) return finished; // SE-165 for a read that settled before return(), and a finished reader stays finished
      for (const op of result.value as any[])
        if (op.op === "set") (current = op.value), (present = true);
        else if (op.op === "delete" || op.removed.length) present = false;
        else (current = op.added[0]), (present = true); // SE-155 describes the slot, and one slot never moves
      if (!present) return (stop(), finished); // SE-164
    }
    given = true;
    return { done: false, value: (last = current) };
  };
  /** Finishes watch and its reader, which settles a waiting read. */
  const stop = () => {
    done = true;
    void reader?.return();
  };
  const it: Watch<unknown> = {
    next() {
      if (!reader && !done) begin();
      const result = tail.then(step); // SE-166
      tail = result.catch(noop);
      return result;
    },
    return: () => (stop(), Promise.resolve(finished)),
    [Symbol.asyncIterator]: () => it,
    [Symbol.dispose]: stop,
  };
  return it;
}

const PLAIN = 0,
  PROMISE = 1,
  ASYNC = 2,
  RAW = 3;
const KINDS = ["plain", "promise", "async", "raw"];
const RESERVED: PropertyKey[] = [Symbol.asyncIterator, Symbol.dispose, CHAN];
const OPTION_TYPES = {
  autoStart: "boolean",
  autoClose: "boolean",
  backPressure: "boolean",
  nonYielding: "boolean",
  unwrap: "boolean",
  onChanges: "function",
  mapSnapshot: "function",
};

/**
 * Finds the slot kind of a source: a promise, an async iterable, a raw iterator, or a plain value.
 * SE-016 keeps the method detection read, so later steps never read it again. */
const detect = (source: any): { kind: number; method?: any } => {
  const then = thenOf(source);
  if (typeof then === "function") return { kind: PROMISE, method: then };
  const asyncIterator = source?.[Symbol.asyncIterator];
  if (typeof asyncIterator === "function")
    return { kind: ASYNC, method: asyncIterator };
  const next = source?.next;
  return typeof next === "function"
    ? { kind: RAW, method: next }
    : { kind: PLAIN };
};

/** Makes a frozen, branded `Val`. */
const val = (
  status: Val<unknown>["status"],
  value: unknown,
  reason: unknown,
  done: boolean,
) =>
  Object.freeze(
    Object.defineProperty({ status, value, reason, done }, VAL, {
      value: true,
    }),
  ) as Val<unknown>;

/** Gives the array index of a canonical index string, or undefined. */
const toIndex = (key: PropertyKey) => {
  if (typeof key !== "string") return undefined;
  const index = Number(key) >>> 0;
  return String(index) === key && index !== 2 ** 32 - 1 ? index : undefined;
};

/** A proxy trap for operations that a select proxy does not support. */
const forbid = () => {
  throw new TypeError("Operation is not supported on a select proxy");
};

/**
 * Gives the indexes of items in sorted order, for a move operation.
 * Follows Array.prototype.sort, which sorts undefined last without calling compare. */
const ranked = (items: unknown[], compare?: (a: any, b: any) => number) =>
  items
    .map((_, index) => index)
    .sort((i, j) => {
      const a = items[i],
        b = items[j];
      if (a === undefined)
        // Stryker disable next-line ConditionalExpression,EqualityOperator: V8 only tests a result for being negative
        return b === undefined ? 0 : 1;
      if (b === undefined) return -1;
      if (compare) return compare(a, b);
      const x = `${a}`,
        y = `${b}`;
      if (x < y) return -1;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: V8 only tests a result for being negative
      return x > y ? 1 : 0;
    });

type Slot = {
  key?: PropertyKey;
  source: any;
  kind: number;
  method: any; // What detection read, by SE-016
  state: any;
  iterator?: any;
  next?: any;
  sync?: boolean; // Undefined until a raw iterator's first result
  busy?: boolean; // A pull or a yielded promise is in progress
  finished?: boolean;
  dead?: boolean; // Removed from the shape, or the channel is terminal
  fresh?: boolean; // SE-061, state changed since the previous flush reached step 2
  awaited?: boolean; // Unreported result came from a yielded promise
  due?: boolean; // SE-064 applies in step 5 of this flush
};

/** Wraps a shape of values and sources in a proxy, and publishes a snapshot or operations when a source settles or code writes. */
export function select<T extends SelectShape, R = Unwrapped<T>>(
  shape: T,
  options: SelectOptions<Unwrapped<T>, R> & { unwrap: true },
): State<T, R, Unwrapped<T>>;
/** Wraps a shape of values and sources in a proxy, and publishes a snapshot or operations when a source settles or code writes. */
export function select<T extends SelectShape, R = Snapshot<T>>(
  shape: T,
  options?: SelectOptions<Snapshot<T>, R> & { unwrap?: false },
): State<T, R>;
export function select(shape: any, options: any = {}): any {
  if (typeof shape !== "object" || shape === null)
    throw new TypeError("select shape must be an object");
  if (RESERVED.some(key => Object.hasOwn(shape, key)))
    throw new TypeError("select shape holds a reserved key");
  checkOptions(options, OPTION_TYPES);
  const {
    autoStart = false,
    autoClose = true,
    backPressure = true,
    nonYielding = false,
    unwrap = false,
  } = options;
  const {
    onChanges,
    mapSnapshot,
    thenReceive = "latest",
    stopStyle,
    firstReceive = thenReceive === "unread" ? "unread" : "latest",
  } = options;
  const channel = new Channel<any>({ firstReceive, thenReceive, stopStyle });
  const { signal } = channel;
  const isArray = Array.isArray(shape);
  const target: any = isArray ? Array.from(shape) : { ...shape };
  const array: Slot[] = [];
  const map = new Map<PropertyKey, Slot>();
  /** Gives a copy of the slots in shape order. */
  const slots = () => (isArray ? [...array] : [...map.values()]);
  let ops: any[] | undefined = onChanges && [];
  // Reported operations that a reader did not read, from the absolute index base.
  // Stryker disable next-line ArrayDeclaration: a reader starts after all that the log holds
  let reported: Op[] = [],
    base = 0;
  const readers = new Set<{
    at: number;
    wake: () => void;
    begin?: (length: number) => void; // SE-155 names the slots of an array slice at start
  }>();
  let started = false,
    dirty: boolean | undefined,
    scheduled = false,
    running = false,
    changed = true, // A silent update flushes without a snapshot
    sorting = false;

  /** Gives the output of a slot: its `Val`, or its value under `unwrap`. */
  const out = (slot: Slot) =>
    unwrap && slot.kind !== PLAIN ? slot.state.value : slot.state;
  /** Records an operation, if anyone reads operations and the select started. */
  const log = (op: () => Op) => {
    if (ops && started) ops.push(op()); // SE-10A
  };
  /** Gives the current key or index of a slot. */
  const keyOf = (slot: Slot) =>
    isArray ? array.indexOf(slot) : (slot.key as string);

  /** Queues one flush in a microtask, unless one is queued or running. */
  const schedule = () => {
    if (scheduled || running || !started || signal.aborted) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  /** Marks the state changed, and schedules a flush. */
  const touch = () => {
    dirty = changed = true;
    schedule();
  };

  /** Sets the state of a live slot, and logs and schedules the change once started. */
  const update = (slot: Slot, state: Val<unknown>, silent = false) => {
    if (slot.dead) return;
    const prev = out(slot);
    slot.state = state;
    if (!started) return;
    if (unwrap && state.status === "rejected")
      return channel.throw(state.reason);
    if (silent) return schedule(); // SE-02B
    log(() => ({ op: "set", key: keyOf(slot), value: out(slot), prev }));
    touch();
  };

  /** Finishes a slot with a rejected state, and calls `return()` on its iterator when its value failed. */
  const fail = (slot: Slot, error: unknown, valueFailed = false) => {
    const open = !slot.finished;
    slot.busy = false;
    slot.finished = true;
    if (slot.dead) return;
    if (valueFailed && open) void quietReturn(slot.iterator);
    update(slot, val("rejected", undefined, error, true));
  };

  /** Sets a fulfilled state from an iterator result, and keeps the last value for an empty final result. */
  const commit = (
    slot: Slot,
    value: unknown,
    done: boolean,
    awaited: boolean,
  ) => {
    slot.busy = false;
    slot.fresh = true;
    slot.awaited = awaited;
    const kept = value === undefined && done;
    update(
      slot,
      val("fulfilled", kept ? slot.state.value : value, undefined, done),
      kept && unwrap,
    );
  };

  /** Checks an iterator result, and commits its value now, or after a yielded promise settles. */
  const receive = (slot: Slot, result: any) => {
    if (Object(result) !== result)
      throw new TypeError("Iterator result is not an object");
    const done = !!result.done,
      value = result.value;
    slot.finished ||= done;
    let thenable: boolean;
    try {
      thenable = isThenable(value);
    } catch (error) {
      return fail(slot, error, true); // Awaiting this value would reject, so it counts as SE-02A
    }
    if (!thenable) return commit(slot, value, done, false);
    slot.busy = true;
    Promise.resolve(value).then(
      settled => commit(slot, settled, done, true),
      error => fail(slot, error, true),
    );
  };

  /** Calls `next` on the iterator of a slot, and learns on the first call if it is sync. */
  const pull = (slot: Slot) => {
    let result: any;
    try {
      // Stryker disable next-line ConditionalExpression: pulling only names the source for an emitter
      result = emit
        ? pulling(slot.source, () => slot.next.call(slot.iterator))
        : slot.next.call(slot.iterator);
      const thenable = isThenable(result);
      slot.sync ??= !thenable;
      if (thenable && slot.sync) {
        quiet(result);
        return fail(
          slot,
          new TypeError("Sync iterator returned a thenable"),
          true,
        ); // SE-02A
      }
      if (slot.sync) return receive(slot, result);
    } catch (error) {
      return fail(slot, error);
    }
    slot.busy = true;
    Promise.resolve(result)
      .then(settled => receive(slot, settled))
      .catch(error => fail(slot, error));
  };

  /** Tells if a slot can be pulled now. */
  const idle = (slot: Slot) => !slot.dead && !slot.finished && !slot.busy;

  /** Subscribes to a promise slot, and updates it when the promise settles. */
  const listen = (slot: Slot) => {
    const { source, method: then } = slot;
    const fulfilled = (value: unknown) =>
      update(slot, val("fulfilled", value, undefined, true));
    const rejected = (reason: unknown) =>
      update(slot, val("rejected", undefined, reason, true));
    quiet(source);
    if (source instanceof Promise && then === Promise.prototype.then)
      then.call(source, fulfilled, rejected);
    // Calling then() synchronously keeps it off a channel that turns terminal a microtask later.
    else
      new Promise((resolve, reject) => then.call(source, resolve, reject)).then(
        fulfilled,
        rejected,
      );
  };

  /** Creates a slot for a source, and listens to a native promise at once. */
  const make = (
    source: unknown,
    key: PropertyKey | undefined,
    { kind, method }: ReturnType<typeof detect>,
  ): Slot => {
    const slot: Slot = {
      key,
      source,
      kind,
      method,
      state: kind ? val("pending", undefined, undefined, false) : source,
      sync: kind === ASYNC ? false : undefined,
    };
    if (kind === PROMISE && source instanceof Promise) listen(slot);
    return slot;
  };

  /** Opens the iterator or the promise of a slot, when the select starts or the slot arrives after. */
  const activate = (slot: Slot) => {
    if (slot.dead) return;
    if (slot.kind === RAW) {
      slot.iterator = slot.source;
      slot.next = slot.method;
    } else if (slot.kind === PROMISE && !(slot.source instanceof Promise))
      listen(slot);
    else if (slot.kind === ASYNC) {
      try {
        slot.iterator = slot.method.call(slot.source);
        slot.next = slot.iterator.next;
      } catch (error) {
        fail(slot, error);
      }
    }
  };

  /** Starts the select, logs the initial shape, and activates all slots. */
  const start = () => {
    started = true;
    emit?.("start");
    const all = slots();
    if (!isArray)
      for (const slot of all)
        log(() => ({
          op: "set",
          key: keyOf(slot),
          value: out(slot),
          prev: undefined,
        }));
    else if (all.length)
      log(() => ({ op: "splice", start: 0, removed: [], added: all.map(out) }));
    for (const reader of readers) reader.begin?.(all.length);
    const rejected =
      unwrap &&
      all.find(slot => slot.kind !== PLAIN && slot.state.status === "rejected");
    if (rejected) channel.throw(rejected.state.reason);
    all.forEach(activate);
    schedule();
  };

  /** Gives the outputs of all slots, in the shape of the target. */
  const snapshot = () =>
    isArray
      ? array.map(out)
      : Object.fromEntries([...map].map(([key, slot]) => [key, out(slot)]));

  /**
   * Tells if a slot can still change, which keeps an autoClose select open.
   * Step 6 has just pulled every idle async iterator, so an unfinished one is busy here. */
  const live = (slot: Slot) =>
    slot.kind === PROMISE ? slot.state.status === "pending" : slot.busy;

  /**
   * Tells if step 1 of a flush pulls a raw iterator before the report.
   * An idle async raw iterator is always fresh here, because step 6 pulls it right after each report. */
  const advancing = (slot: Slot) =>
    slot.kind === RAW && idle(slot) && !slot.fresh;

  /** Advances sources, reports operations, publishes a snapshot, pulls the next values, and closes with autoClose. */
  async function flush() {
    scheduled = false;
    running = true;
    try {
      // SE-046: terminal marks every slot dead, so idle() checks steps 1, 5 and 6, and steps 7 and 8 do nothing.
      // SE-043: a step 1 change belongs to this flush, so repeat for slots it added, and fresh stops a second advance.
      for (let due: Slot[]; (due = slots().filter(advancing)).length; )
        for (const slot of due) if (advancing(slot)) pull(slot);
      if (signal.aborted) return;
      const publish = changed;
      dirty = changed = false;
      for (const slot of slots()) {
        slot.due = slot.awaited;
        slot.awaited = slot.fresh = false;
      }
      if (ops?.length) {
        const report = ops;
        ops = [];
        emit?.("report", report);
        if (readers.size) {
          for (const op of report) reported.push(op); // A spread overflows the stack on a large report
          for (const reader of readers) reader.wake();
        }
        onChanges?.(report);
      }
      if (signal.aborted) return;
      if (publish && !nonYielding) {
        const snap = snapshot();
        const value = mapSnapshot ? mapSnapshot(snap) : snap;
        if (backPressure) await channel.asend(value);
        else channel.send(value);
      }
      for (const slot of slots())
        if (slot.due && slot.sync && idle(slot)) pull(slot);
      for (const slot of slots())
        if (slot.sync === false && idle(slot)) pull(slot);
      if (autoClose && !dirty && !slots().some(live)) channel.close();
    } catch (error) {
      channel.throw(error); // A no-op for this channel's own stop error
    } finally {
      running = false;
      if (dirty) schedule();
    }
  }

  /** Writes a source to the target as a plain data property. */
  const define = (key: any, source: unknown) =>
    Reflect.defineProperty(target, key, {
      value: source,
      writable: true,
      enumerable: true,
      configurable: true,
    });

  /** Throws if a sort comparator tries to change the proxy. */
  const unlocked = () => {
    if (sorting)
      throw new TypeError("A comparator cannot change a select proxy");
  };

  /** Replaces the source at a key with a new slot, and logs a set. */
  const write = (key: any, source: unknown) => {
    unlocked();
    if (signal.aborted) {
      define(key, source);
      return quiet(source);
    }
    const slot = make(source, key, detect(source)); // SE-016 throws before anything changes
    const old = isArray ? array[key] : map.get(key);
    const prev = old && out(old);
    define(key, source);
    if (old) old.dead = true;
    if (isArray) array[key] = slot;
    else map.set(key, slot);
    log(() => ({ op: "set", key, value: out(slot), prev }));
    touch();
    if (started) activate(slot);
  };

  /** Replaces a range of an array shape with new slots, logs a splice, and gives the removed sources. */
  const splice = (start: number, count: number, items: unknown[]) => {
    if (!count && !items.length) return [];
    unlocked();
    if (signal.aborted) {
      items.forEach(quiet);
      return replace(target, start, count, items);
    }
    const detected = items.map(item => detect(item)); // SE-016 throws before anything changes
    const added = items.map((item, index) =>
      make(item, undefined, detected[index]),
    );
    const removed = replace(target, start, count, items);
    const gone = replace(array, start, count, added);
    log(() => ({
      op: "splice",
      start,
      removed: gone.map(out),
      added: added.map(out),
    }));
    for (const slot of gone) slot.dead = true;
    touch();
    if (started) added.forEach(activate);
    return removed;
  };

  /** Reorders an array shape and its slots, and logs a move. */
  const permute = (order: number[]) => {
    unlocked();
    if (order.every((from, to) => from === to)) return state; // SE-097
    relocate(target, order);
    // Stryker disable next-line ConditionalExpression: slots and operations are unobservable on a terminal channel
    if (signal.aborted) return state;
    relocate(array, order);
    log(() => ({ op: "move", order }));
    touch();
    return state;
  };

  /** Checks a sort comparator, and that no sort is running. */
  const checkCompare = (compare?: (a: any, b: any) => number) => {
    if (compare !== undefined && typeof compare !== "function")
      throw new TypeError("sort comparator must be a function");
    unlocked();
  };

  /** Sorts by items with compare, and locks the proxy while compare runs. */
  const arrange = (items: unknown[], compare?: (a: any, b: any) => number) => {
    let order: number[];
    sorting = true;
    try {
      order = ranked(items, compare);
    } finally {
      sorting = false;
    }
    return permute(order);
  };

  /** Gives an array of count undefined items. */
  const blanks = (count: number) => Array.from({ length: count }) as unknown[];

  /** Sets the length of an array shape, with a splice. */
  const resize = (value: unknown) => {
    const length = +(value as number), // Unlike Number(), this throws on a BigInt
      size = target.length;
    if (length >>> 0 !== length) throw new RangeError("Invalid array length");
    if (length < size) splice(length, size, []);
    else splice(size, 0, blanks(length - size));
  };

  /** Handles a proxy write, which skips an `Object.is` same source. */
  const assign = (key: PropertyKey, source: unknown) => {
    if (RESERVED.includes(key)) throw new TypeError("Reserved select key");
    if (!isArray) {
      if (!Object.hasOwn(target, key) || !Object.is(target[key], source))
        write(key, source);
    } else if (key === "length") resize(source);
    else {
      const index = toIndex(key);
      if (index === undefined)
        throw new TypeError("An array shape accepts index keys only");
      if (index >= target.length)
        splice(target.length, 0, [...blanks(index - target.length), source]);
      else if (!Object.is(target[index], source)) write(index, source);
    }
  };

  /** Handles a proxy delete, which sets an array item to undefined and deletes an object key. */
  const remove = (key: PropertyKey) => {
    if (RESERVED.includes(key)) throw new TypeError("Reserved select key");
    if (isArray) {
      const index = toIndex(key);
      if (index === undefined) return Reflect.deleteProperty(target, key);
      if (index < target.length) assign(key, undefined);
      return true;
    }
    if (!Object.hasOwn(target, key)) return true;
    delete target[key];
    if (signal.aborted) return true;
    // biome-ignore lint/style/noNonNullAssertion: an own key has a slot until the channel ends
    const slot = map.get(key)!;
    log(() => ({ op: "delete", key: key as string, prev: out(slot) }));
    slot.dead = true;
    map.delete(key);
    touch();
    return true;
  };

  /** Converts an argument to an integer, as array methods do. */
  const integer = (value: unknown) => Math.trunc(+(value as number)) || 0;
  /** Resolves a relative array index, clamped to the array. */
  const position = (value: unknown, size: number) => {
    const relative = integer(value);
    return relative < 0
      ? Math.max(size + relative, 0)
      : Math.min(relative, size);
  };

  /** Array methods of an array proxy, which change the shape through splice and permute. */
  const methods: Record<PropertyKey, unknown> = {
    __proto__: null as any,
    push: (...items: unknown[]) => (
      splice(target.length, 0, items), target.length
    ),
    pop: () => splice(target.length - 1, Math.min(target.length, 1), [])[0],
    shift: () => splice(0, Math.min(target.length, 1), [])[0],
    unshift: (...items: unknown[]) => (splice(0, 0, items), target.length),
    splice: (...args: unknown[]) => {
      const size = target.length,
        begin = position(args[0], size);
      const count = !args.length
        ? 0
        : args.length === 1
          ? size - begin
          : Math.min(Math.max(integer(args[1]), 0), size - begin);
      return splice(begin, count, args.slice(2));
    },
    fill: (source: unknown, from?: unknown, to?: unknown) => {
      const size = target.length,
        begin = position(from, size),
        end = to === undefined ? size : position(to, size),
        count = Math.max(end - begin, 0);
      quiet(source); // SE-034 holds for an empty range too
      splice(begin, count, blanks(count).fill(source));
      return state;
    },
    sort: (compare?: (a: any, b: any) => number) => {
      checkCompare(compare);
      return arrange(target, compare);
    },
    sortOutputs: (compare?: (a: any, b: any) => number) => {
      checkCompare(compare);
      if (signal.aborted)
        throw new TypeError("sortOutputs needs a live channel");
      return arrange(array.map(out), compare);
    },
    reverse: () =>
      permute(target.map((_: unknown, i: number) => target.length - 1 - i)),
    copyWithin: (to: unknown, from: unknown, until?: unknown) => {
      const size = target.length,
        begin = position(to, size),
        first = position(from, size),
        end = until === undefined ? size : position(until, size),
        count = Math.min(end - first, size - begin);
      if (begin !== first)
        splice(begin, Math.max(count, 0), target.slice(first, first + count));
      return state;
    },
  };

  /** Gives a consumer of the snapshot channel. */
  const iterate = () => channel[Symbol.asyncIterator]();
  /** Closes the snapshot channel. */
  const dispose = () => channel[Symbol.dispose]();

  if (isArray)
    for (const source of target)
      array.push(make(source, undefined, detect(source)));
  else
    for (const key of Reflect.ownKeys(target))
      map.set(key, make(target[key], key, detect(target[key])));

  signal.addEventListener("abort", () => {
    for (const slot of slots()) {
      slot.dead = true;
      if (slot.kind >= ASYNC && !slot.finished)
        void quietReturn(slot.iterator ?? slot.source);
    }
    for (const reader of readers) reader.wake(); // SE-14A
  });

  if (autoStart) queueMicrotask(start);
  else attached(channel).then(start, noop);

  /** The select proxy, which reads the target and routes writes to slots. */
  const state = new Proxy(target, {
    get(_, key, receiver) {
      if (key === Symbol.asyncIterator) return iterate;
      if (key === Symbol.dispose) return dispose;
      if (key === CHAN) return channel;
      return isArray && key in methods
        ? methods[key]
        : Reflect.get(target, key, receiver);
    },
    has: (_, key) =>
      RESERVED.includes(key) ||
      (isArray && key in methods) ||
      Reflect.has(target, key),
    set(_, key, value) {
      assign(key, value);
      return true;
    },
    deleteProperty: (_, key) => remove(key),
    defineProperty: forbid,
    preventExtensions: forbid,
    setPrototypeOf: forbid,
  });
  /**
   * Drops reported operations that every reader read.
   * SE-14B drops what each reader read, and SE-14C stops the log with no reader. */
  const trim = () => {
    let low = base + reported.length;
    for (const reader of readers) low = Math.min(low, reader.at);
    reported.splice(0, low - base);
    base = low;
    if (!readers.size && !onChanges && !emit) ops = undefined;
  };

  /** Throws a `TypeError` for keys that do not name slots of this shape (SE-150). */
  const check = (keys: unknown) => {
    if (!Array.isArray(keys))
      throw new TypeError("changes keys must be an array");
    for (const key of keys)
      if (
        isArray
          ? !Number.isInteger(key) || key < 0
          : !["string", "symbol", "number"].includes(typeof key)
      )
        throw new TypeError(
          isArray
            ? "An array slice takes indexes"
            : "An object slice takes property keys",
        );
  };

  /**
   * Gives the outputs of a slice reader, and rewrites operations to them (SE-152 to SE-156).
   * An array slice keeps the ascending indexes of its slots, and follows them through each operation. */
  const view = (keys: readonly PropertyKey[]) => {
    if (!isArray) {
      const names = new Set<PropertyKey>(
        keys.map(key => (typeof key === "number" ? `${key}` : key)),
      );
      return {
        outputs: started
          ? Object.fromEntries(
              [...map]
                .filter(([key]) => names.has(key))
                .map(([key, slot]) => [key, out(slot)]),
            )
          : {},
        // An object shape logs only set and delete
        project: (list: Op[]) =>
          list.filter(op => names.has((op as { key: PropertyKey }).key)),
        begin: noop,
        spent: noop as () => boolean, // An object slice follows keys, so it never runs out
      };
    }
    const wanted = [...new Set(keys as number[])].sort((a, b) => a - b);
    const name = (length: number) => wanted.filter(index => index < length);
    let at = started ? name(array.length) : undefined,
      describe = false;
    return {
      outputs: (at ?? []).map(index => out(array[index] as Slot)),
      begin(length: number) {
        at = name(length);
        describe = true; // An empty slice is spent, so it never reads the description
      },
      project(list: Op[]) {
        const result: Op[] = [];
        for (const op of list) {
          const picked = at as number[];
          if (describe) {
            describe = false;
            const { added } = op as Extract<Op, { op: "splice" }>;
            result.push({
              op: "splice",
              start: 0,
              removed: [],
              added: picked.map(index => added[index]),
            });
          } else if (op.op === "set") {
            const index = picked.indexOf(op.key as number);
            if (index >= 0) result.push({ ...op, key: index });
          } else if (op.op === "splice") {
            const end = op.start + op.removed.length,
              shift = op.added.length - op.removed.length,
              removed: unknown[] = [];
            let first = -1;
            at = picked.flatMap((index, j) => {
              if (index < op.start) return [index];
              if (index >= end) return [index + shift];
              if (first < 0) first = j;
              removed.push(op.removed[index - op.start]);
              return [];
            });
            if (removed.length)
              result.push({ op: "splice", start: first, removed, added: [] });
          } else {
            // Stryker disable next-line ArrayDeclaration: a move order is a permutation, so every index gets written
            const to: number[] = [];
            (op as Extract<Op, { op: "move" }>).order.forEach((from, index) => {
              to[from] = index;
            });
            const moved = picked
              .map((index, j) => [to[index] as number, j] as const)
              .sort((a, b) => a[0] - b[0]);
            at = moved.map(([index]) => index);
            const order = moved.map(([, j]) => j);
            if (order.some((j, index) => j !== index))
              result.push({ op: "move", order });
          }
        }
        return result;
      },
      spent: () => at?.length === 0, // SE-156
    };
  };

  /** Opens a reader of the log, or of a slice of it, which takes its operations at each report (SE-157). */
  const open = (keys?: readonly PropertyKey[]) => {
    const slice = keys && view(keys);
    const outputs = slice
      ? slice.outputs
      : started
        ? snapshot()
        : isArray
          ? []
          : {};
    const waiting: PromiseWithResolvers<IteratorResult<Op[], undefined>>[] = [];
    const taken: Op[] = []; // Slice operations that no read took yet
    let closed = false, // By return() or dispose, or by the SE-14A rejection
      ended = false;
    /** Tells devtools one time that the reader finished or has no slot left (DV-051). */
    const end = () => {
      if (!ended) (ended = true), emitReader?.("end");
    };
    /** Moves the reported operations after the position into the slice operations. */
    const take = (slice: ReturnType<typeof view>) => {
      for (const op of slice.project(reported.slice(reader.at - base)))
        taken.push(op);
      reader.at = base + reported.length;
      if (slice.spent()) readers.delete(reader), end();
      trim();
    };
    const reader = {
      at: base + reported.length,
      wake: () => (slice && take(slice), settle()),
      begin:
        slice && ((length: number) => (slice.begin(length), reader.wake())),
    };
    /** Gives the operations that a read takes, or undefined if none waits. */
    const read = () => {
      if (slice) return taken.length ? taken.splice(0) : undefined;
      const end = base + reported.length;
      if (!readers.has(reader) || reader.at >= end) return undefined;
      const value = reported.slice(reader.at - base);
      reader.at = end;
      trim();
      return value;
    };
    /** Resolves waiting reads with new operations, or ends them when the reader closes. */
    const settle = () => {
      while (waiting.length) {
        // biome-ignore lint/style/noNonNullAssertion: the loop runs while a read waits
        const next = waiting[0]!,
          value = read();
        if (value)
          next.resolve({ done: false, value }), emitReader?.("read", value);
        else if (!signal.aborted && !closed && !slice?.spent()) return;
        else {
          readers.delete(reader);
          trim();
          if (!closed && failed(channel)) next.reject(signal.reason.reason);
          else next.resolve({ done: true, value: undefined });
          closed = true;
          end();
        }
        waiting.shift();
      }
    };
    /** Stops the reader, and ends its waiting reads. */
    const close = () => {
      closed = true;
      end();
      taken.length = 0;
      readers.delete(reader) && trim();
      settle();
    };
    const it = {
      outputs,
      next() {
        const read = Promise.withResolvers<IteratorResult<Op[], undefined>>();
        waiting.push(read);
        settle();
        return read.promise;
      },
      return: () => (
        close(), Promise.resolve({ done: true, value: undefined })
      ),
      [Symbol.asyncIterator]: () => it,
      [Symbol.dispose]: close,
    };
    const emitReader = register("reader", it, {
      state,
      keys,
      source: pulledSource(),
    });
    if (slice?.spent())
      end(); // SE-156 finishes a reader that names no slot
    else if (!signal.aborted) {
      if (ops) reader.at += ops.length;
      else ops = [];
      readers.add(reader);
    }
    return it as Changes<unknown>;
  };
  openers.set(state, { check, open });

  const emit = register("select", state, {
    channel,
    array: isArray,
    unwrap,
    slots: () =>
      slots().map(slot => ({
        key: keyOf(slot),
        kind: KINDS[slot.kind],
        sync: slot.sync,
        source: slot.source,
        state: slot.state,
        busy: !!slot.busy,
        finished: !!slot.finished,
      })),
  });
  if (emit) ops ??= []; // DV-030 builds operations for devtools too
  return state;
}
