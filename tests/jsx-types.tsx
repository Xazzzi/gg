// Type checks of JSX props, which `npm run type` compiles and no test runs.
import type { Channel } from "../src/index.ts";

declare const text: Channel<string>;
declare const flag: Promise<boolean>;

export const typed = [
  <input
    value={text}
    checked={flag}
    oninput={event => event.currentTarget.value.trim()}
    onkeydown={event => event.key}
    onClick={event => event.anything}
    data-id={1}
  />,
  <div class={text} style="color: red" hidden value={{ any: 1 }} />,
  <svg
    aria-label="x"
    viewBox="0 0 1 1"
    onclick={event => event.currentTarget.viewBox}
  >
    <path d="M0 0" />
  </svg>,
  <my-element anything={{}} onthing={(event: CustomEvent) => event.detail} />,
  // @ts-expect-error a style object is not a string
  <div style={{ color: "red" }} />,
  // @ts-expect-error checked is a boolean
  <input checked="yes" />,
  // @ts-expect-error a div has no value property to read
  <div onclick={event => event.currentTarget.value} />,
  // @ts-expect-error a keydown event has no detail text
  <input onkeydown={(event: CustomEvent<string>) => event.detail} />,
];
