# Tiny zero-dependency, robust, and highly concurrent primitives for modern JavaScript/TypeScript.

Based on modern APIs (`Promise.withResolvers`, `AbortController`, `Symbol.asyncIterator`) and rigorously tested for 100% native coverage, including mutation testing via [Stryker](https://stryker-mutator.io/).

- Minified: 9.8 kB
- Minified + Gzipped: 3.3 kB

See [comparison](./docs/Comparison) to other libraries out there.

## [**Channel**](./docs/channel.md)

An MPMC (Multi-Producer, Multi-Consumer) Async Iterable stream primitive featuring strict memory safety, backpressure (`asend`), and configurable backlog policies.

## [**Select**](./docs/select.md)

A reactive multiplexer that tracks multiple async sources (Promises, Iterables) within a single unified Proxy shape, emitting synchronized state snapshots as sources resolve or yield.
