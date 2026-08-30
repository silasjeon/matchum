// matchum extension — thin sensor/actuator.
// All state and user logic lives in the daemon; this worker only forwards
// browser events over native messaging and executes commands it receives.
// Pure decision logic lives in lib/core.js (unit-tested in test/unit.mjs);
// this file is the chrome.* glue.

importScripts("lib/core.js");
const {
  pick,
  isMeaningfulUpdate,
  toRegistration,
  wrapExec,
  classifyDaemonMessage,
  makeBroker,
  makeStateLatch,
} = matchumCore;

const HOST = "com.matchum.daemon";
const PROTOCOL_VERSION = 1;
let port = null;
let broker = null;

function setConnectionIndicator(text, title) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ color: "#c0392b" }).catch(() => {});
  chrome.action.setTitle({ title }).catch(() => {});
}

function dropPort(target, reason) {
  if (port !== target) return;
  port = null;
  broker?.cancelAll(reason || new Error("daemon disconnected"));
  setActivityEnabled(false).catch(() => {});
  setConnectionIndicator("!", `matchum: ${reason?.message || "daemon disconnected"}`);
}

function connect() {
  if (port) return;
  // Session storage can outlive the daemon connection. Pessimistically disable
  // page instrumentation until a compatible daemon explicitly enables it.
  setActivityEnabled(false).catch(() => {});
  let next;
  try {
    next = chrome.runtime.connectNative(HOST);
  } catch (e) {
    return;
  }
  port = next;
  setConnectionIndicator("…", "matchum: connecting to daemon");
  next.onMessage.addListener((msg) => onDaemonMessage(msg, next));
  next.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message;
    dropPort(next, new Error(message || "daemon disconnected"));
  });
  try {
    next.postMessage({ type: "hello", version: PROTOCOL_VERSION });
  } catch (e) {
    dropPort(next, e);
  }
}

function post(msg) {
  connect();
  const target = port;
  if (!target) throw new Error("daemon not connected");
  try {
    target.postMessage(msg);
  } catch (e) {
    dropPort(target, e);
    throw e;
  }
}

function send(msg) {
  try {
    post(msg);
  } catch (e) {
    /* best-effort event; the reconnect alarm will try again */
  }
}

function emit(event, data) {
  send({ type: "event", event, data });
}

// ---- event forwarding -------------------------------------------------

chrome.tabs.onCreated.addListener((tab) => emit("tab.created", { tab: pick(tab) }));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isMeaningfulUpdate(changeInfo)) {
    emit("tab.updated", { tab: pick(tab), change: changeInfo });
  }
});

chrome.tabs.onRemoved.addListener((tabId, info) =>
  emit("tab.removed", { tabId, windowId: info.windowId })
);

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    emit("tab.activated", { tab: pick(tab) });
  } catch (e) {
    /* tab may be gone already */
  }
});

chrome.windows.onFocusChanged.addListener((windowId) =>
  emit("window.focused", { windowId })
);

// User presence: "active" | "idle" (no input for 60s) | "locked". Event-driven,
// no polling on our side.
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => emit("idle.changed", { state }));

// ---- command handling -------------------------------------------------

let scriptSetChain = Promise.resolve();
async function scriptSetImpl(specs) {
  await chrome.userScripts.unregister();
  if (!specs?.length) return true;
  await chrome.userScripts.register(specs.map(toRegistration));
  return true;
}

// Page-side state shares one distribution pattern: persist in session storage
// (for late-loading content scripts and worker restarts), then broadcast.
const distributionChains = new Map();
async function distributeState(key, value, message) {
  const previous = distributionChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    await chrome.storage.session.set({ [key]: value });
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message)));
    return true;
  });
  distributionChains.set(key, current);
  try {
    return await current;
  } finally {
    if (distributionChains.get(key) === current) distributionChains.delete(key);
  }
}

function distributeSpecs(kind, specs) {
  const next = specs ?? [];
  return distributeState(`${kind}Specs`, next, { type: `${kind}.set`, specs: next });
}

const activityState = makeStateLatch((enabled) =>
  distributeState("activityEnabled", enabled, { type: "activity.set", enabled })
);

function setActivityEnabled(enabled) {
  return activityState.set(enabled);
}

const commands = {
  async "tabs.query"() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(pick);
  },

  async "tab.activate"({ tabId }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  },

  async "tab.close"({ tabId }) {
    await chrome.tabs.remove(tabId);
    return true;
  },

  async "tab.reload"({ tabId }) {
    await chrome.tabs.reload(tabId);
    return true;
  },

  async "ext.reload"() {
    // Respond first, then reload — reload kills this worker instantly.
    setTimeout(() => chrome.runtime.reload(), 100);
    return true;
  },

  async "tab.open"({ url, active }) {
    const tab = await chrome.tabs.create({ url, active: active ?? true });
    return pick(tab);
  },

  async "tab.group"({ tabId, name }) {
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({ title: name, windowId: tab.windowId });
    if (groups.length > 0) {
      await chrome.tabs.group({ tabIds: tabId, groupId: groups[0].id });
      return groups[0].id;
    }
    const groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, { title: name });
    return groupId;
  },

  async "tab.text"({ tabId }) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (document.body ? document.body.innerText.slice(0, 20000) : ""),
    });
    return res?.result ?? "";
  },

  async "tab.query"({ tabId, selector }) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel) =>
        Array.from(document.querySelectorAll(sel))
          .slice(0, 50)
          .map((el) => (el.innerText ?? el.textContent ?? "").trim()),
    });
    return res?.result ?? [];
  },

  "watch.set": ({ specs }) => distributeSpecs("watch", specs),
  "style.set": ({ specs }) => distributeSpecs("style", specs),
  "overlay.set": ({ specs }) => distributeSpecs("overlay", specs),
  "activity.set": ({ enabled }) => {
    if (typeof enabled !== "boolean") throw new Error("activity.set enabled must be a boolean");
    return setActivityEnabled(enabled);
  },

  // ---- user scripts (arbitrary JS in pages) ---------------------------
  // MV3 forbids remote code in extension contexts; chrome.userScripts is the
  // sanctioned channel for user-authored code. Requires the "Allow User
  // Scripts" toggle on the extension's details page.

  async "tab.exec"({ tabId, code, world }) {
    requireUserScripts();
    const results = await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code: wrapExec(code) }],
      world: world === "main" ? "MAIN" : "USER_SCRIPT",
    });
    const r = results?.[0];
    if (r?.error) throw new Error(r.error.message || String(r.error));
    return r?.result ?? null;
  },

  async "script.set"({ specs }) {
    requireUserScripts();
    // Serialize: concurrent calls would interleave unregister/register.
    const prev = scriptSetChain;
    let release;
    scriptSetChain = new Promise((r) => (release = r));
    try { await prev; } catch {}
    try { return await scriptSetImpl(specs); } finally { release(); }
  },

  async "tab.screenshot"({ tabId }) {
    // captureVisibleTab only sees the active tab of a window, so focus it.
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 250));
    }
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  },

  async "page.refresh"({ name }) {
    // Tell any open recipe page (page.html) to re-render. Fire and forget.
    chrome.runtime.sendMessage({ type: "page.refresh", name }).catch(() => {});
    return true;
  },

  async notify({ title, message }) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: title || "matchum",
      message: message || "",
    });
    return true;
  },
};

function requireUserScripts() {
  if (chrome.userScripts) return;
  const version = Number(navigator.userAgent.match(/(?:Chrome|Chromium)\/([0-9]+)/)?.[1]);
  const action =
    version >= 138
      ? `enable "Allow User Scripts" at chrome://extensions/?id=${chrome.runtime.id}`
      : "enable Developer mode at chrome://extensions";
  throw new Error(`userScripts unavailable — ${action}, then reload matchum`);
}

// Let USER_SCRIPT-world code talk back via chrome.runtime.sendMessage.
(async () => {
  try {
    await chrome.userScripts?.configureWorld({ messaging: true });
  } catch (e) {
    /* toggle off */
  }
})();

chrome.runtime.onUserScriptMessage?.addListener((msg, sender) => {
  if (msg?.type === "script.msg") emit("script.msg", { tabId: sender.tab?.id, url: sender.url, data: msg.data });
});

// ---- extension -> daemon requests (popup UI) --------------------------

broker = makeBroker({ send: post });
const request = (method, params) => broker.request(method, params);

function reply(target, msg) {
  if (port !== target) return;
  try {
    target.postMessage(msg);
  } catch (e) {
    dropPort(target, e);
  }
}

async function onDaemonMessage(msg, sourcePort) {
  if (msg?.type === "hello") {
    if (port !== sourcePort) return;
    if (msg.ok && msg.version === PROTOCOL_VERSION) {
      setConnectionIndicator("", "matchum recipes");
    } else {
      setConnectionIndicator("!", `matchum: ${msg.error || "protocol handshake failed"}`);
    }
    return;
  }
  const kind = classifyDaemonMessage(msg).kind;
  if (kind === "reply") {
    if (port === sourcePort) broker.onReply(msg);
    return;
  }
  if (kind !== "cmd") return;
  const fn = Object.hasOwn(commands, msg.method) ? commands[msg.method] : null;
  if (!fn) {
    reply(sourcePort, { type: "res", id: msg.id, ok: false, error: `unknown method: ${msg.method}` });
    return;
  }
  try {
    const result = await fn(msg.params ?? {});
    reply(sourcePort, { type: "res", id: msg.id, ok: true, result });
  } catch (e) {
    reply(sourcePort, { type: "res", id: msg.id, ok: false, error: String(e?.message ?? e) });
  }
}

// ---- content script bridge (watcher.js) -------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "watch.get") {
    chrome.storage.session.get("watchSpecs").then(
      (r) => sendResponse(r.watchSpecs ?? []),
      () => sendResponse([])
    );
    return true; // async sendResponse
  }
  if (msg?.type === "style.get") {
    chrome.storage.session.get("styleSpecs").then(
      (r) => sendResponse(r.styleSpecs ?? []),
      () => sendResponse([])
    );
    return true;
  }
  if (msg?.type === "daemon.req") {
    request(msg.method, msg.params)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (msg?.type === "overlay.get") {
    chrome.storage.session.get("overlaySpecs").then(
      (r) => sendResponse(r.overlaySpecs ?? []),
      () => sendResponse([])
    );
    return true;
  }
  if (msg?.type === "activity.get") {
    chrome.storage.session.get("activityEnabled").then(
      (result) => sendResponse(result.activityEnabled === true),
      () => sendResponse(false)
    );
    return true;
  }
  if (msg?.type === "activity" && msg.data) {
    emit("page.activity", { ...msg.data, tabId: sender.tab?.id });
  }
  if (msg?.type === "watch.hit" && msg.data) {
    emit("watch.hit", { ...msg.data, tabId: sender.tab?.id });
  }
});

// Connect whenever the service worker (re)starts, and retry periodically so
// a daemon that was killed (code update) comes back without waiting for a
// browser event. The alarm also keeps the worker from idling out for long.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("matchum-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "matchum-reconnect") connect();
});
connect();
