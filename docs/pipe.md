# Pipe

The `pipe` function connects a source to a new channel. The source sends values to the channel. The source can be a `Promise`, `AsyncIterable`, `AsyncIterator`, `Iterable`, or `Iterator`. The function creates and returns a new channel. You can pass a combined `PipeOptions & ChannelOptions` object to configure the pipe behavior and the new channel.

## Signature

```typescript
function pipe<T>(
  source: Source<T>,
  options?: PipeOptions & ChannelOptions
): Channel<T>;
```

## Options

The `options` object configures the pipe behavior.

*   `autoStart`: If true, the pipe starts immediately. If false, the pipe waits for a consumer to read from the channel before it starts. The default is false.
*   `autoClose`: If true, the pipe closes the channel when all connected sources finish. If `"strong"`, the pipe closes the channel when the current source finishes, even if other sources are active. The default is true.
*   `backPressure`: If true, the pipe waits for the channel to consume the value before it reads the next value from the source. The pipe throws an error if `backPressure` is false and the source is synchronous. The default is true.
*   `onThrow`: If `"throw"`, the pipe sends errors from the source to the channel. If `"ignore"`, the pipe ignores errors. The default is `"throw"`.
*   `onReturn`: If `"close"`, the pipe evaluates the `autoClose` rule. If `"ignore"`, the pipe keeps the channel open. The default is `"close"`.

## Feed

The `feed` function sends values from a source to an existing channel. It returns a promise that resolves when the source finishes. You can use this promise to wait for the data transfer to complete.

### Signature

```typescript
function feed<T>(
  source: Source<T>,
  channel: Channel<T>,
  options?: PipeOptions
): Promise<void>;
```

## Examples

Use the `pipe` to merge multiple asynchronous streams into a single channel. The channel interleaves the values as they arrive. The channel closes when all streams finish.

```typescript
import { Channel } from "./src/channel.ts";

async function* logsStream(server: string) {
  yield `Log from ${server}`;
}

const channel = new Channel();

channel.pipe(logsStream("Server A"));
channel.pipe(logsStream("Server B"));

for await (const log of channel) {
  console.log(log);
}
```

Use the pipe to convert a raw asynchronous generator into a work queue. The `thenReceive: "unread"` option makes sure exactly one worker processes each item.

```typescript
import { pipe } from "./src/pipe.ts";

async function* workStream() {
  for (let i = 1; i <= 10000; i++) {
    yield `Data ${i}`;
  }
}

// Create a new channel directly from the source
const channel = pipe(workStream(), { thenReceive: "unread" });

async function * worker() {
  for await (const data of channel) {
    console.log('Simulate async processing of', data);
    await new Promise(ok => setTimeout(ok, 100 + 1000 * Math.random()));
  }
}

const WORKERS = 100;
select(
  Array(WORKERS).fill().map(() => worker()),
  { autoStart: true }
);
```
