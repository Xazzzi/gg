import {
  attached,
  CHOICES,
  Channel,
  type ChannelOptions,
  failed,
  onEnd,
  resultOf,
  terminal,
} from "./channel.ts";
import { type Emit, pulledSource, pulling, register } from "./devtools.ts";
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
  mapSnapshot?: (snapshot: S) => R;
  [REPORT]?: (ops: Op[]) => void;
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
  return new Watcher(opener, key);
}

/** The reader of `watch`, which reads one slot from a slice reader. */
class Watcher implements Watch<unknown> {
  #select: Select;
  #key: PropertyKey;
  #reader?: Changes<any>;
  #current: unknown; // The last output that the reads give the slot
  #last: unknown;
  #given = false; // SE-163 compares with the last given output
  #present?: boolean; // Set when the reader opens
  #done = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(select: Select, key: PropertyKey) {
    this.#select = select;
    this.#key = key;
  }

  next(): Promise<IteratorResult<unknown, undefined>> {
    if (!this.#reader && !this.#done) this.#begin();
    const result = this.#tail.then(() => this.#step()); // SE-166
    this.#tail = result.catch(noop);
    return result;
  }

  return(): Promise<IteratorReturnResult<undefined>> {
    this.#stop();
    return Promise.resolve(finished);
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  [Symbol.dispose]() {
    this.#stop();
  }

  /** Opens the reader at the first next(), so an index names the slot at that call (SE-161). */
  #begin() {
    const reader = this.#select.open([this.#key]) as Changes<any>,
      { outputs } = reader;
    const values = Array.isArray(outputs)
      ? outputs
      : Reflect.ownKeys(outputs).map(name => outputs[name]);
    this.#reader = reader;
    this.#present = values.length > 0;
    this.#current = values[0];
  }

  /** Reads until the slot has a new output, or the reader finishes. */
  async #step(): Promise<IteratorResult<unknown, undefined>> {
    if (this.#done) return finished;
    while (
      !this.#present ||
      (this.#given && Object.is(this.#current, this.#last))
    ) {
      // A rejection finishes the reader, so later reads end (SE-14A)
      const result = await (this.#reader as Changes<any>).next();
      if (result.done || this.#done) return finished; // SE-165 for a read that settled before return(), and a finished reader stays finished
      for (const op of result.value as any[])
        if (op.op === "set") {
          this.#current = op.value;
          this.#present = true;
        } else if (op.op === "delete" || op.removed.length)
          this.#present = false;
        else {
          this.#current = op.added[0]; // SE-155 describes the slot, and one slot never moves
          this.#present = true;
        }
      if (!this.#present) {
        this.#stop(); // SE-164
        return finished;
      }
    }
    this.#given = true;
    this.#last = this.#current;
    return { done: false, value: this.#current };
  }

  /** Finishes watch and its reader, which settles a waiting read. */
  #stop() {
    this.#done = true;
    void this.#reader?.return();
  }
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
  nonYielding: "boolean",
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
  index: number; // The position of an array slot, or the order of an object key in the map
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

/** Takes the slots of a worklist in shape order, and empties it. */
const drain = (set: Set<Slot>) => {
  const list = [...set].sort(byIndex);
  set.clear();
  return list;
};

/**
 * The operations of a select: the ones since the last report, and the reported ones that a reader did not read.
 * SE-14B drops what each reader read, and SE-14C stops the log with no reader. */
class Log {
  pending?: Op[]; // Undefined while no one reads operations
  // Stryker disable next-line ArrayDeclaration: a reader starts after all that the log holds
  reported: Op[] = []; // From the absolute index base
  base = 0;
  readers = new Set<Reader>(); // The readers that each publish wakes
  named?: Map<PropertyKey, Set<Reader>>; // The readers of key slices, which a publish wakes by key
  parked?: Set<Reader>; // The readers with a read that waits, which observe each report (SE-04A)
  kept?: boolean; // The report hook or devtools read each report, which connect sets
  read?: boolean; // A reader read or waited since the flush cleared it, so the flush was observed (SE-04A)
  #seen?: PromiseWithResolvers<void>;
  #last?: Op[]; // The report that publish gives the readers now
  #keyed?: Keyed | null;

  constructor(pending?: Op[]) {
    this.pending = pending;
  }

  /** Marks a reader that read, or that waits with nothing to read, and releases a flush that waits for one. */
  observe() {
    this.read = true;
    this.#seen?.resolve();
    this.#seen = undefined;
  }

  /** Gives a promise that the next observing reader resolves, and one for each wait, so no wait retains an earlier one. */
  seen() {
    return (this.#seen = Promise.withResolvers());
  }

  /** The absolute index after the last reported operation. */
  get end() {
    return this.base + this.reported.length;
  }

  /** The absolute index of the report that publish gives the readers now, or the end outside a publish. */
  get start() {
    return this.end - (this.#last?.length ?? 0);
  }

  /** Tells if no reader is attached. */
  get empty() {
    return !this.readers.size && !this.named?.size;
  }

  /** Attaches a reader, by name when it reads a key slice. */
  add(reader: Reader, names?: Set<PropertyKey>) {
    // Stryker disable next-line ConditionalExpression: a key slice among the readers that each publish wakes reads the same operations
    if (!names?.size) this.readers.add(reader);
    else {
      const named = (this.named ??= new Map());
      for (const name of names)
        named.get(name)?.add(reader) ?? named.set(name, new Set([reader]));
    }
  }

  /** Detaches a reader, and tells if it was attached. */
  remove(reader: Reader, names?: Set<PropertyKey>) {
    const named = this.named;
    if (!names?.size || !named) return this.readers.delete(reader);
    let had: boolean | undefined; // Each name has the reader, or none has
    for (const name of names) {
      const readers = named.get(name);
      had = readers?.delete(reader);
      if (readers?.size === 0) named.delete(name);
    }
    return had;
  }

  /** Gives each attached reader one time. */
  all() {
    const all = new Set(this.readers);
    for (const readers of this.named?.values() ?? [])
      for (const reader of readers) all.add(reader);
    return all;
  }

  /** Gives the reported operations from an absolute index on. */
  from(at: number) {
    return this.reported.slice(at - this.base);
  }

  /** Takes the operations since the last report, if there are any. */
  take() {
    const report = this.pending;
    if (!report?.length) return undefined;
    this.pending = [];
    return report;
  }

  /** Makes a report readable to the readers, and wakes them. */
  publish(report: Op[]) {
    // Stryker disable next-line ConditionalExpression: a log with no reader drops the report in trim
    if (this.empty) return;
    for (const op of report) this.reported.push(op); // A spread overflows the stack on a large report
    this.#last = report;
    for (const reader of this.readers) wakeReader(reader);
    // A key slice reads only its keys, so a report wakes no reader of other keys (SE-153).
    const due = new Set<Reader>();
    // Stryker disable next-line ConditionalExpression: with no key slice, no operation names a reader
    if (this.named?.size)
      for (const op of report)
        for (const reader of this.named.get((op as { key: PropertyKey }).key) ??
          [])
          due.add(reader);
    for (const reader of due) wakeReader(reader);
    if (this.parked?.size) this.observe(); // A reader that no key woke has nothing to read
    this.#last = this.#keyed = undefined; // SE-14B
    this.trim();
  }

  /**
   * Gives the places of the operations of the report by key, for a reader at its start, so a slice reads only its own.
   * Gives undefined outside a publish, and for a report with a splice or a move. */
  // Stryker disable next-line BlockStatement: with no report by key, a slice projects the report
  keyed(at: number) {
    const report = this.#last;
    // Stryker disable next-line ConditionalExpression: with no report by key, a slice projects the report
    if (!report) return undefined;
    // Stryker disable next-line ConditionalExpression,ArithmeticOperator: with no report by key, a slice projects the report
    if (at !== this.end - report.length) return undefined;
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: with no report by key, a slice projects the report
    if (this.#keyed === undefined) {
      const places = new Map<PropertyKey, number[]>();
      this.#keyed = { report, places };
      // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: a slice with no place for its keys projects the report
      for (let place = 0; place < report.length; place++) {
        const op = report[place] as Op;
        // Stryker disable next-line ConditionalExpression,StringLiteral: with no report by key, a slice projects the report
        if (!("key" in op)) {
          this.#keyed = null;
          break;
        }
        // Stryker disable next-line LogicalOperator: a slice with no place for its keys projects the report
        places.get(op.key)?.push(place) ?? places.set(op.key, [place]);
      }
    }
    // Stryker disable next-line LogicalOperator: with no report by key, a slice projects the report
    return this.#keyed ?? undefined;
  }

  /** Drops operations after a reader read on from an index, which a publish does one time for all readers. */
  left(from: number) {
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: a reader above the base holds no operation
    if (!this.#last && from === this.base) this.trim();
  }

  /** Drops reported operations that every reader read. */
  trim() {
    // Stryker disable next-line ConditionalExpression: an empty log has nothing to drop
    if (this.reported.length) {
      let low = this.end;
      for (const reader of this.readers)
        low = Math.min(low, positionOf(reader));
      this.reported.splice(0, low - this.base);
      this.base = low;
    }
    if (this.empty && !this.kept) this.pending = undefined;
  }
}

// A report of only set and delete operations, with the places of the operations of each key.
type Keyed = { report: Op[]; places: Map<PropertyKey, number[]> };

/** The outputs of a slice reader, and how it rewrites operations to them (SE-152 to SE-156). */
type View = {
  readonly outputs: unknown;
  begin(length: number): void;
  project(list: Op[]): Op[];
  pick(keyed: Keyed): Op[] | undefined; // The same as project, for a slice of fewer slots than the report has keys
  readonly names?: Set<PropertyKey>; // The keys of a key slice, which the log wakes its reader by
  spent?(): boolean; // A key slice always has its slots
};

/** A slice of an object shape, which follows its keys, so it never runs out. */
class KeySlice implements View {
  readonly outputs: object;
  readonly names: Set<PropertyKey>;

  constructor(outputs: object, names: Set<PropertyKey>) {
    this.outputs = outputs;
    this.names = names;
  }

  begin() {}

  // Stryker disable next-line BlockStatement: project gives the same operations
  pick({ report, places }: Keyed) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: project gives the same operations
    if (this.names.size > places.size) return undefined;
    const found: number[] = [];
    for (const name of this.names)
      for (const place of places.get(name) ?? []) found.push(place);
    return found.sort((a, b) => a - b).map(place => report[place] as Op);
  }

  // An object shape logs only set and delete
  project(list: Op[]) {
    return list.filter(op => this.names.has((op as { key: PropertyKey }).key));
  }
}

/** A slice of an array shape, which keeps the ascending indexes of its slots, and follows them through each operation. */
class IndexSlice implements View {
  readonly outputs: unknown[];
  #wanted: number[];
  #at?: number[]; // Undefined until the select starts
  #describe = false;

  constructor(wanted: number[], at: number[] | undefined, outputs: unknown[]) {
    this.#wanted = wanted;
    this.#at = at;
    this.outputs = outputs;
  }

  /** Names the slots at start, which the first operation then describes (SE-155). */
  begin(length: number) {
    this.#at = this.#wanted.filter(index => index < length);
    this.#describe = true; // An empty slice is spent, so it never reads the description
  }

  project(list: Op[]) {
    const result: Op[] = [];
    for (const op of list) {
      const picked = this.#at as number[];
      if (this.#describe) {
        this.#describe = false;
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
        this.#at = picked.flatMap((index, j) => {
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
        this.#at = moved.map(([index]) => index);
        const order = moved.map(([, j]) => j);
        if (order.some((j, index) => j !== index))
          result.push({ op: "move", order });
      }
    }
    return result;
  }

  // A keyed report of an array shape holds only sets, which move no slot
  // Stryker disable next-line BlockStatement: project gives the same operations
  pick({ report, places }: Keyed) {
    const picked = this.#at as number[];
    // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: project gives the same operations
    if (this.#describe || picked.length > places.size) return undefined;
    const found: [number, number][] = [];
    picked.forEach((index, key) => {
      for (const place of places.get(index) ?? []) found.push([place, key]);
    });
    return found
      .sort((a, b) => a[0] - b[0])
      .map(([place, key]) => ({ ...report[place], key }) as Op);
  }

  spent() {
    return this.#at?.length === 0; // SE-156
  }
}

let positionOf: (reader: Reader) => number,
  wakeReader: (reader: Reader) => void,
  beginReader: (reader: Reader, length: number) => void;

/** A reader of the log, or of a slice of it, which takes its operations at each report (SE-157). */
class Reader implements Changes<unknown> {
  readonly outputs: unknown;
  #log: Log;
  #channel: Channel<any>;
  #slice?: View;
  #at: number; // The absolute index of the next operation to read
  #waiting: PromiseWithResolvers<IteratorResult<Op[], undefined>>[] = [];
  #taken: Op[] = []; // Slice operations that no read took yet
  #closed = false; // By return() or dispose, or by the SE-14A rejection
  #ended = false;
  #emit?: Emit;
  #start: () => void;

  static {
    positionOf = reader => reader.#at;
    wakeReader = reader => reader.#wake();
    beginReader = (reader, length) => reader.#begin(length);
  }

  constructor(
    log: Log,
    channel: Channel<any>,
    state: object,
    keys: readonly PropertyKey[] | undefined,
    slice: View | undefined,
    outputs: unknown,
    start: () => void,
  ) {
    this.outputs = outputs;
    this.#start = start;
    this.#log = log;
    this.#channel = channel;
    this.#slice = slice;
    this.#at = log.end;
    this.#emit = register("reader", this, {
      state,
      keys,
      source: pulledSource(),
    });
    if (slice?.spent?.())
      this.#end(); // SE-156 finishes a reader that names no slot
    else if (!terminal(channel)) {
      this.#at += log.pending?.length ?? 0;
      log.pending ??= [];
      log.add(this, slice?.names);
    }
  }

  next(): Promise<IteratorResult<Op[], undefined>> {
    this.#start(); // SE-037
    const read = Promise.withResolvers<IteratorResult<Op[], undefined>>();
    this.#waiting.push(read);
    this.#settle();
    return read.promise;
  }

  return(): Promise<IteratorReturnResult<undefined>> {
    this.#close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  [Symbol.dispose]() {
    this.#close();
  }

  /** Takes the operations of a report, and settles waiting reads. */
  #wake() {
    if (this.#slice) this.#take(this.#slice);
    this.#settle();
  }

  /** Names the slots of an array slice when the select starts. */
  #begin(length: number) {
    if (!this.#slice) return;
    this.#slice.begin(length);
    this.#wake();
  }

  /** Tells devtools one time that the reader finished or has no slot left (DV-051). */
  #end() {
    if (this.#ended) return;
    this.#ended = true;
    this.#emit?.("end");
  }

  /** Moves the reported operations after the position into the slice operations. */
  #take(slice: View) {
    // A key slice that earlier reports did not wake starts at this report.
    const log = this.#log,
      at = Math.max(this.#at, log.start),
      keyed = log.keyed(at);
    // Stryker disable next-line ConditionalExpression,LogicalOperator: project gives the same operations, and reads the whole report
    const ops = (keyed && slice.pick(keyed)) ?? slice.project(log.from(at));
    for (const op of ops) this.#taken.push(op);
    this.#at = log.end;
    if (slice.spent?.()) {
      // Stryker disable next-line BlockStatement,CallExpression: a spent reader reads past each later report, so this only stops the log sooner
      log.remove(this);
      this.#end();
    }
  }

  /** Gives the operations that a read takes, or undefined if none waits. */
  #read() {
    if (this.#slice)
      return this.#taken.length ? this.#taken.splice(0) : undefined;
    const log = this.#log,
      end = log.end;
    if (!log.readers.has(this) || this.#at >= end) return undefined;
    const at = this.#at,
      value = log.from(at);
    this.#at = end;
    log.left(at);
    return value;
  }

  /** Resolves waiting reads with new operations, or ends them when the reader closes. */
  #settle() {
    const channel = this.#channel;
    while (this.#waiting.length) {
      // biome-ignore lint/style/noNonNullAssertion: the loop runs while a read waits
      const next = this.#waiting[0]!,
        value = this.#read();
      if (value) {
        next.resolve({ done: false, value });
        this.#log.parked?.delete(this);
        this.#log.observe();
        this.#emit?.("read", value);
      } else if (
        !terminal(channel) &&
        !this.#closed &&
        !this.#slice?.spent?.()
      ) {
        // Stryker disable next-line ConditionalExpression: a reader that each publish wakes observes the report there
        if (this.#slice?.names) (this.#log.parked ??= new Set()).add(this);
        this.#log.observe(); // SE-04A: a reader with nothing to read observed all that concerns it
        return;
      } else {
        this.#log.parked?.delete(this);
        this.#log.remove(this, this.#slice?.names);
        this.#log.trim();
        if (!this.#closed && failed(channel)) next.reject(resultOf(channel));
        else next.resolve({ done: true, value: undefined });
        this.#closed = true;
        this.#end();
      }
      this.#waiting.shift();
    }
  }

  /** Stops the reader, and ends its waiting reads. */
  #close() {
    this.#closed = true;
    this.#end();
    this.#taken.length = 0;
    if (this.#log.remove(this, this.#slice?.names)) this.#log.trim();
    this.#settle();
  }
}

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
  #nonYielding: boolean;
  #unwrap: boolean;
  #hook?: (ops: Op[]) => void; // The report hook, which is no observer
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
      nonYielding = false,
      unwrap = false,
      mapSnapshot,
      [REPORT]: hook,
    } = options;
    if (autoClose) this.#watched = new Set();
    this.#backPressure = backPressure;
    this.#anyAck = options.ackStyle !== "all";
    this.#nonYielding = nonYielding;
    this.#unwrap = unwrap;
    this.#hook = hook;
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
          this.#make(target[key], key, this.#keyOrder++, detect(target[key])),
        );
    }
    onEnd(channel, () => this.#abort());
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
    return this.#isArray ? [...this.#array] : [...this.#map.values()];
  }

  /** Gives the output of a slot: its `Val`, or its value under `unwrap`. */
  #out(slot: Slot) {
    return this.#unwrap && slot.kind !== PLAIN ? slot.state.value : slot.state;
  }

  /** Records an operation, if anyone reads operations and the select started. */
  #record(op: () => Op) {
    if (this.#log.pending && this.#started) this.#log.pending.push(op()); // SE-10A
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
    }));
    this.#touch();
  }

  /** Finishes a slot with a rejected state, and calls `return()` on its iterator when its value failed. */
  #fail(slot: Slot, error: unknown, valueFailed = false) {
    const open = slot.status < FINAL;
    slot.status = FINISHED;
    if (slot.dead) return;
    if (valueFailed && open) void quietReturn(slot.iterator);
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
      // Stryker disable next-line ConditionalExpression: pulling only names the source for an emitter
      result = this.#emit
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
      this.#update(slot, val("rejected", undefined, reason, true));
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
    for (const reader of this.#log.readers) beginReader(reader, all.length);
    // Stryker disable next-line MethodExpression,CallExpression: a log with no reader left only stops sooner (SE-14C)
    this.#log.trim();
    const rejected =
      this.#unwrap &&
      all.find(slot => slot.kind !== PLAIN && slot.state.status === "rejected");
    if (rejected) this.#channel.throw(rejected.state.reason);
    for (const slot of all) this.#activate(slot);
    this.#schedule();
  }

  /** Marks every slot dead, returns the iterators, and wakes the readers, when the channel turns terminal. */
  #abort() {
    for (const slot of this.#slots()) {
      slot.dead = true;
      if (slot.kind >= ASYNC && slot.status < FINAL)
        void quietReturn(slot.iterator ?? slot.source);
    }
    for (const reader of this.#log.all()) wakeReader(reader); // SE-14A
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
    try {
      // SE-046: terminal marks every slot dead, so idle() checks steps 1, 5 and 6, and steps 7 and 8 do nothing.
      // SE-043: a step 1 change belongs to this flush, so repeat for slots it added, and fresh stops a second advance.
      for (let list: Slot[]; (list = this.#due()).length; )
        for (const slot of list) if (this.#advancing(slot)) this.#pull(slot);
      if (this.#terminal) return;
      const publish = this.#changed;
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
        this.#hook?.(report);
      }
      if (this.#terminal) return;
      if (publish && !this.#nonYielding) {
        const snap = this.#snapshot();
        const value = this.#mapSnapshot ? this.#mapSnapshot(snap) : snap;
        if (!this.#backPressure) channel.send(value);
        else {
          const sent = channel.asend(value);
          // SE-04A: a reader that reads the report observes this flush too
          if (!this.#anyAck) await sent;
          else if (!this.#log.read) {
            const seen = this.#log.seen();
            sent.then(seen.resolve, seen.reject);
            await seen.promise;
          }
        }
      }
      if (settled)
        for (const slot of settled.sort(byIndex))
          if (slot.kind === SYNC_RAW && idle(slot)) this.#pull(slot);
      const ready = this.#ready;
      if (ready)
        for (const slot of drain(ready))
          if (slot.kind !== SYNC_RAW && idle(slot)) this.#pull(slot); // Only iterators with a known kind reach ready
      const watched = this.#watched;
      if (watched && !this.#changed) {
        for (const slot of watched)
          if (slot.dead || !live(slot)) watched.delete(slot);
        if (!watched.size) channel.close();
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
      old?.index ?? this.#keyOrder++,
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
    if (length < size) this.#splice(length, size, []);
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
