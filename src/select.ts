// The select side: slots, pulls and the flush. The operation log and its readers are in log.ts.
// The worklists, the raw kinds and the observed flush keep a change from walking the shape or running with no observer (scope.md, Decided).
import {
  attached,
  CHOICES,
  Channel,
  type ChannelOptions,
  consumed,
  onAttach,
  onEnd,
  terminal,
} from "./channel.ts";
import { type Emit, pulling, register } from "./devtools.ts";
import {
  alive,
  beginReader,
  type Changes,
  IndexSlice,
  KeySlice,
  Log,
  type Op,
  Reader,
  type View,
  type Watch,
  Watcher,
  wakeReader,
} from "./log.ts";
import {
  ASYNC,
  checkOptions,
  type Detected,
  detect,
  isThenable,
  noop,
  PLAIN,
  PROMISE,
  quiet,
  quietReturn,
  RAW,
  relocate,
  replace,
  VAL,
} from "./source.ts";

export const CHAN: unique symbol = Symbol.for("gg.CHAN") as any;
/** The option key of the report hook, which the JSX host sets. Not exported from the package. */
export const REPORT: unique symbol = Symbol() as any;
/** The option key of the fault hook, which gets the errors that select ignores (SE-127). Not exported from the package. */
export const FAULT: unique symbol = Symbol() as any;
/** The option key that makes a delete return the iterator of the slot, for a drive that owns its sources (SE-128). Not exported from the package. */
export const RETURNS: unique symbol = Symbol() as any;
declare const OUTPUTS: unique symbol; // Type only, so changes infers the outputs

export type SelectShape = Record<string | symbol, unknown> | readonly unknown[];

export type { Changes, Op, Watch } from "./log.ts";

export type Val<T> =
  | { status: "pending"; value: undefined; reason: undefined; done: false }
  | { status: "fulfilled"; value: T; reason: undefined; done: boolean }
  | { status: "rejected"; value: undefined; reason: unknown; done: true };

export type SelectOptions<S, R> = ChannelOptions & {
  autoStart?: boolean;
  autoClose?: boolean;
  backPressure?: boolean;
  unwrap?: boolean;
  mapSnapshot?: (snapshot: S) => R;
  [REPORT]?: (ops: Op[]) => unknown; // A promise holds the next pulls (JX-083)
  [FAULT]?: (error: unknown) => void;
  [RETURNS]?: boolean;
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

// A state of unknown outputs, such as an any, takes any key.
export type Keys<O> = unknown extends O
  ? PropertyKey
  : O extends readonly unknown[]
    ? number
    : keyof O;
type Slice<O, K> = unknown extends O
  ? any
  : O extends readonly unknown[]
    ? O
    : { [P in K & keyof O]?: O[P] };
export type Entry<O, K> = unknown extends O
  ? unknown
  : O extends readonly (infer E)[]
    ? E
    : O[K & keyof O];
export type Reads<O> = { [CHAN]: Channel<any>; readonly [OUTPUTS]?: O };

/** Maps each select proxy to its select. */
const openers = new WeakMap<object, Select>();
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

/** Gives the outputs of a select now, as a new reader holds them, with no reader to finish (SE-14D). */
export function outputs<O>(state: Reads<O>): O;
export function outputs(state: any) {
  const opener = openers.get(state);
  if (!opener) throw new TypeError("outputs needs a select proxy");
  return opener.outputs();
}

/** Gives the output of one slot, then each new output, from a slice reader that opens at the first next(). */
export function watch<O, K extends Keys<O>>(
  state: Reads<O>,
  key: K,
): Watch<Entry<O, K>>;
export function watch(state: any, key: PropertyKey): Watch<unknown> {
  const opener = openers.get(state);
  if (!opener) throw new TypeError("watch needs a select proxy");
  opener.check([key]);
  return new Watcher(opener, key);
}

// A raw iterator becomes a sync or an async raw iterator at its first result.
const SYNC_RAW = 5,
  ASYNC_RAW = 6;
const KINDS = ["plain", "promise", "async", "raw", undefined, "raw", "raw"];
const SYNC = [undefined, undefined, false, undefined, undefined, true, false];
const RESERVED: PropertyKey[] = [Symbol.asyncIterator, Symbol.dispose, CHAN];
const OPTION_TYPES = {
  autoStart: "boolean",
  autoClose: "boolean",
  backPressure: "boolean",
  unwrap: "boolean",
  mapSnapshot: "function",
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
const forbid = (name: string) => {
  throw new TypeError(`${name} is not supported on a select proxy`);
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

// The states of the iterator of a slot.
const OPEN = 0, // Idle, so a flush can pull it
  BUSY = 1, // A pull or a yielded promise is in progress
  FINAL = 2, // The yielded promise of the final result is in progress
  FINISHED = 3;

type Slot = {
  key?: PropertyKey;
  index: number; // The position of an array slot, or the rank of an object key in slot order
  source: any;
  kind: number;
  method: any; // What detection read, by SE-016
  state: any;
  status: number; // OPEN, BUSY, FINAL or FINISHED
  iterator?: any;
  next?: any;
  dead?: boolean; // Removed from the shape, or the channel is terminal
};

/** Orders slots as the shape does. */
const byIndex = (a: Slot, b: Slot) => a.index - b.index;
// The first ranks of string and symbol keys, which come after the array index keys of a plain object (SE-047).
const STRINGS = 2 ** 32,
  SYMBOLS = 2 ** 52;

/** Takes the slots of a worklist in shape order, and empties it. */
const drain = (set: Set<Slot>) => {
  const list = [...set].sort(byIndex);
  set.clear();
  return list;
};

// The phases of a select and its flush.
const NEW = 0, // Not started
  IDLE = 1,
  QUEUED = 2,
  RUNNING = 3;

/** Converts an argument to an integer, as array methods do. */
const integer = (value: unknown) => Math.trunc(+(value as number)) || 0;
/** Resolves a relative array index, clamped to the array. */
const position = (value: unknown, size: number) => {
  const relative = integer(value);
  return relative < 0 ? Math.max(size + relative, 0) : Math.min(relative, size);
};
/** Gives an array of count undefined items. */
const blanks = (count: number) => Array.from({ length: count }) as unknown[];

type Method = (select: Select, ...args: any[]) => unknown;

/**
 * The state of one select, which is also the handler of its proxy.
 * The proxy reads the target, and routes writes to slots. */
class Select {
  readonly state: any;
  #channel: Channel<any>;
  #isArray: boolean;
  #target: any;
  #array: Slot[] = [];
  #map!: Map<PropertyKey, Slot>; // The slots of an object shape
  #backPressure: boolean;
  #anyAck: boolean; // Under "all", only snapshot consumers release a flush (SE-04A)
  #stale = false; // A flush with no consumer built no snapshot of its change (SE-045)
  #shown = false; // An attach sent a snapshot of each change so far, so the next flush publishes none
  #hold?: PromiseWithResolvers<void>; // The wait of step 4, which an attach ends
  #unwrap: boolean;
  #hook?: (ops: Op[]) => void; // The report hook, which is no observer
  #fault?: (error: unknown) => void;
  #returns: boolean; // A delete returns the iterator of its slot (SE-128)
  #mapSnapshot?: (snapshot: unknown) => unknown;
  // A flush walks only these worklists, so one change costs no walk of the shape (SE-048).
  // Each worklist exists from its first slot on, so a select of plain values makes none.
  #raws?: Set<Slot>; // Raw iterators, which step 1 advances
  #ready?: Set<Slot>; // Async iterators that step 6 pulls
  #results?: Map<Slot, boolean>; // Slots with a result since the last step 2 (SE-061), and if it came from a yielded promise
  #watched?: Set<Slot>; // Slots that may keep an autoClose select open, which step 7 prunes, and undefined with no autoClose
  #keyOrder = 0; // The order of the next new object key
  #log: Log;
  #phase = NEW;
  #changed = true; // Changes to report and publish, which a silent update does not make
  #sorting = false;
  #emit?: Emit;
  #bound?: Record<PropertyKey, (...args: unknown[]) => unknown>; // Array methods of the proxy, made at first read
  #iterate = () => this.#channel[Symbol.asyncIterator]();
  #dispose = () => this.#channel[Symbol.dispose]();

  /** Array methods of an array proxy, which change the shape through splice and permute. */
  static #methods: Record<PropertyKey, Method> = {
    __proto__: null as any,
    push: (s: Select, ...items: unknown[]) => {
      s.#splice(s.#target.length, 0, items);
      return s.#target.length;
    },
    pop: (s: Select) =>
      s.#splice(s.#target.length - 1, Math.min(s.#target.length, 1), [])[0],
    shift: (s: Select) => s.#splice(0, Math.min(s.#target.length, 1), [])[0],
    unshift: (s: Select, ...items: unknown[]) => {
      s.#splice(0, 0, items);
      return s.#target.length;
    },
    splice: (s: Select, ...args: unknown[]) => {
      const size = s.#target.length,
        begin = position(args[0], size);
      const count = !args.length
        ? 0
        : args.length === 1
          ? size - begin
          : Math.min(Math.max(integer(args[1]), 0), size - begin);
      return s.#splice(begin, count, args.slice(2));
    },
    fill: (s: Select, source: unknown, from?: unknown, to?: unknown) => {
      const size = s.#target.length,
        begin = position(from, size),
        end = to === undefined ? size : position(to, size),
        count = Math.max(end - begin, 0);
      quiet(source); // SE-034 holds for an empty range too
      s.#splice(begin, count, blanks(count).fill(source));
      return s.state;
    },
    sort: (s: Select, compare?: (a: any, b: any) => number) => {
      s.#checkCompare(compare);
      return s.#arrange(s.#target, compare);
    },
    sortOutputs: (s: Select, compare?: (a: any, b: any) => number) => {
      s.#checkCompare(compare);
      if (s.#terminal) throw new TypeError("sortOutputs needs a live channel");
      return s.#arrange(
        s.#array.map(slot => s.#out(slot)),
        compare,
      );
    },
    reverse: (s: Select) =>
      s.#permute(
        s.#target.map((_: unknown, i: number) => s.#target.length - 1 - i),
      ),
    copyWithin: (s: Select, to: unknown, from: unknown, until?: unknown) => {
      const size = s.#target.length,
        begin = position(to, size),
        first = position(from, size),
        end = until === undefined ? size : position(until, size),
        count = Math.min(end - first, size - begin);
      if (begin !== first)
        s.#splice(
          begin,
          Math.max(count, 0),
          s.#target.slice(first, first + count),
        );
      return s.state;
    },
  };

  constructor(shape: any, options: any, channel: Channel<any>) {
    const {
      autoStart = false,
      autoClose = false,
      backPressure = true,
      unwrap = false,
      mapSnapshot,
      [REPORT]: hook,
      [FAULT]: fault,
      [RETURNS]: returns = false,
    } = options;
    if (autoClose) this.#watched = new Set();
    this.#backPressure = backPressure;
    this.#anyAck = options.ackStyle !== "all";
    this.#unwrap = unwrap;
    this.#hook = hook;
    this.#fault = fault;
    this.#returns = returns;
    this.#mapSnapshot = mapSnapshot;
    this.#channel = channel;
    this.#isArray = Array.isArray(shape);
    const target = this.#isArray ? Array.from(shape) : { ...shape };
    this.#target = target;
    this.#log = new Log(hook && []);
    if (this.#isArray)
      for (const source of target)
        this.#array.push(
          this.#make(source, undefined, this.#array.length, detect(source)),
        );
    else {
      this.#map = new Map();
      for (const key of Reflect.ownKeys(target))
        this.#map.set(
          key,
          this.#make(target[key], key, this.#rank(key), detect(target[key])),
        );
    }
    onEnd(channel, () => this.#abort());
    onAttach(channel, () => this.#join());
    if (autoStart) queueMicrotask(() => this.#start());
    else attached(channel).then(() => this.#start(), noop);
    this.state = new Proxy(target, this);
  }

  /** Takes the devtools emitter, which reads the operations too (DV-030). */
  connect(emit: Emit | undefined) {
    this.#emit = emit;
    // Stryker disable next-line ConditionalExpression: a log that no one reads only records operations that the next flush drops
    if (emit) this.#log.pending ??= [];
    this.#log.kept = !!this.#hook || !!emit;
  }

  /** Describes the slots for devtools. */
  describe() {
    return this.#slots().map(slot => ({
      key: this.#keyOf(slot),
      kind: KINDS[slot.kind],
      sync: SYNC[slot.kind],
      source: slot.source,
      state: slot.state,
      busy: slot.status === BUSY || slot.status === FINAL,
      finished: slot.status >= FINAL,
    }));
  }

  /** Throws a `TypeError` for keys that do not name slots of this shape (SE-150). */
  check(keys: unknown) {
    if (!Array.isArray(keys))
      throw new TypeError("changes keys must be an array");
    const isArray = this.#isArray;
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
    // A key slice follows its keys, so with none it would wait for good.
    if (!isArray && !keys.length)
      throw new TypeError("An object slice takes at least one key");
  }

  /** Opens a reader of the log, or of a slice of it. */
  open(keys?: readonly PropertyKey[]): Changes<unknown> {
    const slice = keys && this.#view(keys);
    return new Reader(
      this.#log,
      this.#channel,
      this.state,
      keys,
      slice,
      slice ? slice.outputs : this.outputs(),
      this.#request,
    );
  }

  /** Gives a copy of the outputs, which is empty before start (SE-142). */
  outputs() {
    return this.#started ? this.#snapshot() : this.#isArray ? [] : {};
  }

  /** Starts the select in a microtask at the first read of a reader, as a consumer does (SE-037). */
  #request = () => {
    // Stryker disable next-line ConditionalExpression: an optimization, because #start checks again
    if (this.#started) return;
    queueMicrotask(() => this.#start());
  };

  get(_: unknown, key: PropertyKey) {
    if (key === Symbol.asyncIterator) return this.#iterate;
    if (key === Symbol.dispose) return this.#dispose;
    if (key === CHAN) return this.#channel;
    const value = (this.#target as any)[key];
    // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: an optimization, because an entry that is no function names no method
    if (value !== undefined && typeof value !== "function") return value;
    return this.#isArray && key in Select.#methods ? this.#method(key) : value;
  }

  has(_: unknown, key: PropertyKey) {
    return (
      RESERVED.includes(key) ||
      (this.#isArray && key in Select.#methods) ||
      Reflect.has(this.#target, key)
    );
  }

  set(_: unknown, key: PropertyKey, value: unknown) {
    this.#assign(key, value);
    return true;
  }

  deleteProperty(_: unknown, key: PropertyKey) {
    return this.#remove(key);
  }

  defineProperty(): boolean {
    return forbid("defineProperty");
  }

  preventExtensions(): boolean {
    return forbid("preventExtensions");
  }

  setPrototypeOf(): boolean {
    return forbid("setPrototypeOf");
  }

  /** Gives an array method that works on this select, and makes it one time. */
  #method(key: PropertyKey) {
    const bound = (this.#bound ??= { __proto__: null } as any);
    return (bound[key] ??= (...args: unknown[]) =>
      (Select.#methods[key] as Method)(this, ...args));
  }

  /** Tells if the channel is terminal. */
  get #terminal() {
    return terminal(this.#channel);
  }

  /** Tells if the select started. */
  get #started() {
    return this.#phase !== NEW;
  }

  /** Gives a copy of the slots in shape order. */
  #slots() {
    return this.#isArray
      ? [...this.#array]
      : [...this.#map.values()].sort(byIndex);
  }

  /** Gives the output of a slot: its `Val`, or its value under `unwrap`. */
  #out(slot: Slot) {
    return this.#unwrap && slot.kind !== PLAIN ? slot.state.value : slot.state;
  }

  /** Records an operation, if anyone reads operations and the select started. */
  #record(op: () => Op) {
    if (this.#log.pending && this.#started) this.#log.pending.push(op()); // SE-10A
  }

  /** Gives the rank of a new object key, as a plain object orders its keys (SE-047). */
  #rank(key: PropertyKey) {
    const order = this.#keyOrder++;
    return typeof key === "symbol"
      ? SYMBOLS + order
      : (toIndex(key) ?? STRINGS + order);
  }

  /** Gives the current key or index of a slot. */
  #keyOf(slot: Slot) {
    return this.#isArray ? slot.index : (slot.key as string);
  }

  /** Lets step 7 check a slot, with autoClose. */
  #watch(slot: Slot) {
    this.#watched?.add(slot);
  }

  /** Marks a slot busy, or busy with its final result, so autoClose waits for it. */
  #occupy(slot: Slot, final = false) {
    slot.status = final ? FINAL : BUSY;
    this.#watch(slot);
  }

  /** Queues one flush in a microtask, unless one is queued or running. */
  #schedule() {
    if (this.#phase !== IDLE || !this.#started || this.#terminal) return;
    this.#phase = QUEUED;
    queueMicrotask(() => this.#flush());
  }

  /** Marks the state changed, and schedules a flush. */
  #touch() {
    this.#changed = true;
    this.#shown = false;
    this.#schedule();
  }

  /** Sets the state of a live slot, and logs and schedules the change once started. */
  #update(slot: Slot, state: Val<unknown>, silent = false) {
    if (slot.dead) return;
    const prev = this.#out(slot);
    slot.state = state;
    if (!this.#started) return;
    if (this.#unwrap && state.status === "rejected")
      return this.#channel.throw(state.reason);
    if (silent) return this.#schedule(); // SE-02B
    this.#record(() => ({
      op: "set",
      key: this.#keyOf(slot),
      value: this.#out(slot),
      prev,
      kept: true, // The slot stays, so a mirror updates its entry (HE-04H)
    }));
    this.#touch();
  }

  /** Finishes a slot with a rejected state, and calls `return()` on its iterator when its value failed. */
  #fail(slot: Slot, error: unknown, valueFailed = false) {
    const open = slot.status < FINAL;
    slot.status = FINISHED;
    if (slot.dead) return this.#fault?.(error); // SE-124, SE-126
    if (valueFailed && open) void quietReturn(slot.iterator, this.#fault);
    this.#update(slot, val("rejected", undefined, error, true));
  }

  /** Sets a fulfilled state from an iterator result, and keeps the last value for an empty final result. */
  #commit(slot: Slot, value: unknown, done: boolean, awaited: boolean) {
    slot.status = done ? FINISHED : OPEN;
    if (slot.dead) return; // No flush follows, so a worklist would retain the slot (SE-049)
    (this.#results ??= new Map()).set(slot, awaited);
    (this.#ready ??= new Set()).add(slot);
    const kept = value === undefined && done;
    this.#update(
      slot,
      val("fulfilled", kept ? slot.state.value : value, undefined, done),
      kept && this.#unwrap,
    );
  }

  /** Checks an iterator result, and commits its value now, or after a yielded promise settles. */
  #receive(slot: Slot, result: any) {
    if (Object(result) !== result)
      throw new TypeError("Iterator result is not an object");
    const done = !!result.done,
      value = result.value;
    if (done) slot.status = FINISHED;
    let thenable: boolean;
    try {
      thenable = isThenable(value);
    } catch (error) {
      return this.#fail(slot, error, true); // Awaiting this value would reject, so it counts as SE-02A
    }
    if (!thenable) return this.#commit(slot, value, done, false);
    this.#occupy(slot, done);
    Promise.resolve(value).then(
      settled => this.#commit(slot, settled, done, true),
      error => this.#fail(slot, error, true),
    );
  }

  /** Calls `next` on the iterator of a slot, and learns on the first call if it is sync. */
  #pull(slot: Slot) {
    let result: any;
    try {
      // A drive binds what a pull opens to its source (JX-041), and an emitter names the source.
      result =
        // Stryker disable next-line ConditionalExpression,LogicalOperator: without a drive, pulling only binds to a source that no host releases
        this.#emit || this.#hook
          ? pulling(slot.source, () => slot.next.call(slot.iterator))
          : slot.next.call(slot.iterator);
      const thenable = isThenable(result);
      if (slot.kind === RAW) slot.kind = thenable ? ASYNC_RAW : SYNC_RAW;
      if (thenable && slot.kind === SYNC_RAW) {
        quiet(result);
        return this.#fail(
          slot,
          new TypeError("Sync iterator returned a thenable"),
          true,
        ); // SE-02A
      }
      if (slot.kind === SYNC_RAW) return this.#receive(slot, result);
    } catch (error) {
      return this.#fail(slot, error);
    }
    this.#occupy(slot);
    Promise.resolve(result)
      .then(settled => this.#receive(slot, settled))
      .catch(error => this.#fail(slot, error));
  }

  /** Subscribes to a promise slot, and updates it when the promise settles. */
  #listen(slot: Slot) {
    const { source, method: then } = slot;
    const fulfilled = (value: unknown) =>
      this.#update(slot, val("fulfilled", value, undefined, true));
    const rejected = (reason: unknown) =>
      slot.dead
        ? this.#fault?.(reason) // SE-124, SE-126
        : this.#update(slot, val("rejected", undefined, reason, true));
    quiet(source);
    if (source instanceof Promise && then === Promise.prototype.then)
      then.call(source, fulfilled, rejected);
    // Calling then() synchronously keeps it off a channel that turns terminal a microtask later.
    else
      new Promise((resolve, reject) => then.call(source, resolve, reject)).then(
        fulfilled,
        rejected,
      );
  }

  /** Creates a slot for a source, and listens to a native promise at once. */
  #make(
    source: unknown,
    key: PropertyKey | undefined,
    index: number,
    { kind, method }: Detected,
  ): Slot {
    const slot: Slot = {
      key,
      index,
      source,
      kind,
      method,
      state: kind ? val("pending", undefined, undefined, false) : source,
      status: OPEN,
    };
    if (kind === RAW) (this.#raws ??= new Set()).add(slot);
    // Stryker disable next-line ConditionalExpression: step 7 prunes a watched slot that is not live
    if (kind === PROMISE) this.#watch(slot);
    if (kind === PROMISE && source instanceof Promise) this.#listen(slot);
    return slot;
  }

  /** Opens the iterator or the promise of a slot, when the select starts or the slot arrives after. */
  #activate(slot: Slot) {
    if (slot.dead) return;
    if (slot.kind === RAW) {
      slot.iterator = slot.source;
      slot.next = slot.method;
    } else if (slot.kind === PROMISE && !(slot.source instanceof Promise))
      this.#listen(slot);
    else if (slot.kind === ASYNC) {
      try {
        slot.iterator = slot.method.call(slot.source);
        slot.next = slot.iterator.next;
        (this.#ready ??= new Set()).add(slot);
      } catch (error) {
        this.#fail(slot, error);
      }
    }
  }

  /** Starts the select, logs the initial shape, and activates all slots. */
  #start() {
    if (this.#started) return; // A consumer and a reader can both start it
    this.#phase = IDLE;
    this.#emit?.("start");
    const all = this.#slots();
    if (!this.#isArray)
      for (const slot of all)
        this.#record(() => ({
          op: "set",
          key: this.#keyOf(slot),
          value: this.#out(slot),
          prev: undefined,
        }));
    else if (all.length)
      this.#record(() => ({
        op: "splice",
        start: 0,
        removed: [],
        added: all.map(slot => this.#out(slot)),
      }));
    for (const reader of alive(this.#log.readers))
      beginReader(reader, all.length);
    // Stryker disable next-line MethodExpression,CallExpression: a log with no reader left only stops sooner (SE-14C)
    this.#log.trim();
    const rejected =
      this.#unwrap &&
      all.find(slot => slot.kind !== PLAIN && slot.state.status === "rejected");
    if (rejected) this.#channel.throw(rejected.state.reason);
    for (const slot of all) this.#activate(slot);
    this.#schedule();
  }

  /** Ends a wait of step 4, and sends a snapshot of a change that no consumer saw, before the new consumer starts (SE-045). */
  #join() {
    this.#hold?.resolve();
    if (!this.#stale || this.#terminal) return;
    this.#stale = false;
    this.#shown = true;
    try {
      this.#channel.send(this.#publishable());
    } catch (error) {
      this.#channel.throw(error);
    }
  }

  /** Builds a snapshot, and maps it with mapSnapshot. */
  #publishable() {
    const snap = this.#snapshot();
    return this.#mapSnapshot ? this.#mapSnapshot(snap) : snap;
  }

  /** Marks every slot dead, returns the iterators, and wakes the readers, when the channel turns terminal. */
  #abort() {
    this.#hold?.resolve();
    for (const slot of this.#slots()) {
      slot.dead = true;
      this.#close(slot);
    }
    for (const reader of this.#log.all()) wakeReader(reader); // SE-14A
  }

  /** Calls `return()` on the iterator of a slot that is not finished, or on its source before start (SE-120, SE-125). */
  #close(slot: Slot) {
    if (slot.kind >= ASYNC && slot.status < FINAL)
      void quietReturn(slot.iterator ?? slot.source, this.#fault);
  }

  /** Gives the outputs of all slots, in the shape of the target. */
  #snapshot() {
    if (this.#isArray) return this.#array.map(slot => this.#out(slot));
    const entries: [PropertyKey, unknown][] = [];
    for (const [key, slot] of this.#map) entries.push([key, this.#out(slot)]);
    return Object.fromEntries(entries);
  }

  /**
   * Gives the raw iterators that step 1 advances, in shape order, and forgets the ones that cannot change.
   * An idle async raw iterator is always fresh here, because step 6 pulls it right after each report. */
  #due() {
    const list: Slot[] = [],
      raws = this.#raws;
    if (raws)
      for (const slot of raws) {
        // Stryker disable next-line ConditionalExpression,EqualityOperator: the shape keeps a finished slot anyway, so forgetting it only saves walks
        if (slot.dead || slot.status >= FINAL) raws.delete(slot);
        else if (this.#advancing(slot)) list.push(slot);
      }
    return list.sort(byIndex);
  }

  /** Tells if step 1 of a flush pulls a raw iterator before the report, which SE-061 skips after a result. */
  #advancing(slot: Slot) {
    return idle(slot) && !this.#results?.has(slot);
  }

  /** Advances sources, reports operations, publishes a snapshot, pulls the next values, and closes with autoClose. */
  async #flush() {
    this.#phase = RUNNING;
    const channel = this.#channel;
    let sent: Promise<void> | undefined;
    try {
      // SE-046: terminal marks every slot dead, so idle() checks steps 1, 5 and 6, and steps 7 and 8 do nothing.
      // SE-043: a step 1 change belongs to this flush, so repeat for slots it added, and fresh stops a second advance.
      for (let list: Slot[]; (list = this.#due()).length; )
        for (const slot of list) if (this.#advancing(slot)) this.#pull(slot);
      if (this.#terminal) return;
      const publish = this.#changed && !this.#shown;
      this.#changed = false;
      // SE-064 applies to these in step 5
      const results = this.#results,
        settled =
          results &&
          [...results].filter(([, awaited]) => awaited).map(([slot]) => slot);
      this.#results = undefined;
      this.#log.read = false;
      const report = this.#log.take();
      if (report) {
        this.#emit?.("report", report);
        this.#log.publish(report);
        const parked = this.#hook?.(report);
        if (parked) await parked; // A parked drive holds the next pulls (JX-083)
      }
      if (this.#terminal) return;
      if (publish) {
        // With no consumer, no code reads a snapshot, so the flush builds none (SE-045).
        if (!consumed(channel)) this.#stale = true;
        else {
          this.#stale = false;
          const value = this.#publishable();
          if (this.#backPressure) sent = channel.asend(value);
          else channel.send(value);
        }
        // SE-04A: a reader that reads the report observes this flush too, and SE-045: an attach ends the wait.
        if (this.#backPressure && !(this.#anyAck && this.#log.read)) {
          const hold = (this.#hold = this.#anyAck
            ? this.#log.seen()
            : Promise.withResolvers());
          sent?.then(hold.resolve, hold.reject);
          await hold.promise;
          this.#hold = undefined;
          if (this.#terminal) return; // A close ends the wait too
        }
      }
      if (settled)
        for (const slot of settled.sort(byIndex))
          if (slot.kind === SYNC_RAW && idle(slot)) this.#pull(slot);
      const ready = this.#ready;
      if (ready)
        // SE-04D: a result after step 2 waits for the next report, so no observer missed it
        for (const slot of drain(ready))
          if ((this.#results as Map<Slot, boolean> | undefined)?.has(slot))
            ready.add(slot);
          else if (slot.kind !== SYNC_RAW && idle(slot)) this.#pull(slot); // Only iterators with a known kind reach ready
      const watched = this.#watched;
      if (watched && !this.#changed) {
        for (const slot of watched)
          if (slot.dead || !live(slot)) watched.delete(slot);
        if (!watched.size) {
          // SE-075: a reader can release the flush before a consumer reads the publish, which stays pending
          if (sent) {
            await sent; // A close rejects it
            if (this.#changed) return;
          }
          // A late consumer of a closed select reads its last snapshot, and a drive has none (SE-045).
          if (this.#stale && !this.#hook) channel.send(this.#publishable());
          channel.close();
        }
      }
    } catch (error) {
      channel.throw(error); // A no-op for this channel's own stop error
    } finally {
      this.#phase = IDLE;
      if (this.#changed) this.#schedule();
    }
  }

  /** Writes a source to the target as a plain data property. */
  #define(key: any, source: unknown) {
    // Stryker disable next-line ConditionalExpression: an array write has a data property at its index already
    if (this.#isArray) this.#target[key] = source;
    else
      Reflect.defineProperty(this.#target, key, {
        value: source,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }

  /** Throws if a sort comparator tries to change the proxy. */
  #unlocked() {
    if (this.#sorting)
      throw new TypeError("A comparator cannot change a select proxy");
  }

  /** Replaces the source at a key with a new slot, and logs a set. */
  #write(key: any, source: unknown) {
    this.#unlocked();
    if (this.#terminal) {
      this.#define(key, source);
      return quiet(source);
    }
    const detected = detect(source); // SE-016 throws before anything changes
    const old = this.#isArray ? this.#array[key] : this.#map.get(key);
    const slot = this.#make(
      source,
      key,
      old?.index ?? this.#rank(key),
      detected,
    ); // An array write always has an old slot
    const prev = old && this.#out(old);
    this.#define(key, source);
    if (old) old.dead = true;
    if (this.#isArray) this.#array[key] = slot;
    else this.#map.set(key, slot);
    this.#record(() => ({ op: "set", key, value: this.#out(slot), prev }));
    this.#touch();
    if (this.#started) this.#activate(slot);
  }

  /** Sets the index of each array slot from start on. */
  #renumber(start: number) {
    const array = this.#array;
    for (let i = start; i < array.length; i++) (array[i] as Slot).index = i;
  }

  /** Replaces a range of an array shape with new slots, logs a splice, and gives the removed sources. */
  #splice(start: number, count: number, items: unknown[]) {
    if (!count && !items.length) return [];
    this.#unlocked();
    if (this.#terminal) {
      items.forEach(quiet);
      return replace(this.#target, start, count, items);
    }
    const detected = items.map(item => detect(item)); // SE-016 throws before anything changes
    const added = items.map((item, index) =>
      this.#make(item, undefined, start + index, detected[index] as Detected),
    );
    const removed = replace(this.#target, start, count, items);
    const gone = replace(this.#array, start, count, added);
    this.#renumber(start + items.length);
    this.#record(() => ({
      op: "splice",
      start,
      removed: gone.map(slot => this.#out(slot)),
      added: added.map(slot => this.#out(slot)),
    }));
    for (const slot of gone) slot.dead = true;
    this.#touch();
    if (this.#started) for (const slot of added) this.#activate(slot);
    return removed;
  }

  /** Reorders an array shape and its slots, and logs a move. */
  #permute(order: number[]) {
    this.#unlocked();
    if (order.every((from, to) => from === to)) return this.state; // SE-097
    relocate(this.#target, order);
    // Stryker disable next-line ConditionalExpression: slots and operations are unobservable on a terminal channel
    if (this.#terminal) return this.state;
    relocate(this.#array, order);
    this.#renumber(0);
    this.#record(() => ({ op: "move", order }));
    this.#touch();
    return this.state;
  }

  /** Checks a sort comparator, and that no sort is running. */
  #checkCompare(compare?: (a: any, b: any) => number) {
    if (compare !== undefined && typeof compare !== "function")
      throw new TypeError("sort comparator must be a function");
    this.#unlocked();
  }

  /** Sorts by items with compare, and locks the proxy while compare runs. */
  #arrange(items: unknown[], compare?: (a: any, b: any) => number) {
    let order: number[];
    this.#sorting = true;
    try {
      order = ranked(items, compare);
    } finally {
      this.#sorting = false;
    }
    return this.#permute(order);
  }

  /** Sets the length of an array shape, with a splice. */
  #resize(value: unknown) {
    const length = +(value as number), // Unlike Number(), this throws on a BigInt
      size = this.#target.length;
    if (length >>> 0 !== length) throw new RangeError("Invalid array length");
    // Stryker disable next-line EqualityOperator,ArithmeticOperator: an equal length splices nothing on either branch, and splice clamps a larger count
    if (length < size) this.#splice(length, size - length, []);
    else this.#splice(size, 0, blanks(length - size));
  }

  /** Handles a proxy write, which skips an `Object.is` same source. */
  #assign(key: PropertyKey, source: unknown) {
    if (RESERVED.includes(key)) throw new TypeError("Reserved select key");
    const target = this.#target;
    if (!this.#isArray) {
      if (!Object.hasOwn(target, key) || !Object.is(target[key], source))
        this.#write(key, source);
    } else if (key === "length") this.#resize(source);
    else {
      const index = toIndex(key);
      if (index === undefined)
        throw new TypeError("An array shape accepts index keys only");
      if (index >= target.length)
        this.#splice(target.length, 0, [
          ...blanks(index - target.length),
          source,
        ]);
      else if (!Object.is(target[index], source)) this.#write(index, source);
    }
  }

  /** Handles a proxy delete, which sets an array item to undefined and deletes an object key. */
  #remove(key: PropertyKey) {
    if (RESERVED.includes(key)) throw new TypeError("Reserved select key");
    const target = this.#target;
    if (this.#isArray) {
      const index = toIndex(key);
      if (index === undefined) return Reflect.deleteProperty(target, key);
      if (index < target.length) this.#assign(key, undefined);
      return true;
    }
    if (!Object.hasOwn(target, key)) return true;
    delete target[key];
    if (this.#terminal) return true;
    // biome-ignore lint/style/noNonNullAssertion: an own key has a slot until the channel ends
    const slot = this.#map.get(key)!;
    this.#record(() => ({
      op: "delete",
      key: key as string,
      prev: this.#out(slot),
    }));
    slot.dead = true;
    if (this.#returns) this.#close(slot);
    this.#map.delete(key);
    this.#touch();
    return true;
  }

  /** Gives the outputs and the operation rewrite of a slice reader. */
  #view(keys: readonly PropertyKey[]): View {
    if (!this.#isArray) {
      const names = new Set<PropertyKey>(
        keys.map(key => (typeof key === "number" ? `${key}` : key)),
      );
      return new KeySlice(
        this.#started
          ? Object.fromEntries(
              [...this.#map]
                .filter(([key]) => names.has(key))
                .map(([key, slot]) => [key, this.#out(slot)]),
            )
          : {},
        names,
      );
    }
    const wanted = [...new Set(keys as number[])].sort((a, b) => a - b);
    const at = this.#started
      ? wanted.filter(index => index < this.#array.length)
      : undefined;
    return new IndexSlice(
      wanted,
      at,
      (at ?? []).map(index => this.#out(this.#array[index] as Slot)),
    );
  }
}

/** Tells if a slot can be pulled now. */
const idle = (slot: Slot) => !slot.dead && slot.status === OPEN;

/**
 * Tells if a slot can still change, which keeps an autoClose select open.
 * Step 6 has just pulled every idle async iterator, so an unfinished one is busy here. */
const live = (slot: Slot) =>
  slot.kind === PROMISE
    ? slot.state.status === "pending"
    : slot.status === BUSY || slot.status === FINAL;

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
  checkOptions(options, OPTION_TYPES, CHOICES);
  const {
    thenReceive = "latest",
    stopStyle,
    ackStyle,
    firstReceive = thenReceive === "unread" ? "unread" : "latest",
  } = options;
  const channel = new Channel<any>({
    firstReceive,
    thenReceive,
    stopStyle,
    ackStyle,
  });
  const core = new Select(shape, options, channel),
    { state } = core;
  openers.set(state, core);
  // Here, so the hook finds the caller at its fixed depth (DV-003).
  core.connect(
    register("select", state, {
      channel,
      array: Array.isArray(shape),
      unwrap: !!options.unwrap,
      slots: () => core.describe(),
    }),
  );
  return state;
}
