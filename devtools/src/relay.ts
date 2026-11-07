// Runs in the isolated world, and forwards between hook.ts and the background worker.
// It connects only while a panel for this tab is open.
{
  let port: chrome.runtime.Port | undefined;
  const toPage = (command: object) =>
    document.dispatchEvent(
      new CustomEvent("gg-devtools:panel", { detail: JSON.stringify(command) }),
    );
  // An old port's onDisconnect can run after a new port connects, so it checks its own port.
  const drop = (own: chrome.runtime.Port) => {
    void chrome.runtime.lastError;
    if (port !== own) return;
    port = undefined;
    toPage({ type: "disconnect" });
  };
  const connect = () => {
    if (port) return;
    const own = (port = chrome.runtime.connect({ name: "gg-page" }));
    own.onMessage.addListener(toPage);
    own.onDisconnect.addListener(() => drop(own));
    toPage({ type: "connect" });
  };
  const hello = () =>
    chrome.runtime.sendMessage({ gg: "hello" }).then(
      open => open && connect(),
      () => {},
    );
  document.addEventListener("gg-devtools:page", event => {
    if (!port) return;
    try {
      port.postMessage((event as CustomEvent).detail);
    } catch {
      drop(port);
      hello();
    }
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.gg === "connect") connect();
  });
  // The back/forward cache closes the port, so a restored page connects again.
  addEventListener("pageshow", event => {
    if (!event.persisted) return;
    if (port) drop(port);
    hello();
  });
  hello();
}
