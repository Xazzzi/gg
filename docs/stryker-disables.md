# Why Stryker disable comments?

They all fall into categories of being either mathematically unobservable, pure performance/algorithmic optimizations, or native JS spec compliances that are excessive to test:

### 1. Pure Performance Optimizations (Logically unobservable by outcome)

These mutations only affect CPU/Memory (like redundant allocations or O(N) vs O(1) fallbacks) and cannot be logically caught by a test since the final emitted state is perfectly identical.
- `select.ts` (Duplicate Promises): The early return `if (lastRef === res.value)` skips allocating redundant `.then()` chains.
- `select.ts` (Array Splice Math): Optimizations to shrink arrays from the end (saving a full array shift), skipping complex relocation boundary recalculations when offsets are identical, and skipping zero-offset mapping.
- `select.ts` (Empty Loops): Bailing out of emit early if `this.changes.size === 0` to avoid useless loop iterations.
- `relocated-proxy.ts` (Proxy Traps): Early returns like `if (!Number.isInteger(idx))` to avoid executing `getRelocation` math for float/symbol keys, which safely return `undefined` anyway.
- `utils.ts` (`findInMap` hint): The hint parameter is just an algorithmic O(1) map lookup shortcut before it falls back to iterating
the map in O(N). Disabling it just makes it slower, not broken.
- `channel.ts` (`rxHead` lock): A redundant assignment check that is completely masked by the synchronous FIFO microtask queue.

### 2. Native JS Array Spec Compliances (Impractical to exhaustively test)

We mimic the strict ECMAScript specs for native Arrays, but writing dedicated tests for every possible permutation is overkill.

- `select.ts` (Splice bounds): Boundary limits using `Math.max(deleteCount, 0)` on `splice` parameters to prevent negative index crashes.
- `select.ts` (Prototype binding): Checking `typeof val === "function"` to safely `.bind()` read-only native array methods (like `.map`, `.slice`, `.join`). We'd have to write dozens of tests covering every single prototype method just to satisfy coverage.

### 3. Inaccessible/Irrelevant Initializations

These are default states or declarations that are immediately overwritten or bypassed before they can be observed.

- `select.ts` (`relocations = []`): Initializing the array, which is completely blown away when an array mutator first executes.
- `select.ts` (`queued = false`): Initial state that is irrelevant because `this.start()` forces the first emit which hard-resets it immediately.
- `select.ts` (`changeValues` fallback): Safely zeroing out change tracking if no `onChanges` handler was provided.
- utils.ts (`isError = false`): A fallback flag in `unsend` that is only used internally where the return value is immediately discarded, so a mutant swapping it to true does nothing.

### 4. Polyfills & V8 Trace Drops

- `select.ts` (`Symbol.asyncDispose`): Fallback tracking for older environments without native async dispose. V8 coverage often drops these branches unless we explicitly pollute the global prototype to force the fallback.
- `select.ts` (math boundaries): Loop bounds (>= vs >) where the mathematical offset is natively never 0 anyway.
