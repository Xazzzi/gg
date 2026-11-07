// Pairs each panel with the relay in its inspected tab.
const panels = new Map<number, chrome.runtime.Port>();
const pages = new Map<number, chrome.runtime.Port>();
// A port can close before its onDisconnect runs, as in the back/forward cache, and then a post throws.
const post = (port: chrome.runtime.Port | undefined, message: unknown) => {
  try {
    port?.postMessage(message);
  } catch {}
};

const onPanel = (port: chrome.runtime.Port) => {
  let tab: number | undefined;
  port.onMessage.addListener(message => {
    if (message.tabId === undefined) {
      if (tab !== undefined) post(pages.get(tab), message);
      return;
    }
    tab = message.tabId as number;
    panels.set(tab, port);
    chrome.tabs
      .sendMessage(tab, { gg: "connect" }, { frameId: 0 })
      .catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (tab === undefined || panels.get(tab) !== port) return;
    panels.delete(tab);
    pages.get(tab)?.disconnect();
    pages.delete(tab);
  });
};

const onPage = (port: chrome.runtime.Port) => {
  const tab = port.sender?.tab?.id;
  if (tab === undefined) return port.disconnect();
  pages.get(tab)?.disconnect();
  pages.set(tab, port);
  port.onMessage.addListener(message => post(panels.get(tab), message));
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (pages.get(tab) === port) pages.delete(tab);
  });
};

chrome.runtime.onConnect.addListener(port =>
  port.name === "gg-panel" ? onPanel(port) : onPage(port),
);
// A relay asks at page load, so a reload reconnects to an open panel.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.gg === "hello") reply(panels.has(sender.tab?.id as number));
});
