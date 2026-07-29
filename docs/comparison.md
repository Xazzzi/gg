# Comparisons

## 1. RxJS (ReactiveX)

The `Channel` primitive maps directly to RxJS `Subject`, `BehaviorSubject`, and `ReplaySubject`. This depends on your `firstReceive` and `thenReceive` configuration.
The `select` primitive operates like RxJS `combineLatest`.

RxJS has a large API surface and uses proprietary `Observable` chains.
We keep surface minimal and use native `async/await` and `for await...of` loops.

## 2. Go-Style CSP Channels (core-async, csp-js)

Go-style channels are queues. If one consumer reads a value, it takes the value from other consumers.

The `Channel` primitive operates as a broadcaster or a work queue. You can use the `"unread"` mode to create a work queue. In this mode, exactly one consumer receives each value.

You can use the default mode to broadcast. This mode lets multiple consumers read the same values. Consumers can also skip to the latest value and drop old values.

We do not have an explicit queue depth setting. The `asend()` method provides backpressure. This method blocks the producer until a consumer reads a value.

You can add or remove async sources that drive `select` at any time.

## 3. Node EventEmitter and EventTarget

EventEmitters do not queue for events or handle backpressure on their own. If events are emitted faster than listeners process them, memory usage will grow unchecked. They drop events if you attach a listener too late.

## 4. Reactive state stores like MobX and Vue

Those track synchronous property accesses to build dependency graphs.
With `select` you give it explicit shape of async dependencies that drive updates.
Then you read synchronous snapshots of dependencies states from a `Channel` that `select` publishes to.
