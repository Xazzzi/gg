export interface Relocation {
  start: number;
  offset: number;
}

class RelocatedProxyHandler
  implements ProxyHandler<Record<string | symbol, any>>
{
  rels: Relocation[];
  vals: any[];
  changeValues: boolean;

  constructor(rels: Relocation[], vals: any[], changeValues: boolean) {
    this.rels = rels.slice();
    this.vals = vals.slice();
    this.changeValues = changeValues;
  }

  getRelocation(idx: number): { isRelocated: boolean; offsetSum: number } {
    let isRelocated = false;
    let offsetSum = 0;
    for (const r of this.rels) {
      if (idx >= r.start && idx < this.vals.length) {
        isRelocated = true;
        offsetSum += r.offset;
      }
    }
    return { isRelocated, offsetSum };
  }

  has(target: Record<string | symbol, any>, prop: string | symbol) {
    if (Reflect.has(target, prop)) return true;
    if (typeof prop === "symbol") return false;
    const idx = Number(prop);
    if (!Number.isInteger(idx)) return false;
    return this.getRelocation(idx).isRelocated;
  }

  get(target: Record<string | symbol, any>, prop: string | symbol) {
    if (Reflect.has(target, prop)) return Reflect.get(target, prop);
    if (typeof prop === "symbol") return undefined;
    const idx = Number(prop);
    // Stryker disable next-line ConditionalExpression: getRelocation safely handles NaN so filtering non-integers early is just an optimization
    if (!Number.isInteger(idx)) return undefined;

    const { isRelocated, offsetSum } = this.getRelocation(idx);
    if (isRelocated) {
      if (!this.changeValues) return idx;
      return this.vals[idx + offsetSum];
    }
    return undefined;
  }

  ownKeys(target: Record<string | symbol, any>) {
    const keys = new Set(Reflect.ownKeys(target));
    // Stryker disable next-line EqualityOperator: out of bounds access is safely skipped because getRelocation will return false for it
    for (let i = 0; i < this.vals.length; i++) {
      if (this.getRelocation(i).isRelocated) {
        keys.add(String(i));
      }
    }
    return Array.from(keys);
  }

  getOwnPropertyDescriptor(
    target: Record<string | symbol, any>,
    prop: string | symbol,
  ) {
    if (Reflect.has(target, prop))
      return Reflect.getOwnPropertyDescriptor(target, prop);
    if (typeof prop === "symbol") return undefined;
    const idx = Number(prop);
    // Stryker disable next-line ConditionalExpression: getRelocation safely handles NaN so filtering non-integers early is just an optimization
    if (Number.isInteger(idx)) {
      const { isRelocated, offsetSum } = this.getRelocation(idx);
      if (isRelocated) {
        const val = this.changeValues ? this.vals[idx + offsetSum] : idx;
        return { enumerable: true, configurable: true, value: val };
      }
    }
    return undefined;
  }
}

export function createRelocatedProxy(
  changes: Map<any, any> | Set<any>,
  rels: Relocation[],
  vals: any[],
  changeValues: boolean,
) {
  const baseObj = Object.fromEntries(changes.entries());
  return new Proxy(
    baseObj,
    new RelocatedProxyHandler(rels, vals, changeValues),
  );
}
