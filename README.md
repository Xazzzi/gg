# Tiny zero-dependency, robust, and highly concurrent primitives for modern JavaScript/TypeScript.

Based on modern APIs and rigorously tested for 100% coverage, including mutation testing via [Stryker](https://stryker-mutator.io/).

- Minified: 11.1 kB
- Minified + Gzipped: 3.8 kB

See [comparison](./docs/comparison.md) to other libraries out there.

## [**Channel**](./docs/channel.md)

An MPMC (Multi-Producer, Multi-Consumer) Async Iterable stream primitive featuring strict memory safety, backpressure (`asend`), and configurable backlog policies.

## [**Pipe**](./docs/pipe.md)

A utility to connect sources to a Channel. The pipe supports lazy start, backpressure, and multiple source tracking.

## [**Select**](./docs/select.md)

A reactive multiplexer that tracks multiple async sources (Promises, Iterables) within a single unified Proxy shape, emitting synchronized state snapshots as sources resolve or yield.
