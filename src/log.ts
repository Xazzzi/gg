// The operation log of a select and its readers, with slices and watch.
// The select side, which runs the sources and flushes, is in select.ts.
// Key slices and the parked readers exist so that a report wakes only the readers of its keys (SE-153, scope.md).
import { type Channel, failed, resultOf, terminal } from "./channel.ts";
import { bindPulled, type Emit, pulledSource, register } from "./devtools.ts";
import { append, noop } from "./source.ts";

export type Op =
  | {
      op: "set";
      key: string | symbol | number;
      value: unknown;
      prev: unknown;
      kept?: true;
    }
  | { op: "delete"; key: string | symbol; prev: unknown }
  | { op: "splice"; start: number; removed: unknown[]; added: unknown[] }
  | { op: "move"; order: number[] };

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

/** What opens the readers of one select, which watch opens at its first next(). */
export type Opener = { open(keys?: readonly PropertyKey[]): Changes<unknown> };

const finished = { done: true, value: undefined } as const;

/** The reader of `watch`, which reads one slot from a slice reader. */
export class Watcher implements Watch<unknown> {
  #select: Opener;
  #key: PropertyKey;
  #reader?: Changes<any>;
  #current: unknown; // The last output that the reads give the slot
  #last: unknown;
  #given = false; // SE-163 compares with the last given output
  #present?: boolean; // Set when the reader opens
  #done = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(select: Opener, key: PropertyKey) {
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

type Ref = WeakRef<Reader>;

/** Gives the readers of refs that code did not drop, because a collected reader leaves its ref until the registry takes it out. */
export function* alive(refs: Iterable<Ref>) {
  for (const ref of refs) {
    const reader = ref.deref();
    if (reader) yield reader;
  }
}

/** Takes a reader that code dropped out of its log (SE-14E). */
const dropped = new FinalizationRegistry<{
  log: Log;
  ref: Ref;
  names?: Set<PropertyKey>;
}>(({ log, ref, names }) => {
  log.remove(ref, names);
  log.trim();
});

/**
 * The operations of a select: the ones since the last report, and the reported ones that a reader did not read.
 * SE-14B drops what each reader read, and SE-14C stops the log with no reader.
 * The log holds a reader weakly, so a reader that code drops retains no operation (SE-14E). */
export class Log {
  pending?: Op[]; // Undefined while no one reads operations
  // Stryker disable next-line ArrayDeclaration: a reader starts after all that the log holds
  reported: Op[] = []; // From the absolute index base
  base = 0;
  readers = new Set<Ref>(); // The readers that each publish wakes
  named?: Map<PropertyKey, Set<Ref>>; // The readers of key slices, which a publish wakes by key
  parked?: Set<Reader>; // The key slice readers with a read that waits, which observe each report (SE-04A)
  waiting = new Set<Reader>(); // The readers with a read that waits, held until it settles, as code may hold only its promise
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

  /** Attaches a reader by its ref, by name when it reads a key slice, and takes it out when code drops it. */
  add(reader: Reader, ref: Ref, names?: Set<PropertyKey>) {
    // Stryker disable next-line ConditionalExpression: a key slice among the readers that each publish wakes reads the same operations
    if (!names?.size) this.readers.add(ref);
    else {
      const named = (this.named ??= new Map());
      for (const name of names)
        named.get(name)?.add(ref) ?? named.set(name, new Set([ref]));
    }
    dropped.register(reader, { log: this, ref, names });
  }

  /** Detaches a reader by its ref, and tells if it was attached. */
  remove(ref: Ref, names?: Set<PropertyKey>) {
    const named = this.named;
    if (!names?.size || !named) return this.readers.delete(ref);
    let had: boolean | undefined; // Each name has the reader, or none has
    for (const name of names) {
      const readers = named.get(name);
      had = readers?.delete(ref);
      if (readers?.size === 0) named.delete(name);
    }
    return had;
  }

  /** Gives each attached reader one time. */
  all() {
    const all = new Set(alive(this.readers));
    for (const refs of this.named?.values() ?? [])
      for (const reader of alive(refs)) all.add(reader);
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
    append(this.reported, report);
    this.#last = report;
    for (const reader of alive(this.readers)) wakeReader(reader);
    // A key slice reads only its keys, so a report wakes no reader of other keys (SE-153).
    const due = new Set<Reader>();
    // Stryker disable next-line ConditionalExpression: with no key slice, no operation names a reader
    if (this.named?.size)
      for (const op of report)
        for (const reader of alive(
          this.named.get((op as { key: PropertyKey }).key) ?? [],
        ))
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
      for (const reader of alive(this.readers))
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
export type View = {
  readonly outputs: unknown;
  begin(length: number): void;
  project(list: Op[]): Op[];
  pick(keyed: Keyed): Op[] | undefined; // The same as project, for a slice of fewer slots than the report has keys
  readonly names?: Set<PropertyKey>; // The keys of a key slice, which the log wakes its reader by
  spent?(): boolean; // A key slice always has its slots
};

/** A slice of an object shape, which follows its keys, so it never runs out. */
export class KeySlice implements View {
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
export class IndexSlice implements View {
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

export let positionOf: (reader: Reader) => number,
  wakeReader: (reader: Reader) => void,
  beginReader: (reader: Reader, length: number) => void;

/** A reader of the log, or of a slice of it, which takes its operations at each report (SE-157). */
export class Reader implements Changes<unknown> {
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
  #ref = new WeakRef(this); // What the log holds (SE-14E)
  #bound?: Set<unknown>; // The binding to a pulled source, which the reader leaves when it ends (JX-041)

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
    this.#bound = bindPulled(this); // JX-041
    if (slice?.spent?.()) {
      this.#end(); // SE-156 finishes a reader that names no slot
      return;
    }
    // Stryker disable next-line ConditionalExpression: a terminal select reports nothing, and the reader ends at its first read
    if (!terminal(channel)) {
      this.#at += log.pending?.length ?? 0;
      log.pending ??= [];
      log.add(this, this.#ref, slice?.names);
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
    this.#bound?.delete(this);
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
    append(this.#taken, ops);
    this.#at = log.end;
    if (slice.spent?.()) {
      // Stryker disable next-line BlockStatement,CallExpression: a spent reader reads past each later report, so this only stops the log sooner
      log.remove(this.#ref);
      this.#end();
    }
  }

  /** Gives the operations that a read takes, or undefined if none waits. */
  #read() {
    if (this.#slice)
      return this.#taken.length ? this.#taken.splice(0) : undefined;
    const log = this.#log,
      end = log.end;
    if (!log.readers.has(this.#ref) || this.#at >= end) return undefined;
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
        this.#log.waiting.add(this);
        this.#log.observe(); // SE-04A: a reader with nothing to read observed all that concerns it
        return;
      } else {
        this.#log.parked?.delete(this);
        this.#log.remove(this.#ref, this.#slice?.names);
        this.#log.trim();
        if (!this.#closed && failed(channel)) next.reject(resultOf(channel));
        else next.resolve({ done: true, value: undefined });
        this.#closed = true;
        this.#end();
      }
      this.#waiting.shift();
    }
    this.#log.waiting.delete(this);
  }

  /** Stops the reader, and ends its waiting reads. */
  #close() {
    this.#closed = true;
    this.#end();
    this.#taken.length = 0;
    if (this.#log.remove(this.#ref, this.#slice?.names)) this.#log.trim();
    this.#settle();
  }
}
