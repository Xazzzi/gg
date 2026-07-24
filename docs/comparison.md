# Comparisons to other libraries

In terms of functionality, `gg` sits at a really interesting intersection of a few different ecosystems. By leveraging native `AsyncIterable` and `Promise.withResolvers`, it achieves things that normally require massive libraries or proprietary syntax.

Here is how it stacks up against the major players:

## 1. **RxJS (ReactiveX)**
This is the closest major comparison. 
- **`Channel`** maps directly to RxJS `Subject`, `BehaviorSubject`, and `ReplaySubject` depending on how you configure `firstReceive` and `thenReceive`.
- **`select`** is functionally very similar to RxJS's `combineLatest`, but significantly more ergonomic because it projects the streams directly onto a Proxy object/array.
- **The big difference:** RxJS comes with huge API surface, uses proprietary `Observable` chains and callbacks (`.subscribe()`), which are notoriously difficult to debug and have a steep learning curve. `gg` relies 100% on native `async/await` and `for await...of` loops, making stack traces readable and keeping the bundle size microscopic (9.8kb vs RxJS's ~40kb+).

## 2. **Go-Style CSP Channels (`core-async`, `csp-js`)**
There are many libraries that try to emulate Go's channels in JavaScript (`put`, `take`, `alts!`).
- **`Channel.asend()`** provides backpressure (blocking the producer until a consumer reads) that Go channels are famous for, but no explicit queue depth setting is available.
- **The big difference:** Traditional CSP channels are "queues" (if one consumer reads a value, it steals it from others). `gg`'s `Channel` is a true MPMC (Multi-Producer, Multi-Consumer) broadcaster. You can configure it so that multiple consumers read the exact same values, or have consumers skip to the `latest` dropped frames, which Go channels cannot natively do.

## 3. **Node's native `EventEmitter` / `EventTarget`**
Often, people use `EventEmitter` for pub/sub. 
- **The big difference:** EventEmitters have no concept of backpressure (if you emit faster than they process, you flood memory), no built-in memory management for unread values, and they drop events if you attach a listener too late. `gg`'s `Channel` solves all of this natively with `asend()` and `firstReceive: 'unread'`.

## 4. **MobX / Vue Reactivity (Reactivity Stores)**
- **`select`** feels a bit like a reactive state store. You hand it a shape of raw Promises and AsyncIterables, and it spits out synchronous snapshots of their resolved states (`pending`, `fulfilled`, `rejected`). 
- **The big difference:** Unlike MobX which tracks synchronous property access to build dependency graphs, `select` is specifically a *multiplexer* designed to tame async race conditions across multiple network/worker streams simultaneously.

**In summary:** `gg` gives you the reactive stream composition of **RxJS**, the concurrency backpressure of **Go Channels**, and the unified state shape of **MobX**, but it does it all using standard JavaScript `for await` loops without any external dependencies.
