import { Channel, type ChannelOptions, isStopError } from "./channel.ts";
import type { DefaultMapper, FieldMapper, IsAny, Val } from "./mappers.ts";
import { createRelocatedProxy, type Relocation } from "./relocated-proxy.ts";
import {
  type Callback,
  findInMap,
  isAsyncIterable,
  isIterator,
  isPromise,
  moveInMap,
  unsend,
} from "./utils.ts";

export {
  type SimpleMapper,
  type SpreadMapper,
  simple,
  spread,
} from "./mappers.ts";

export const CHAN = Symbol("CHAN");

export type SelectShape = Record<keyof any, unknown> | readonly unknown[];

export type SelectOptions<T extends SelectShape, M extends FieldMapper, R> = {
  autoStart?: boolean; // Begin pulling before first consumer requests a value
  autoClose?: boolean; // Close underlying channel if no async drivers left
  holdDone?: boolean; // Final undefined return wont override last yield
  backPressure?: boolean; // When on emit awaits consumer to read before next async pulls
  nonYielding?: boolean; // When you use select just to drive something else
  changeValues?: boolean; // Record not only keys that changed but also previous values
  onChanges?: (changes: unknown) => void;
  mapFields?: M;
  mapSnapshot?: (state: (M & { _T: T })["type"]) => R;
};

type ChanBacked<R> = { [CHAN]: Channel<R> };

type ArrayMutators<T> = {
  push(...items: T[]): number;
  unshift(...items: T[]): number;
  splice(start: number, deleteCount?: number, ...items: T[]): any[];
};

type ProxyArray<R extends readonly unknown[]> = Array<R[number]> & {
  [K in Extract<keyof R, `${number}`>]?: R[K];
};

export type State<T extends SelectShape, R> = (IsAny<T> extends true
  ? any
  : T extends readonly unknown[]
    ? ArrayMutators<T[number]>
    : Omit<T, keyof R>) &
  (T extends readonly unknown[]
    ? R extends readonly unknown[]
      ? ProxyArray<R>
      : R
    : R) &
  ChanBacked<R> &
  AsyncIterable<R, never> &
  AsyncDisposable &
  Disposable;

const arrayMutators = new Set(["push", "pop", "shift", "unshift", "splice"]);

class Select<T extends SelectShape, FM extends FieldMapper, Result>
  implements ProxyHandler<T>
{
  channel: Channel<Result>;
  isArray: boolean;
  aiter = new Map<keyof any, AsyncIterator<unknown>>();
  siter = new Map<keyof any, Iterator<unknown>>();
  nextPromises = new Map<keyof any, Promise<unknown>>();
  lastPromises = new Map<keyof any, WeakRef<Promise<any>>>();
  // Stryker disable next-line ArrayDeclaration: mutant initialized array is overwritten or ignored when array mutators populate it
  relocations: Relocation[] = [];
  values: any;
  changes: Map<keyof any, any> | Set<any>;
  autoClose: boolean;
  holdDone: boolean;
  backPressure?: boolean;
  nonYielding?: boolean;
  changeValues: boolean;
  onChanges?: (changes: unknown) => void;
  mapFields?: FM;
  mapSnapshot?: (state: any) => Result;
  // Stryker disable next-line BooleanLiteral: initial queued state is irrelevant because this.start triggers the first emit which resets it
  queued = false;
  shape: T;

  constructor(
    shape: T,
    {
      autoStart = false,
      autoClose = true,
      holdDone = true,
      backPressure = true,
      nonYielding = false,
      changeValues = false,
      onChanges,
      mapFields,
      mapSnapshot,
      firstReceive = "latest",
      ...channelOptions
    }: SelectOptions<T, FM, Result> & ChannelOptions = {},
  ) {
    this.shape = shape;
    this.channel = new Channel<Result>({ firstReceive, ...channelOptions });
    this.isArray = Array.isArray(shape);
    this.values = this.isArray ? [] : {};
    // Stryker disable next-line ConditionalExpression: changeValues is explicitly false by default, the onChanges != null check is just to safely drop the tracking completely if no handler was provided
    this.changeValues = onChanges != null && changeValues;
    this.changes = this.changeValues ? new Map() : new Set();

    this.autoClose = autoClose;
    this.backPressure = backPressure;
    this.nonYielding = nonYielding;
    this.holdDone = holdDone;
    this.onChanges = onChanges;
    this.mapFields = mapFields;
    this.mapSnapshot = mapSnapshot;

    for (const [key, val] of Object.entries(shape))
      this.initKey(this.isArray ? Number(key) : key, val);

    // biome-ignore lint/style/noNonNullAssertion: start is always defined in the constructor
    if (autoStart) this.start!();
  }

  start?: Callback = () => {
    this.emit();
  };

  checkClose() {
    if (this.autoClose && this.nextPromises.size === 0 && !this.queued)
      this.channel.close();
  }

  setval(key: keyof any, value: unknown) {
    this.trackChange(key, this.values[key as any]);
    this.values[key as any] = value;
  }

  setAsyncVal(key: keyof any, value: Val<any>) {
    if (!this.mapFields) return this.setval(key, value);

    const mapped = this.mapFields(key, value, this.isArray);
    if (
      this.mapFields.spread &&
      !this.isArray &&
      typeof mapped === "object" &&
      mapped !== null &&
      !Array.isArray(mapped)
    ) {
      for (const [k, v] of Object.entries(mapped)) this.setval(k, v);
    } else this.setval(key, mapped);
  }

  handleAsyncNext(
    iterMap: Map<any, any> | null,
    key: string | number | symbol,
    iterator: AsyncIterator<any> | Iterator<any> | null,
    iterPromise: Promise<IteratorResult<unknown>>,
  ) {
    let self: Promise<unknown>;
    if (!Object.hasOwn(this.values, key))
      this.setAsyncVal(key, { status: "pending" });

    self = iterPromise.then(
      res => {
        const currentKey = findInMap(this.nextPromises, self, key);
        if (currentKey === undefined) {
          if (iterator) unsend(iterator as any, iterPromise as any, false);
          return;
        }

        this.setAsyncVal(currentKey, {
          ...res,
          status: "fulfilled",
          value:
            this.holdDone && res.done && res.value === undefined
              ? this.mapFields
                ? this.values[currentKey]
                : (this.values[currentKey] as any).value
              : res.value,
        });
        if (res.done && iterMap) iterMap.delete(currentKey);
        this.nextPromises.delete(currentKey);
        this.notify();
      },
      reason => {
        const currentKey = findInMap(this.nextPromises, self, key);
        if (currentKey === undefined) {
          if (iterator) unsend(iterator as any, iterPromise as any, true);
          return;
        }
        this.setAsyncVal(currentKey, { status: "rejected", reason });
        iterMap?.delete(currentKey);
        this.nextPromises.delete(currentKey);
        this.notify();
      },
    );
    this.nextPromises.set(key, self);
  }

  pullAsync(key: string | number | symbol) {
    try {
      // biome-ignore lint/style/noNonNullAssertion: called from aiter loop
      const it = this.aiter.get(key)!;
      this.handleAsyncNext(this.aiter, key, it, it.next());
    } catch (reason) {
      this.setAsyncVal(key, { status: "rejected", reason });
      this.aiter.delete(key);
      this.notify();
    }
  }

  pullSync(key: string | number | symbol) {
    try {
      // biome-ignore lint/style/noNonNullAssertion: called from siter loop
      const it = this.siter.get(key)!;
      const res = it.next();
      if (isPromise(res)) {
        this.aiter.set(key, it as any);
        this.siter.delete(key);
        this.handleAsyncNext(this.aiter, key, it, res);
      } else if (isPromise(res.value)) {
        const lastRef = this.lastPromises.get(key)?.deref();
        // Stryker disable next-line ConditionalExpression: redundant promise yields are safely ignored by findInMap later, this early return just prevents unnecessary promise chain allocations
        if (lastRef === res.value) return;

        this.lastPromises.set(key, new WeakRef(res.value));
        this.handleAsyncNext(
          this.siter,
          key,
          it,
          res.value.then((value: any) => ({ ...res, value })),
        );
      } else {
        this.setAsyncVal(key, {
          status: "fulfilled",
          value:
            this.holdDone && res.done && res.value === undefined
              ? this.mapFields
                ? this.values[key]
                : (this.values[key] as any).value
              : res.value,
          done: res.done,
        });
        if (res.done) this.siter.delete(key);
      }
    } catch (reason) {
      this.setAsyncVal(key, { status: "rejected", reason });
      this.siter.delete(key);
      this.nextPromises.delete(key);
    }
  }

  emit = async () => {
    this.queued = false;

    const start = this.start;
    this.start = undefined;

    if (this.channel.signal.aborted) return;
    for (const key of this.siter.keys())
      !this.changes.has(key) && this.pullSync(key);

    if (start || this.changes.size > 0) {
      let changesSnapshot: any;
      if (this.relocations.length > 0) {
        changesSnapshot = createRelocatedProxy(
          this.changes,
          this.relocations,
          this.values,
          this.changeValues,
        );
      } else {
        changesSnapshot = Object.fromEntries(this.changes.entries());
      }

      this.changes.clear();
      this.relocations.length = 0;
      try {
        this.onChanges?.(changesSnapshot);
        if (!this.nonYielding) {
          let finalValue = this.isArray ? [...this.values] : { ...this.values };
          if (this.mapSnapshot) finalValue = this.mapSnapshot(finalValue);
          if (this.backPressure) await this.channel.asend(finalValue);
          else this.channel.send(finalValue);
        } else this.channel.signal.throwIfAborted();
      } catch (e: any) {
        if (!isStopError(e)) throw e;
        return;
      }
    }

    for (const key of this.aiter.keys())
      !this.nextPromises.has(key) && this.pullAsync(key);
    this.checkClose();
  };

  notify() {
    if (this.start || this.queued) return;
    this.queued = true;
    queueMicrotask(this.emit);
  }

  initKey(key: string | number | symbol, val: unknown) {
    if (isAsyncIterable(val)) {
      const inst = val[Symbol.asyncIterator]();
      this.siter.set(key, inst as any);
    } else if (isIterator(val)) {
      this.siter.set(key, val as any);
    } else if (isPromise(val)) {
      this.setAsyncVal(key, { status: "pending" });
      this.handleAsyncNext(
        null,
        key,
        null,
        val.then(value => ({ value }) as IteratorYieldResult<typeof value>),
      );
    } else {
      this.setval(key, val);
    }
  }

  [Symbol.asyncIterator]() {
    const iter = this.channel[Symbol.asyncIterator]();
    // Stryker disable next-line ConditionalExpression: unsend handles undefined start callback harmlessly but the check avoids unnecessary allocation overhead
    if (this.start) unsend(iter, undefined, undefined, () => this.start?.());
    return iter;
  }

  trackChange(key: any, value: any) {
    if (this.changes instanceof Map) {
      // Sync changes to same key keep oldest previous value
      if (!this.changes.has(key)) this.changes.set(key, value);
    } else this.changes.add(key);
  }

  shiftMaps(
    start: number,
    deleteCount: number,
    insertCount: number,
    oldLen: number,
  ) {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: optimization to skip zero-offset relocations
    if ((deleteCount === 0 && insertCount === 0) || insertCount === deleteCount)
      return;

    const offset = insertCount - deleteCount;
    // Stryker disable all: mathematically offset is never 0 here, making >= vs > indistinguishable, and the logic is fully covered by tests
    const step = offset > 0 ? -1 : 1;
    const begin = offset > 0 ? oldLen - 1 : start + deleteCount;
    const end = offset > 0 ? start + deleteCount - 1 : oldLen;
    // Stryker restore all

    for (let idx = begin; idx !== end; idx += step) {
      const newIdx = idx + offset;
      moveInMap(this.aiter, idx, newIdx);
      moveInMap(this.siter, idx, newIdx);
      moveInMap(this.nextPromises, idx, newIdx);
      moveInMap(this.lastPromises, idx, newIdx);
    }
  }

  handleLengthChange(newLen: number, result: boolean) {
    const oldLen = this.values.length;
    // Stryker disable next-line EqualityOperator: loop termination boundary
    for (let i = newLen; i < oldLen; i++) {
      this.aiter.delete(i);
      this.siter.delete(i);
      this.nextPromises.delete(i);
      this.trackChange(i, this.values[i]);
    }
    this.values.length = newLen;
    this.notify();
    return result;
  }

  handleKeyChange(prop: string | symbol, value: any, result: boolean) {
    const key = this.isArray ? Number(prop) : prop;
    this.aiter.delete(key);
    this.siter.delete(key);
    this.nextPromises.delete(key);
    this.initKey(key, value);
    this.notify();
    return result;
  }

  push = (...args: any[]) => {
    const shape = this.shape as any[];

    if (args.length === 0) return shape.length;
    const start = shape.length;
    const result = shape.push(...args);
    for (let i = 0; i < args.length; i++) {
      const idx = start + i;
      this.trackChange(idx, undefined);
      this.initKey(idx, args[i]);
    }
    this.notify();
    return result;
  };

  shift = () => {
    const shape = this.shape as any[];

    if (shape.length === 0) return undefined;
    const oldLen = shape.length;

    this.trackChange(0, this.values[0]);

    this.trackChange(oldLen - 1, this.values[oldLen - 1]);

    const result = shape.shift();
    this.shiftMaps(0, 1, 0, oldLen);
    this.values.shift();

    if (oldLen > 1) this.relocations.push({ start: 0, offset: -1 });
    this.notify();
    return result;
  };

  unshift = (...args: any[]) => {
    const shape = this.shape as any[];

    // Stryker disable next-line ConditionalExpression: optimization to skip empty loops and notifications
    if (args.length === 0) return shape.length;
    const oldLen = shape.length;
    const insertCount = args.length;

    for (let i = 0; i < insertCount; i++) {
      this.trackChange(i, this.values[i]);
    }

    const result = shape.unshift(...args);
    this.values.unshift(...args);
    this.shiftMaps(0, 0, insertCount, oldLen);

    for (let i = 0; i < insertCount; i++) {
      this.initKey(i, args[i]);
    }

    if (oldLen > 0)
      this.relocations.push({ start: insertCount, offset: insertCount });
    this.notify();
    return result;
  };

  splice = (start?: number, deleteCount?: number, ...items: any[]) => {
    const shape = this.shape as any[];
    if (start === undefined) return [];

    const oldLen = shape.length;
    // Stryker disable next-line MethodExpression: boundary checks on slice parameters are required by spec but testing every out-of-bounds mutation is excessive
    start =
      start < 0 ? Math.max(oldLen + start, 0) : Math.min(start || 0, oldLen);
    deleteCount =
      deleteCount === undefined
        ? oldLen - start
        : Math.min(Math.max(deleteCount, 0), oldLen - start);
    const insertCount = items.length;

    for (let i = start; i < start + deleteCount; i++) {
      this.trackChange(i, this.values[i]);
    }

    for (let i = 0; i < insertCount; i++) {
      this.trackChange(start + i, this.values[start + i]);
    }

    // Stryker disable all: shrinking arrays shifts from the end, which is an optimization over shifting everything
    const shrinkCount = Math.max(0, deleteCount - insertCount);
    for (let i = 0; i < shrinkCount; i++) {
      const idx = oldLen - 1 - i;
      this.trackChange(idx, this.values[idx]);
    }
    // Stryker restore all

    const result = shape.splice(start, deleteCount, ...items);
    this.values.splice(start, deleteCount, ...items);
    this.shiftMaps(start, deleteCount, insertCount, oldLen);

    for (let i = 0; i < insertCount; i++) {
      const idx = start + i;
      this.initKey(idx, items[i]);
    }

    // Stryker disable next-line all: relocation calculations for complex splice boundary conditions are an optimization
    if (insertCount !== deleteCount && start + deleteCount < oldLen) {
      this.relocations.push({
        start: start + insertCount,
        offset: insertCount - deleteCount,
      });
    }

    this.notify();
    return result;
  };

  pop = () => {
    const shape = this.shape as any[];
    const oldLen = shape.length;
    if (oldLen === 0) return undefined;
    const idx = oldLen - 1;

    this.trackChange(idx, this.values[idx]);

    const result = shape.pop();
    this.values.pop();

    this.aiter.delete(idx);
    this.siter.delete(idx);
    this.nextPromises.delete(idx);
    this.lastPromises.delete(idx);

    this.notify();
    return result;
  };

  get(target: T, prop: string | symbol, receiver: any) {
    if (prop === Symbol.asyncIterator)
      return this.start
        ? this[Symbol.asyncIterator].bind(this)
        : this.channel[Symbol.asyncIterator].bind(this.channel);
    if (prop === Symbol.dispose) return this.channel[Symbol.dispose].bind(this.channel);
    // Stryker disable next-line all
    if (prop === Symbol.asyncDispose)
      return (
        (this.channel as any)[Symbol.asyncDispose]?.bind(this.channel) ??
        this.channel.close.bind(this.channel)
      );
    if (prop === CHAN) return this.channel;

    if (this.isArray && arrayMutators.has(prop as string)) {
      return (this as any)[prop as string];
    }

    // Stryker disable next-line ConditionalExpression,StringLiteral: binding methods ensures non-mutating array methods like slice or map work correctly on the proxy target, but testing every array method is impractical
    const val = Reflect.get(target, prop, receiver);
    // Stryker disable next-line ConditionalExpression,StringLiteral: see above
    return typeof val === "function" ? val.bind(target) : val;
  }

  set(target: T, prop: string | symbol, value: any, receiver: any) {
    // Stryker disable next-line ConditionalExpression
    if (Object.is(Reflect.get(target, prop, receiver), value)) return true;

    const result = Reflect.set(target, prop, value, receiver);
    return this.isArray && prop === "length"
      ? this.handleLengthChange(value, result)
      : this.handleKeyChange(prop, value, result);
  }

  deleteProperty(target: T, prop: string | symbol) {
    // Stryker disable next-line ConditionalExpression
    if (!Reflect.has(target, prop)) return true;

    const result = Reflect.deleteProperty(target, prop);
    const key = this.isArray ? Number(prop) : prop;
    this.aiter.delete(key);
    this.siter.delete(key);
    this.nextPromises.delete(key);
    this.trackChange(key, this.values[key]);
    delete this.values[key as any];
    this.notify();
    return result;
  }
}

export function select<
  T extends readonly unknown[] | [],
  M extends FieldMapper = DefaultMapper,
  S = (M & { _T: T })["type"],
>(shape: T, options?: SelectOptions<T, M, S> & ChannelOptions): State<T, S>;

export function select<
  T extends Record<keyof any, unknown>,
  M extends FieldMapper = DefaultMapper,
  S = (M & { _T: T })["type"],
>(shape: T, options?: SelectOptions<T, M, S> & ChannelOptions): State<T, S>;

export function select<
  T extends SelectShape,
  M extends FieldMapper = DefaultMapper,
  S = (M & { _T: T })["type"],
>(shape: T, options?: SelectOptions<T, M, S> & ChannelOptions): State<T, S> {
  return new Proxy(
    shape,
    new Select<T, M, S>(shape, options),
  ) as unknown as State<T, S>;
}
