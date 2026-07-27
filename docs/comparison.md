# Comparisons

## 1. RxJS (ReactiveX)

The `Channel` primitive maps directly to RxJS `Subject`, `BehaviorSubject`, and `ReplaySubject`. This depends on your `firstReceive` and `thenReceive` configuration.
The `select` primitive operates like RxJS `combineLatest`.

RxJS has a large API surface and uses proprietary `Observable` chains.
We keep surface minimal and use native `async/await` and `for await...of` loops.

## 2. Go-Style CSP Channels (core-async, csp-js)

Go-style channels are queues. If one consumer reads a value, it takes it from others.
The `Channel` primitive is a multi-producer, multi-consumer broadcaster.
You can configure it to let multiple consumers read the exact same values.
Consumers can skip to the latest sent value in a channel skipping reads of intermediate values.

We do not have an explicit queue depth setting.
The `asend()` method gives backpressure. This blocks the producer until a consumer reads.

You can arbitrarily add or remove async sources that drive `select`.

## 3. Node EventEmitter and EventTarget

EventEmitters do not queue for events or handle backpressure on their own. If events are emitted faster than listeners process them, memory usage will grow unchecked. They drop events if you attach a listener too late.

## 4. Reactive state stores like MobX and Vue

Those track synchronous property accesses to build dependency graphs.
With `select` you give it explicit shape of async dependencies that drive updates.
Then you read synchronous snapshots of dependencies states from a `Channel` that `select` publishes to.
