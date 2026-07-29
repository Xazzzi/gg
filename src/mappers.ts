export type Val<T> =
  | { status: "pending" }
  | { status: "fulfilled"; value: T; done?: boolean }
  | { status: "rejected"; reason: unknown };

export type IsAny<T> = 0 extends 1 & T ? true : false;

export type YieldAndReturn<T> =
  T extends Promise<infer U>
    ? U
    : T extends AsyncGenerator<infer Y, infer R, any>
      ? Y | (IsAny<R> extends true ? never : R)
      : T extends Generator<infer Y, infer R, any>
        ? Y | (IsAny<R> extends true ? never : R)
        : T extends AsyncIterator<infer Y, infer R, any>
          ? Y | (IsAny<R> extends true ? never : R)
          : T extends Iterator<infer Y, infer R, any>
            ? Y | (IsAny<R> extends true ? never : R)
            : T extends AsyncIterable<infer U>
              ? U
              : T;

export type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T;

export type Vals<T> = T extends
  | Promise<any>
  | AsyncIterable<any>
  | AsyncIterator<any>
  | Iterator<any>
  ? Val<YieldAndReturn<T>>
  : Widen<T>;

export type ValsOf<T> = { -readonly [K in keyof T]: Vals<T[K]> };

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type AsyncKeys<T> = {
  [K in keyof T]-?: T[K] extends
    | Promise<any>
    | AsyncIterable<any>
    | AsyncIterator<any>
    | Iterator<any>
    ? K
    : never;
}[keyof T];

export interface FieldMapper {
  (key: keyof any, state: Val<any>, isArray: boolean): any;
  _T: unknown;
  type: unknown;
  spread?: boolean;
}

export interface DefaultMapper extends FieldMapper {
  type: ValsOf<this["_T"]>;
}

export type SpreadArrayItem<V> = V extends
  | Promise<any>
  | AsyncIterable<any>
  | AsyncIterator<any>
  | Iterator<any>
  ? {
      value: YieldAndReturn<V> | undefined;
      loading: boolean;
      error: unknown;
      done: boolean;
    }
  : Widen<V>;

export type SpreadArrayOf<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: SpreadArrayItem<T[K]>;
};

export interface SpreadMapper extends FieldMapper {
  type: this["_T"] extends readonly unknown[]
    ? SpreadArrayOf<this["_T"]>
    : Prettify<
        {
          -readonly [K in keyof this["_T"] as K extends string | number
            ? K
            : never]: this["_T"][K] extends
            | Promise<any>
            | AsyncIterable<any>
            | AsyncIterator<any>
            | Iterator<any>
            ? YieldAndReturn<this["_T"][K]> | undefined
            : Widen<this["_T"][K]>;
        } & {
          [K in AsyncKeys<this["_T"]> &
            (string | number) as `${K}Loading`]: boolean;
        } & {
          [K in AsyncKeys<this["_T"]> &
            (string | number) as `${K}Error`]: unknown;
        } & {
          [K in AsyncKeys<this["_T"]> &
            (string | number) as `${K}Done`]: boolean;
        }
      >;
}

export const spread = function spread(
  key: keyof any,
  state: Val<any>,
  isArray: boolean,
) {
  if (isArray) {
    // Stryker disable ConditionalExpression: state.value is undefined when pending/rejected, so it evaluates identically either way
    return {
      value: state.status === "fulfilled" ? state.value : undefined,
      // Stryker restore ConditionalExpression
      loading: state.status === "pending",
      error: state.status === "rejected" ? state.reason : null,
      done:
        state.status === "rejected" ||
        (state.status === "fulfilled" && (state.done ?? true)),
    };
  }
  return {
    // Stryker disable ConditionalExpression
    [key]: state.status === "fulfilled" ? state.value : undefined,
    // Stryker restore ConditionalExpression
    [`${String(key)}Loading`]: state.status === "pending",
    [`${String(key)}Error`]: state.status === "rejected" ? state.reason : null,
    [`${String(key)}Done`]:
      state.status === "rejected" ||
      (state.status === "fulfilled" && (state.done ?? true)),
  };
} as SpreadMapper;
spread.spread = true;

export type SimpleItem<V> = V extends
  | Promise<any>
  | AsyncIterable<any>
  | AsyncIterator<any>
  | Iterator<any>
  ? YieldAndReturn<V> | null
  : Widen<V>;

export type SimpleArrayOf<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: SimpleItem<T[K]>;
};

export interface SimpleMapper extends FieldMapper {
  type: this["_T"] extends readonly unknown[]
    ? SimpleArrayOf<this["_T"]>
    : Prettify<{
        -readonly [K in keyof this["_T"]]: SimpleItem<this["_T"][K]>;
      }>;
}

export const simple: SimpleMapper = function simple(
  _key: keyof any,
  state: Val<any>,
) {
  return state.status === "fulfilled" ? state.value : null;
} as any;
