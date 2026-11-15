import { mount } from "@xazzzi/gg";

// A web component that shows its items as chips in its shadow root.
// A click on a chip dispatches chipRemoved with its item, and the page decides what to remove.
export class ChipList extends HTMLElement {
  #items: readonly string[] = [];
  #root = this.attachShadow({ mode: "open" });

  get items() {
    return this.#items;
  }

  // gg assigns this property, because the class defines it, so it takes an array.
  set items(items: readonly string[]) {
    this.#items = items;
    mount(
      this.#root,
      <style>
        {`button { font: inherit; margin: 0 4px 4px 0; border: 1px solid #b8c2d6; border-radius: 12px; background: #fff; padding: 2px 10px; cursor: pointer; }`}
      </style>,
      items.map(item => (
        <button
          type="button"
          title={`Remove ${item}`}
          onclick={() =>
            this.dispatchEvent(
              new CustomEvent("chipRemoved", { detail: item, bubbles: true }),
            )
          }
        >
          {item}
        </button>
      )),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chip-list": ChipList;
  }
}
