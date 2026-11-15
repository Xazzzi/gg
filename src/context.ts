import { StopError } from "./channel.ts";
import { bindPulled } from "./devtools.ts";
import { defer, waiting } from "./host.ts";
import type { Child } from "./jsx.ts";
import { noop } from "./source.ts";

declare const VALUE: unique symbol;
/** A context key, with the type of the value that its providers give. */
export type Context<T> = { readonly [VALUE]?: T };

/** Gives key as a context, so contexts compare by identity, as in the community context protocol. */
export const createContext = <T>(key: unknown) => key as Context<T>;

/** Answers context requests for context from inside its one element child, and gives that element. */
export function Provide<T>({
  context,
  value,
  children,
}: {
  context: Context<T>;
  value: T;
  children?: Child;
}): Element {
  if ((children as Node | undefined)?.nodeType !== 1)
    throw new TypeError("Provide needs one element child");
  (children as Element).addEventListener("context-request", (event: any) => {
    if (event.context !== context) return;
    event.stopPropagation();
    event.callback(value);
  });
  return children as Element;
}

/** Asks the providers above node for context with a context-request event, and gives the first answer. */
export function consume<T>(node: Node, context: Context<T>): T {
  let answer: { value: T } | undefined;
  const event = new Event("context-request", { bubbles: true, composed: true });
  node.dispatchEvent(
    Object.assign(event, {
      context,
      contextTarget: node,
      subscribe: false,
      callback: (value: T) => (answer ??= { value }),
    }),
  );
  if (!answer) throw new TypeError("No provider answered the context request");
  return answer.value;
}

/** Yields a placeholder, waits until the runtime places it (JX-02B), and gives the context from there. */
export async function* use<T>(
  context: Context<T>,
): AsyncGenerator<Comment, T, unknown> {
  const anchor = document.createComment(""),
    placed = Promise.withResolvers<void>();
  // A wait that ends with no place throws, so the component does not run on with no context (JX-054).
  const lost = { return: () => placed.reject(new StopError("use not placed")) };
  placed.promise.catch(noop); // The component reads the rejection only at its next pull
  defer(waiting, anchor, placed.resolve, lost.return);
  bindPulled(lost); // JX-041
  yield anchor;
  await placed.promise;
  return consume(anchor, context);
}
