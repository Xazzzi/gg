import {
  CHAN,
  Channel,
  catching,
  feed,
  type Op,
  type SelectOptions,
  type Snapshot,
  type Spread,
  select,
  spread,
  type Unwrapped,
  type Val,
} from "../src/index.ts";

type Eq<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
const yes = <T extends true>(_?: T) => {};
type Shape = {
  p: Promise<number>;
  g: AsyncGenerator<string, boolean>;
  r: Generator<number, void>;
  n: number;
  list: string[];
};

yes<Eq<Snapshot<Shape>["p"], Val<number>>>();
yes<Eq<Snapshot<Shape>["g"], Val<string | boolean>>>();
yes<Eq<Snapshot<Shape>["r"], Val<number>>>();
yes<Eq<Snapshot<Shape>["n"], number>>();
yes<Eq<Snapshot<Shape>["list"], string[]>>();
yes<Eq<Unwrapped<Shape>["p"], number | undefined>>();
yes<Eq<Unwrapped<Shape>["n"], number>>();
yes<
  Eq<Snapshot<readonly [Promise<number>, string]>, (Val<number> | string)[]>
>();
yes<
  Eq<
    Unwrapped<readonly [Promise<number>, string]>,
    (number | undefined | string)[]
  >
>();

type Fields = {
  value: number | undefined;
  loading: boolean;
  error: unknown;
  done: boolean;
};
yes<Eq<Spread<Snapshot<Promise<number>[]>>[number], Fields>>();
yes<
  Eq<Spread<Snapshot<(Promise<number> | number)[]>>[number], Fields | number>
>();
yes<Eq<Spread<Snapshot<number[]>>[number], number>>();
yes<Eq<Spread<{ a: Val<number> | number }>["a"], number | undefined>>();
yes<Eq<Spread<{ a: Val<number> }>["a"], number | undefined>>();
yes<Eq<Spread<{ a: Val<number> }>["aLoading"], boolean>>();

const options: SelectOptions<unknown, unknown> = { unwrap: true };
const flag = Math.random() > 0.5;
// @ts-expect-error A boolean unwrap must be narrowed first
select({ a: 1 }, { unwrap: flag });
void options;

const a = select({ p: Promise.resolve(1), n: 1 });
const source: Promise<number> = a.p;
a[CHAN].close();
const spreadState = select({ p: Promise.resolve(1) }, { mapSnapshot: spread });
const list = select([Promise.resolve(1), 2], { unwrap: true });
list.push(3);
const mapped = select(
  { a: Promise.resolve(1) },
  { unwrap: true, mapSnapshot: s => s.a },
);
(async () => {
  for await (const v of spreadState) {
    const value: number | undefined = v.p;
    const loading: boolean = v.pLoading;
    void [value, loading];
  }
  for await (const v of list) {
    const values: (number | undefined)[] = v;
    void values;
  }
  for await (const v of mapped) {
    const value: number | undefined = v;
    void value;
  }
})();

const ch = new Channel<number, string>();
feed([1, 2], ch);
feed(Promise.resolve(1), ch);
feed(
  catching([1], () => {}),
  ch,
);
// @ts-expect-error A thenable is not sendable
new Channel<Promise<number>>().send(Promise.resolve(1));
// @ts-expect-error The default TReturn takes no string
new Channel<number>().close("end");
// @ts-expect-error CH-06C
new Channel<number, Promise<number>>().close(Promise.resolve(1));
const op: Op = { op: "delete", key: "a", prev: 1 };
void [source, op];
