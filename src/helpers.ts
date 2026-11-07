import type { Source } from "./feed.ts";
import type { Op, Val } from "./select.ts";
import {
  checkOptions,
  detect,
  quiet,
  quietReturn,
  relocate,
  replace,
  VAL,
} from "./source.ts";

export function abortable<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    quiet(promise);
    return Promise.reject(signal.reason);
  }
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(signal.reason);
  const remove = () => signal.removeEventListener("abort", onAbort);
  signal.addEventListener("abort", onAbort);
  Promise.resolve(promise).then(resolve, reject);
  result.then(remove, remove);
  return result;
}

export interface Caught<T> extends AsyncIterableIterator<T, unknown, void> {
  return(value?: unknown): Promise<IteratorResult<T, unknown>>;
}

const end = (value?: unknown): IteratorResult<any, unknown> => ({
  done: true,
  value,
});

// HE-018 and HE-01A rule out a plain async generator here.
export function catching<T>(
  source: Source<T>,
  onError: (error: unknown) => void | PromiseLike<void>,
): Caught<T> {
  const detected = detect(source);
  if (!detected)
    throw new TypeError("catching source is not a promise or iterator");
  if (typeof onError !== "function")
    throw new TypeError("catching requires onError");
  quiet(source);
  const pending: PromiseWithResolvers<IteratorResult<T, unknown>>[] = [];
  let iterator: any,
    next: any,
    finished = false;

  const step = async () => {
    if (finished) return end();
    let answered: any, done: any;
    try {
      if (!iterator) [iterator, next] = detected.open();
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

  const pump = () => {
    const request = pending[0];
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
      const inner = iterator ?? (detected.stream ? (source as any) : undefined);
      return typeof inner?.return === "function"
        ? inner.return(value)
        : end(value);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

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

const fields = new WeakMap<object, object>();

const errorOf = (val: Val<unknown>) =>
  val.status === "rejected" ? val.reason : null;

const fieldsOf = (val: Val<unknown>) => {
  let entry = fields.get(val);
  if (!entry)
    fields.set(
      val,
      (entry = Object.freeze({
        value: val.value,
        loading: val.status === "pending",
        error: errorOf(val),
        done: val.done,
      })),
    );
  return entry;
};

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

type Entry<T> = T extends readonly (infer V)[] ? V : T[keyof T];

const same = (value: unknown) => value;
const own = (target: any, key: PropertyKey) =>
  Object.hasOwn(target, key) ? target[key] : undefined;

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

type Cell = {
  entry?: unknown;
  value?: unknown;
  prev?: unknown;
  fresh?: boolean;
};

const incoming = (value: unknown, prev: unknown): Cell => ({
  fresh: true,
  value,
  prev,
});
const inherited = (cell?: Cell) => (cell?.fresh ? cell.prev : cell?.entry);
// A symbol throws a TypeError here, as HE-04F needs.
const isIndex = (key: any) => key >>> 0 === key && key !== 2 ** 32 - 1;

const checkFit = (op: Op, array: boolean) => {
  const fits = array
    ? op.op === "splice" ||
      op.op === "move" ||
      (op.op === "set" && isIndex(op.key))
    : op.op === "set" || op.op === "delete";
  if (!fits)
    throw new TypeError(`applyOps cannot replay ${op.op} on this target`);
};

const foldArray = (target: any[], ops: readonly Op[], map: any) => {
  const cells: Cell[] = target.map(entry => ({ entry }));
  for (const op of ops) {
    checkFit(op, true);
    if (op.op === "set")
      cells[op.key as number] = incoming(
        op.value,
        inherited(cells[op.key as number]),
      );
    else if (op.op === "move") relocate(cells, op.order);
    else {
      const { start, removed, added } = op as Extract<Op, { op: "splice" }>,
        count = removed.length;
      const items = added.map((value, index) =>
        incoming(
          value,
          index < count ? inherited(cells[start + index]) : undefined,
        ),
      );
      replace(cells, start, count, items);
    }
  }
  // Relocating a hole makes it an undefined cell, which reads as an undefined entry (HE-04G).
  const items = cells.map(cell =>
    cell?.fresh ? map(cell.value, cell.prev) : cell?.entry,
  );
  items.forEach((item, index) => {
    if (index >= target.length || !Object.is(target[index], item))
      target[index] = item;
  });
  target.length = items.length;
  return target;
};

const foldObject = (target: any, ops: readonly Op[], map: any) => {
  const sets = new Map<PropertyKey, Cell>(),
    gone = new Set<PropertyKey>();
  for (const op of ops) {
    checkFit(op, false);
    const { key } = op as Extract<Op, { key: unknown }>,
      name = typeof key === "number" ? `${key}` : key;
    if (op.op === "set") sets.set(name, incoming(op.value, own(target, name)));
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
      const { value, prev } = sets.get(key) as Cell;
      return [key, map(value, prev)] as const;
    });
  for (const key of gone) delete target[key];
  for (const [key, value] of entries) store(target, key, value);
  return target;
};

export function applyOps<T extends object>(
  target: T,
  ops: readonly Op[],
  map?: (value: unknown, prev: Entry<T> | undefined) => Entry<T>,
  options?: { eager?: boolean },
): T;
export function applyOps(
  target: any,
  ops: readonly Op[],
  map: any = same,
  options: { eager?: boolean } = {},
) {
  if (Object(target) !== target)
    throw new TypeError("applyOps target must be an object");
  if (typeof map !== "function")
    throw new TypeError("applyOps map must be a function");
  checkOptions(options, { eager: "boolean" });
  if (!options.eager)
    return (Array.isArray(target) ? foldArray : foldObject)(target, ops, map);
  const array = Array.isArray(target);
  for (const op of ops) {
    checkFit(op, array);
    if (op.op === "set")
      store(target, op.key, map(op.value, own(target, op.key)));
    else if (op.op === "delete") delete target[op.key];
    else if (op.op === "move") relocate(target, op.order);
    else {
      const { start, removed, added } = op as Extract<Op, { op: "splice" }>,
        count = removed.length;
      const items = added.map((value, index) =>
        map(value, index < count ? target[start + index] : undefined),
      );
      replace(target, start, count, items);
    }
  }
  return target;
}
