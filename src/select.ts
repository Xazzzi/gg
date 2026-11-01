import { attached, Channel, type ChannelOptions } from "./channel.ts";
import {
  checkOptions,
  isThenable,
  noop,
  quiet,
  quietReturn,
  thenOf,
  VAL,
} from "./source.ts";

export const CHAN: unique symbol = Symbol.for("gg.CHAN") as any;

export type SelectShape = Record<string | symbol, unknown> | readonly unknown[];

export type Val<T> =
  | { status: "pending"; value: undefined; reason: undefined; done: false }
  | { status: "fulfilled"; value: T; reason: undefined; done: boolean }
  | { status: "rejected"; value: undefined; reason: unknown; done: true };

export type Op =
  | { op: "set"; key: string | symbol | number; value: unknown; prev: unknown }
  | { op: "delete"; key: string | symbol; prev: unknown }
  | { op: "splice"; start: number; removed: unknown[]; added: unknown[] };

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

type Mutable<T> = T extends readonly unknown[] ? T[number][] : T;

export type State<T, R> = Mutable<T> &
  AsyncIterable<R> &
  Disposable & { [CHAN]: Channel<R> };

const PLAIN = 0,
  PROMISE = 1,
  ASYNC = 2,
  RAW = 3;
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

// SE-016 keeps the method detection read, so later steps never read it again.
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

const toIndex = (key: PropertyKey) => {
  if (typeof key !== "string") return undefined;
  const index = Number(key) >>> 0;
  return String(index) === key && index !== 2 ** 32 - 1 ? index : undefined;
};

const forbid = () => {
  throw new TypeError("Operation is not supported on a select proxy");
};

// Array.prototype.splice takes items as arguments, which limits their number.
const replace = <V>(list: V[], start: number, count: number, items: V[]) => {
  const rest = list.splice(start),
    removed = rest.splice(0, count);
  for (const item of items.concat(rest)) list.push(item);
  return removed;
};

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

export function select<T extends SelectShape, R = Unwrapped<T>>(
  shape: T,
  options: SelectOptions<Unwrapped<T>, R> & { unwrap: true },
): State<T, R>;
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
  const slots = () => (isArray ? [...array] : [...map.values()]);
  let ops: any[] | undefined = onChanges && [];
  let started = false,
    dirty: boolean | undefined,
    scheduled = false,
    running = false;

  const out = (slot: Slot) =>
    unwrap && slot.kind !== PLAIN ? slot.state.value : slot.state;
  const log = (op: () => Op) => {
    if (ops && started) ops.push(op()); // SE-10A
  };
  const keyOf = (slot: Slot) =>
    isArray ? array.indexOf(slot) : (slot.key as string);

  const schedule = () => {
    if (scheduled || running || !started || signal.aborted) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  const touch = () => {
    dirty = true;
    schedule();
  };

  const update = (slot: Slot, state: Val<unknown>) => {
    if (slot.dead) return;
    const prev = out(slot);
    slot.state = state;
    if (!started) return;
    if (unwrap && state.status === "rejected")
      return channel.throw(state.reason);
    log(() => ({ op: "set", key: keyOf(slot), value: out(slot), prev }));
    touch();
  };

  const fail = (slot: Slot, error: unknown, valueFailed = false) => {
    const open = !slot.finished;
    slot.busy = false;
    slot.finished = true;
    if (slot.dead) return;
    if (valueFailed && open) void quietReturn(slot.iterator);
    update(slot, val("rejected", undefined, error, true));
  };

  const commit = (
    slot: Slot,
    value: unknown,
    done: boolean,
    awaited: boolean,
  ) => {
    slot.busy = false;
    slot.fresh = true;
    slot.awaited = awaited;
    update(
      slot,
      val(
        "fulfilled",
        value === undefined && done ? slot.state.value : value,
        undefined,
        done,
      ),
    );
  };

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

  const pull = (slot: Slot) => {
    let result: any;
    try {
      result = slot.next.call(slot.iterator);
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

  const idle = (slot: Slot) => !slot.dead && !slot.finished && !slot.busy;

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

  const start = () => {
    started = true;
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
    const rejected =
      unwrap &&
      all.find(slot => slot.kind !== PLAIN && slot.state.status === "rejected");
    if (rejected) channel.throw(rejected.state.reason);
    all.forEach(activate);
    schedule();
  };

  const snapshot = () =>
    isArray
      ? array.map(out)
      : Object.fromEntries([...map].map(([key, slot]) => [key, out(slot)]));

  // Step 6 has just pulled every idle async iterator, so an unfinished one is busy here.
  const live = (slot: Slot) =>
    slot.kind === PROMISE ? slot.state.status === "pending" : slot.busy;

  // An idle async raw iterator is always fresh here, because step 6 pulls it right after each report.
  const advancing = (slot: Slot) =>
    slot.kind === RAW && idle(slot) && !slot.fresh;

  async function flush() {
    scheduled = false;
    running = true;
    try {
      // SE-046: terminal marks every slot dead, so idle() checks steps 1, 5 and 6, and steps 7 and 8 do nothing.
      // SE-043: a step 1 change belongs to this flush, so repeat for slots it added, and fresh stops a second advance.
      for (let due: Slot[]; (due = slots().filter(advancing)).length; )
        for (const slot of due) if (advancing(slot)) pull(slot);
      if (signal.aborted) return;
      dirty = false;
      for (const slot of slots()) {
        slot.due = slot.awaited;
        slot.awaited = slot.fresh = false;
      }
      if (ops?.length) {
        const report = ops;
        ops = [];
        onChanges(report);
      }
      if (signal.aborted) return;
      if (!nonYielding) {
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

  const define = (key: any, source: unknown) =>
    Reflect.defineProperty(target, key, {
      value: source,
      writable: true,
      enumerable: true,
      configurable: true,
    });

  const write = (key: any, source: unknown) => {
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

  const splice = (start: number, count: number, items: unknown[]) => {
    if (!count && !items.length) return [];
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

  const blanks = (count: number) => Array.from({ length: count }) as unknown[];

  const resize = (value: unknown) => {
    const length = Number(value),
      size = target.length;
    if (length >>> 0 !== length) throw new RangeError("Invalid array length");
    if (length < size) splice(length, size, []);
    else splice(size, 0, blanks(length - size));
  };

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

  const integer = (value: unknown) => Math.trunc(Number(value)) || 0;

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
        relative = integer(args[0]);
      const begin =
        relative < 0 ? Math.max(size + relative, 0) : Math.min(relative, size);
      const count = !args.length
        ? 0
        : args.length === 1
          ? size - begin
          : Math.min(Math.max(integer(args[1]), 0), size - begin);
      return splice(begin, count, args.slice(2));
    },
    sort: forbid,
    reverse: forbid,
    fill: forbid,
    copyWithin: forbid,
  };

  const iterate = () => channel[Symbol.asyncIterator]();
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
  });

  if (autoStart) queueMicrotask(start);
  else attached(channel).then(start, noop);

  return new Proxy(target, {
    get(_, key, receiver) {
      if (key === Symbol.asyncIterator) return iterate;
      if (key === Symbol.dispose) return dispose;
      if (key === CHAN) return channel;
      return isArray && key in methods
        ? methods[key]
        : Reflect.get(target, key, receiver);
    },
    has: (_, key) => RESERVED.includes(key) || Reflect.has(target, key),
    set(_, key, value) {
      assign(key, value);
      return true;
    },
    deleteProperty: (_, key) => remove(key),
    defineProperty: forbid,
    preventExtensions: forbid,
    setPrototypeOf: forbid,
  });
}
