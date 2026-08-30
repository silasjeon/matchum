#!/usr/bin/env node
// matchum daemon — runs the user's config, holds all state.
// Launched by Chrome via native messaging; speaks length-prefixed JSON on
// stdin/stdout with the extension, and JSON-lines on a unix socket with the CLI.
//
// IMPORTANT: stdout is reserved for the native messaging channel.
// Never console.log here — use log() (file + stderr).

"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const {
  MAX_TIMER_DELAY_MS,
  createConfigState,
  snapshotRegistrations,
  restoreRegistrations,
  disposeConfigState,
  parseInterval,
  regexMatches,
  parseRecipeState,
} = require("./lib/core.js");
const {
  collectModuleGraph,
  snapshotModules,
  evictModules,
  restoreModules,
} = require("./lib/module-graph.js");
const { encode, createDecoder } = require("./lib/native-messaging.js");
const {
  snapshotScript,
  visibleTextScript,
  clickScript,
  typeScript,
} = require("./lib/page-scripts.js");

const PROTOCOL_VERSION = 1;
const MAX_CLI_REQUEST_BYTES = 1024 * 1024;
const RUNTIME_MODULES = new Set(Object.keys(require.cache));

let extConnected = false;
let protocolError = null;

const STATE_DIR =
  process.env.MATCHUM_STATE_DIR || path.join(os.homedir(), ".local", "state", "matchum");
const CONFIG_PATH =
  process.env.MATCHUM_CONFIG || path.join(os.homedir(), ".config", "matchum", "config.js");
const SOCK_PATH = process.env.MATCHUM_SOCK || path.join(STATE_DIR, "matchum.sock");
const LOG_PATH = path.join(STATE_DIR, "daemon.log");

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(STATE_DIR, 0o700);
} catch (e) {
  // Some filesystems do not expose Unix permissions. The socket itself is
  // hardened separately when the platform supports it.
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    /* ignore */
  }
  process.stderr.write(line);
}

// ---- native messaging framing (extension <-> daemon) -------------------

// If the extension side goes away mid-write (reload/shutdown), stdout
// raises EPIPE; without a handler that would crash the daemon.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") log("stdout EPIPE (extension gone), awaiting exit");
  else log(`stdout error: ${e.message}`);
});

function sendToExt(msg) {
  process.stdout.write(encode(msg));
}

function sendReplyToExt(msg) {
  try {
    sendToExt(msg);
  } catch (e) {
    log(`reply failed: ${e.message}`);
    try {
      sendToExt({ type: "reply", id: msg.id, ok: false, error: e.message });
    } catch (fallbackError) {
      log(`fallback reply failed: ${fallbackError.message}`);
    }
  }
}

const decodeNativeMessage = createDecoder({
  onMessage: onExtMessage,
  onInvalidJson: () => log("drop: unparseable frame"),
});
process.stdin.on("data", (chunk) => {
  try {
    decodeNativeMessage(chunk);
  } catch (e) {
    log(e.message);
    shutdown(1);
  }
});

process.stdin.on("end", () => {
  log("extension disconnected, exiting");
  shutdown(0);
});

// ---- command round-trips (daemon -> extension) -------------------------

let nextCmdId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}
const CMD_TIMEOUT_MS = 10000;

function cmd(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextCmdId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`command timed out: ${method}`));
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      sendToExt({ type: "cmd", id, method, params: params ?? {} });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// ---- strict message validation ----------------------------------------

function onExtMessage(msg) {
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    log("drop: invalid message shape");
    return;
  }
  switch (msg.type) {
    case "hello":
      if (msg.version !== PROTOCOL_VERSION) {
        extConnected = false;
        protocolError = `protocol mismatch: extension v${msg.version}, daemon v${PROTOCOL_VERSION}`;
        log(protocolError);
        sendToExt({ type: "hello", ok: false, version: PROTOCOL_VERSION, error: protocolError });
        return;
      }
      log(`extension connected (protocol v${msg.version})`);
      extConnected = true;
      protocolError = null;
      sendToExt({ type: "hello", ok: true, version: PROTOCOL_VERSION });
      syncExtensionState();
      flushConfigFailureNotice();
      break;
    case "res": {
      if (!Number.isSafeInteger(msg.id)) return log("drop: res without id");
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "command failed"));
      break;
    }
    case "event": {
      if (!extConnected) return log("drop: event before a compatible handshake");
      if (typeof msg.event !== "string" || msg.event.length > 128) return log("drop: invalid event name");
      dispatch(msg.event, msg.data ?? {});
      break;
    }
    case "req": {
      // Extension-initiated request (popup UI). Answered with a reply frame.
      if (
        !Number.isSafeInteger(msg.id) ||
        typeof msg.method !== "string" ||
        msg.method.length > 128
      ) {
        return log("drop: bad req");
      }
      if (!extConnected) {
        return sendReplyToExt({
          type: "reply",
          id: msg.id,
          ok: false,
          error: protocolError || "protocol handshake not complete",
        });
      }
      const fn = Object.hasOwn(extRequests, msg.method) ? extRequests[msg.method] : null;
      if (!fn) return sendReplyToExt({ type: "reply", id: msg.id, ok: false, error: `unknown method: ${msg.method}` });
      Promise.resolve()
        .then(() => fn(msg.params ?? {}))
        .then((result) => sendReplyToExt({ type: "reply", id: msg.id, ok: true, result }))
        .catch((e) => sendReplyToExt({ type: "reply", id: msg.id, ok: false, error: String(e?.message ?? e) }));
      break;
    }
    default:
      log(`drop: unknown type ${msg.type}`);
  }
}

// ---- user config runtime ----------------------------------------------

let state = createConfigState();
let nextWatchId = 1;
let loadingConfig = false;
let loadingModuleRoots = null;
let configModules = new Set();
let watchedModuleFiles = new Set();
let pendingConfigFailureNotice = null;
let configStatus = {
  ok: true,
  error: null,
  loadedAt: null,
  failedAt: null,
  retainedPrevious: false,
};

// ---- recipes: on/off-able units of config ------------------------------
// matchum.use(name, opts) loads config/recipes/<name>.js (or a path) unless the
// user switched it off in the popup. Switch state lives in recipes.json so
// it survives config reloads and daemon restarts.
// User recipes live in user space; the repo dir only ships examples.
const USER_RECIPES_DIR = path.join(path.dirname(CONFIG_PATH), "recipes");
const SHIPPED_RECIPES_DIR = path.join(__dirname, "..", "config", "recipes");
const RECIPES_STATE = process.env.MATCHUM_RECIPES_STATE || path.join(STATE_DIR, "recipes.json");

function readRecipeState() {
  try {
    return parseRecipeState(fs.readFileSync(RECIPES_STATE, "utf8"));
  } catch (e) {
    return Object.create(null);
  }
}
function writeRecipeState(obj) {
  const tmp = `${RECIPES_STATE}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(RECIPES_STATE), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, RECIPES_STATE);
    try {
      fs.chmodSync(RECIPES_STATE, 0o600);
    } catch (e) {
      /* non-POSIX filesystem */
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      /* rename succeeded, or the temporary file never existed */
    }
  }
}
function resolveRecipe(name) {
  if (name.includes("/")) {
    const file = path.isAbsolute(name) ? name : path.resolve(path.dirname(CONFIG_PATH), name);
    return require.resolve(file);
  }
  for (const dir of [USER_RECIPES_DIR, SHIPPED_RECIPES_DIR]) {
    try {
      return require.resolve(path.join(dir, `${name}.js`));
    } catch (e) {
      if (e?.code !== "MODULE_NOT_FOUND") throw e;
      /* try next */
    }
  }
  throw new Error(`recipe "${name}" not found in ${USER_RECIPES_DIR} or ${SHIPPED_RECIPES_DIR}`);
}

const extRequests = {
  async "system.status"() {
    return runtimeStatus();
  },
  async "recipes.list"() {
    return state.recipes;
  },
  async "recipes.page"({ name }) {
    if (typeof name !== "string" || !name) throw new Error("name required");
    const fn = state.pages.get(name);
    if (!fn) throw new Error(`recipe "${name}" has no page (or is switched off)`);
    const out = await fn();
    return {
      title: String(out?.title ?? ""),
      html: String(out?.html ?? ""),
      css: String(out?.css ?? ""),
    };
  },
  async "recipes.set"({ name, enabled }) {
    if (typeof name !== "string" || !name) throw new Error("name required");
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    if (!state.recipes.some((recipe) => recipe.name === name)) {
      throw new Error(`recipe "${name}" is not present in the current config`);
    }
    const st = readRecipeState();
    st[name] = enabled;
    writeRecipeState(st);
    loadConfig(); // re-run config: use() now sees the new switch state
    return state.recipes;
  },
};

// Ship current watch specs to the extension, which fans them out to
// content scripts (watcher.js) in every matching page.
function pushWatches() {
  if (!extConnected) return;
  const specs = state.watches.map((w) => ({
    id: w.id,
    source: w.pattern.source,
    flags: w.pattern.flags,
    selector: w.selector,
    debounceMs: w.debounceMs,
  }));
  cmd("watch.set", { specs }).catch((e) => log(`watch.set failed: ${e.message}`));
}

function pushStyles() {
  if (!extConnected) return;
  const specs = state.styles.map((s) => ({
    id: s.id,
    source: s.pattern.source,
    flags: s.pattern.flags,
    css: s.css,
  }));
  cmd("style.set", { specs }).catch((e) => log(`style.set failed: ${e.message}`));
}

function pushActivity() {
  if (!extConnected) return;
  const enabled = (state.handlers.get("page.activity")?.length ?? 0) > 0;
  cmd("activity.set", { enabled }).catch((e) => log(`activity.set failed: ${e.message}`));
}

// Overlays change often (every tab switch re-renders), so coalesce pushes.
let overlayTimer = null;
function pushOverlays(immediate) {
  if (!extConnected) return;
  clearTimeout(overlayTimer);
  const doPush = () => {
    overlayTimer = null;
    const specs = [...state.overlays].map(([id, o]) => ({
      id,
      source: o.pattern.source,
      flags: o.pattern.flags,
      html: o.html,
      css: o.css,
    }));
    cmd("overlay.set", { specs }).catch((e) => log(`overlay.set failed: ${e.message}`));
  };
  if (immediate) doPush();
  else overlayTimer = setTimeout(doPush, 50);
}

let pushScriptsTimer = null;
// Coalesce bursts (config load registers N scripts in a row) into one script.set
// so unregister/register pairs can't interleave in the extension.
function pushScripts() {
  if (!extConnected) return;
  clearTimeout(pushScriptsTimer);
  pushScriptsTimer = setTimeout(pushScriptsNow, 20);
}
function pushScriptsNow() {
  if (!extConnected) return;
  const specs = state.scripts.map((s) => ({
    id: s.id,
    source: s.pattern.source,
    flags: s.pattern.flags,
    code: s.code,
    world: s.world,
  }));
  cmd("script.set", { specs }).catch((e) => log(`script.set failed: ${e.message}`));
}

// Phase 1: run a synchronous in-page action returning {acted, urlBefore}.
// Phase 2: after settleMs, read the tab's url/title from the browser itself —
// evidence that survives full navigations (which strand in-page promises).
async function actWithEvidence(tabId, code, { settleMs = 600 } = {}) {
  const pre = await cmd("tab.exec", { tabId, code });
  await new Promise((r) => setTimeout(r, settleMs));
  const tab = (await cmd("tabs.query")).find((x) => x.id === tabId);
  if (!tab) return { ...pre.acted, navigated: true, url: null, title: null, note: "tab closed by the action" };
  return { ...pre.acted, navigated: tab.url !== pre.urlBefore, url: tab.url, title: tab.title, status: tab.status };
}

function wrapTab(t) {
  return {
    ...t,
    activate: () => cmd("tab.activate", { tabId: t.id }),
    close: () => cmd("tab.close", { tabId: t.id }),
    reload: () => cmd("tab.reload", { tabId: t.id }),
    moveToGroup: (name) => cmd("tab.group", { tabId: t.id, name }),
    text: () => cmd("tab.text", { tabId: t.id }),
    query: (selector) => cmd("tab.query", { tabId: t.id, selector }),
    // Run JS inside the page (USER_SCRIPT world by default; {world:"main"}
    // shares the site's JS context). `return` and `await` both work.
    exec: (code, opts = {}) => cmd("tab.exec", { tabId: t.id, code: String(code), world: opts.world }),
    // {viewport:true} → only elements on screen; every item also carries inView.
    snapshot: (opts = {}) =>
      cmd("tab.exec", { tabId: t.id, code: snapshotScript({ viewport: !!opts.viewport }) }),
    // Only the text currently on screen (what the user is actually looking at).
    visibleText: () => cmd("tab.exec", { tabId: t.id, code: visibleTextScript() }),
    // Click/type by snapshot index. Both return EVIDENCE, not `true`, so the
    // agent needs no separate verification turn. Two-phase: the in-page script
    // acts and returns synchronously (never awaits across a possible
    // navigation — a full nav would strand the promise until timeout); the
    // daemon then waits and reads the outcome url/title from tabs.query,
    // which survives any navigation.
    click: (i) => actWithEvidence(t.id, clickScript(i)),
    type: (i, text, opts = {}) =>
      actWithEvidence(t.id, typeScript(i, text, { enter: !!opts.enter }), {
        settleMs: opts.enter ? 800 : 150,
      }),
    // Saves a PNG and returns its path (default ~/.local/state/matchum/shots/).
    async screenshot(file) {
      const dataUrl = await cmd("tab.screenshot", { tabId: t.id });
      const out =
        file ||
        path.join(STATE_DIR, "shots", `${new Date().toISOString().replace(/[:.]/g, "-")}-${t.id}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
      return out;
    },
  };
}

const matchum = {
  on(event, fn) {
    if (typeof event !== "string" || !event || typeof fn !== "function")
      throw new Error("matchum.on(event: non-empty string, handler: function)");
    if (!state.handlers.has(event)) state.handlers.set(event, []);
    state.handlers.get(event).push(fn);
    if (!loadingConfig && event === "page.activity") pushActivity();
  },

  rule({ match, action }) {
    if (!(match instanceof RegExp) || typeof action !== "function")
      throw new Error("matchum.rule({match: RegExp, action: function})");
    state.rules.push({ match, action });
  },

  every(spec, fn) {
    if (typeof fn !== "function") throw new Error("matchum.every(interval, handler: function)");
    const ms = parseInterval(spec);
    state.timers.push(setInterval(() => runUser(fn, `every(${spec})`), ms));
  },

  watch(pattern, selector, handler, opts = {}) {
    if (!(pattern instanceof RegExp) || typeof selector !== "string" || typeof handler !== "function")
      throw new Error("matchum.watch(pattern: RegExp, selector: string, handler: function, opts?)");
    const debounceMs = opts.debounceMs ?? 800;
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`matchum.watch: debounceMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`);
    }
    const id = `w${nextWatchId++}`;
    state.watches.push({
      id,
      pattern,
      selector,
      handler,
      debounceMs,
    });
  },

  style(pattern, css) {
    if (!(pattern instanceof RegExp) || typeof css !== "string")
      throw new Error("matchum.style(pattern: RegExp, css: string)");
    state.styles.push({ id: `s${state.styles.length + 1}`, pattern, css });
  },

  // Render an HTML widget inside every page matching pattern (Shadow DOM, so
  // page CSS can't touch it). Idempotent by id: call again to re-render.
  overlay(id, pattern, { html = "", css = "" } = {}) {
    if (typeof id !== "string" || !id || !(pattern instanceof RegExp))
      throw new Error("matchum.overlay(id: non-empty string, pattern: RegExp, {html, css})");
    state.overlays.set(id, { pattern, html: String(html), css: String(css) });
    if (!loadingConfig) pushOverlays();
  },

  // Persistent user script (Tampermonkey-style): runs in every page matching
  // pattern at document_idle, re-registered on config reload. Inside the
  // script, `matchum.emit(data)` is not available — use
  // chrome.runtime.sendMessage({type:"script.msg", data}) and handle it with
  // matchum.on("script.msg", ...) here.
  run(pattern, code, opts = {}) {
    if (!(pattern instanceof RegExp) || typeof code !== "string")
      throw new Error("matchum.run(pattern: RegExp, js: string, {world?: 'main'})");
    if (opts.world !== undefined && opts.world !== "main") {
      throw new Error("matchum.run: world must be \"main\" when provided");
    }
    state.scripts.push({ id: `u${state.scripts.length + 1}`, pattern, code, world: opts.world });
    if (!loadingConfig) pushScripts();
  },

  // Load a recipe module (config/recipes/<name>.js exporting install(matchum, opts))
  // unless it's switched off. Toggle from the extension popup or recipes.json.
  use(name, opts = {}) {
    if (typeof name !== "string" || !name) throw new Error("matchum.use(name: non-empty string, opts?)");
    const short = name.includes("/") ? path.basename(name, ".js") : name;
    if (state.recipes.some((recipe) => recipe.name === short)) {
      throw new Error(`matchum.use: duplicate recipe name "${short}"`);
    }
    const enabled = readRecipeState()[short] !== false;
    const entry = { name: short, enabled, description: "", page: false };
    state.recipes.push(entry);
    const checkpoint = snapshotRegistrations(state);
    try {
      const file = resolveRecipe(name);
      loadingModuleRoots?.add(file);
      const mod = require(file);
      entry.description = typeof mod.description === "string" ? mod.description : "";
      entry.page = typeof mod.page === "function";
      if (enabled) {
        const install = typeof mod === "function" ? mod : mod?.install;
        if (typeof install !== "function") {
          throw new Error(`recipe "${short}" must export a function or {install()}`);
        }
        if (install.constructor?.name === "AsyncFunction") {
          throw new Error(`recipe "${short}" installer must be synchronous`);
        }
        const result = install(matchum, opts);
        if (result && typeof result.then === "function") {
          result.catch(() => {});
          throw new Error(`recipe "${short}" installer must be synchronous`);
        }
        // Recipe page: chrome-extension://<id>/page.html?recipe=<name>. The
        // daemon renders {title, html, css}; extension CSP forbids inline JS.
        if (entry.page) state.pages.set(short, () => mod.page(matchum, opts));
      }
    } catch (e) {
      restoreRegistrations(state, checkpoint);
      entry.error = String(e?.message ?? e);
      log(`recipe ${short}: ${e?.stack ?? e}`);
      if (!loadingConfig) syncExtensionState();
    }
  },

  // Ask an open recipe page to re-render (no-op if none is open).
  refreshPage: (name) => cmd("page.refresh", { name }).catch(() => {}),

  notify: (message, title) => cmd("notify", { message, title }),
  open: (url, active) => cmd("tab.open", { url, active }),
  log: (...args) => log("[config]", ...args),

  tabs: {
    async list() {
      const tabs = await cmd("tabs.query");
      return tabs.map(wrapTab);
    },
    async find(re) {
      if (!(re instanceof RegExp)) throw new Error("matchum.tabs.find(pattern: RegExp)");
      const tabs = await cmd("tabs.query");
      const hit = tabs.find((t) => regexMatches(re, t.url, t.title));
      return hit ? wrapTab(hit) : null;
    },
  },
};

async function runUser(fn, label, ...args) {
  try {
    await fn(...args);
  } catch (e) {
    log(`error in ${label}: ${e?.stack ?? e}`);
  }
}

function dispatch(event, data) {
  if (event === "watch.hit" && typeof data.watchId === "string") {
    const w = state.watches.find((x) => x.id === data.watchId);
    // Stale id after a config reload is normal; drop silently.
    if (w) runUser(w.handler, `watch(${w.pattern})`, data);
    return;
  }
  const tab = data.tab ? wrapTab(data.tab) : undefined;
  for (const fn of state.handlers.get(event) ?? []) {
    runUser(fn, `on(${event})`, tab ?? data, data);
  }
  if (event === "tab.updated" && data.tab) {
    for (const r of state.rules) {
      if (regexMatches(r.match, data.tab.url, data.tab.title)) {
        runUser(r.action, `rule(${r.match})`, wrapTab(data.tab));
      }
    }
  }
}

function syncExtensionState() {
  pushWatches();
  pushStyles();
  pushActivity();
  pushOverlays(true);
  pushScripts();
}

function flushConfigFailureNotice() {
  if (!extConnected || !pendingConfigFailureNotice) return;
  const notice = pendingConfigFailureNotice;
  pendingConfigFailureNotice = null;
  cmd("notify", notice).catch((error) => log(`config error notification failed: ${error.message}`));
}

function queueConfigFailureNotice(error, retainedPrevious) {
  const detail = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 240);
  pendingConfigFailureNotice = {
    title: "matchum config error",
    message: retainedPrevious
      ? `Last-known-good config is still active: ${detail}`
      : `No config generation is active: ${detail}`,
  };
  flushConfigFailureNotice();
}

function runtimeStatus() {
  return {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    config: { ...configStatus, watchedFiles: watchedModuleFiles.size },
    extension: { connected: extConnected, error: protocolError },
  };
}

function modulesLoadedBy(roots, cacheBefore) {
  const files = collectModuleGraph(roots);
  // A failed CommonJS root is removed from require.cache by Node, while helper
  // modules loaded before the throw remain. Include that cache delta so editing
  // the failing helper can trigger and participate in the next reload.
  for (const file of Object.keys(require.cache)) {
    if (!cacheBefore.has(file)) files.add(file);
  }
  return new Set([...files].filter((file) => !RUNTIME_MODULES.has(file)));
}

function loadConfig() {
  const previousState = state;
  const previousModules = configModules;
  const previousWatchedFiles = watchedModuleFiles;
  const previousModuleSnapshot = snapshotModules(previousModules);
  const candidate = createConfigState();
  const roots = new Set();
  const hadSuccessfulConfig = configStatus.loadedAt !== null;

  // Every generation gets fresh CommonJS modules. Existing handler closures
  // remain valid if this candidate fails, so last-known-good state can stay live.
  evictModules(previousModules);
  const cacheBefore = new Set(Object.keys(require.cache));
  state = candidate;
  loadingConfig = true;
  loadingModuleRoots = roots;
  let loaded = false;
  let loadError = null;
  let candidateModules = new Set();

  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      log(`no config at ${CONFIG_PATH}, running with empty config`);
      loaded = true;
    } else {
      const entry = require.resolve(CONFIG_PATH);
      roots.add(entry);
      globalThis.matchum = matchum;
      require(entry);
      loaded = true;
      log(
        `config loaded: ${[...state.handlers.keys()].length} event(s), ` +
          `${state.rules.length} rule(s), ${state.timers.length} timer(s), ` +
          `${state.recipes.filter((r) => r.enabled).length}/${state.recipes.length} recipe(s) on`
      );
    }
  } catch (error) {
    loadError = error;
    log(`config error (previous generation retained): ${error?.stack ?? error}`);
  } finally {
    candidateModules = modulesLoadedBy(roots, cacheBefore);
    loadingModuleRoots = null;
    loadingConfig = false;
  }

  if (loaded) {
    disposeConfigState(previousState);
    configModules = candidateModules;
    pendingConfigFailureNotice = null;
    configStatus = {
      ok: true,
      error: null,
      loadedAt: new Date().toISOString(),
      failedAt: null,
      retainedPrevious: false,
    };
    watchedModuleFiles = new Set([CONFIG_PATH, ...configModules]);
    syncExtensionState();
  } else {
    disposeConfigState(candidate);
    evictModules(candidateModules);
    restoreModules(previousModuleSnapshot);
    state = previousState;
    configModules = previousModules;
    configStatus = {
      ok: false,
      error: String(loadError?.message ?? loadError),
      loadedAt: configStatus.loadedAt,
      failedAt: new Date().toISOString(),
      retainedPrevious: hadSuccessfulConfig,
    };
    // Keep prior dependency paths watched while also watching every module the
    // failed candidate reached. Fixing either should retry the full generation.
    watchedModuleFiles = new Set([CONFIG_PATH, ...previousWatchedFiles, ...candidateModules]);
    queueConfigFailureNotice(loadError, hadSuccessfulConfig);
  }
  updateDependencyWatchers(watchedModuleFiles);
  return runtimeStatus();
}

// Hot reload on config change (debounced).
let reloadTimer = null;
let configWatcher = null;
let pollingConfig = false;
const dependencyWatchers = new Map();

function scheduleConfigReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    log("config changed, reloading");
    loadConfig();
  }, 300);
}

function onPolledConfigChange(current, previous) {
  if (
    current.mtimeMs !== previous.mtimeMs ||
    current.size !== previous.size ||
    current.ino !== previous.ino
  ) {
    scheduleConfigReload();
  }
}

function updateDependencyWatchers(files) {
  const next = new Set([...files].filter((file) => file !== CONFIG_PATH));
  for (const [file, listener] of dependencyWatchers) {
    if (next.has(file)) continue;
    fs.unwatchFile(file, listener);
    dependencyWatchers.delete(file);
  }
  for (const file of next) {
    if (dependencyWatchers.has(file)) continue;
    const listener = (current, previous) => onPolledConfigChange(current, previous);
    dependencyWatchers.set(file, listener);
    fs.watchFile(file, { interval: 500 }, listener);
  }
}

function pollConfig() {
  if (pollingConfig) return;
  pollingConfig = true;
  fs.watchFile(CONFIG_PATH, { interval: 500 }, onPolledConfigChange);
  log("config watcher unavailable; using polling fallback");
}

function watchConfig() {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    pollConfig();
    return;
  }
  try {
    configWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename && filename !== path.basename(CONFIG_PATH)) return;
      scheduleConfigReload();
    });
    configWatcher.on("error", (e) => {
      log(`config watcher error: ${e.message}`);
      configWatcher?.close();
      configWatcher = null;
      pollConfig();
    });
  } catch (e) {
    log(`config watcher error: ${e.message}`);
    pollConfig();
  }
}

// ---- CLI socket (matchum-ctl) --------------------------------------------

const cliCommands = {
  async status() {
    return runtimeStatus();
  },
  async tabs() {
    return cmd("tabs.query");
  },
  async notify({ msg }) {
    await cmd("notify", { message: msg ?? "" });
    return "ok";
  },
  async reload() {
    return loadConfig();
  },
  async "ext-reload"() {
    // Full-stack reload: the extension reloads itself, which drops this
    // native messaging connection; Chrome then respawns a fresh daemon.
    await cmd("ext.reload");
    return "reloading extension (daemon will restart)";
  },
  async recipes() {
    return state.recipes;
  },
  async recipe({ name, enabled }) {
    return extRequests["recipes.set"]({ name, enabled });
  },
  async eval({ code }) {
    // Local-user-only socket; this is the escape hatch for scripting.
    const fn = new Function("matchum", `return (async () => { ${code} })()`);
    return await fn(matchum);
  },
};

function startCliServer() {
  try {
    const existing = fs.lstatSync(SOCK_PATH);
    if (!existing.isSocket()) {
      log(`cli path exists and is not a socket; refusing to remove ${SOCK_PATH}`);
      return null;
    }
    fs.unlinkSync(SOCK_PATH);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      log(`cannot prepare cli socket: ${e.message}`);
      return null;
    }
  }
  const server = net.createServer((conn) => {
    let buf = "";
    let handled = false;
    conn.on("data", (chunk) => {
      if (handled) return;
      buf += chunk.toString("utf8");
      if (Buffer.byteLength(buf, "utf8") > MAX_CLI_REQUEST_BYTES) {
        handled = true;
        conn.end(JSON.stringify({ ok: false, error: "request too large" }) + "\n");
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      handled = true;
      handleCliRequest(conn, line);
    });
    conn.on("error", () => {});
  });
  server.on("error", (e) => log(`cli socket error: ${e.message}`));
  // Bind with private permissions from creation, including when MATCHUM_SOCK
  // points outside the default 0700 state directory. Restore the process umask
  // immediately so user config keeps the caller's normal file-creation policy.
  const previousUmask = process.umask(0o077);
  try {
    server.listen(SOCK_PATH, () => {
      try {
        fs.chmodSync(SOCK_PATH, 0o600);
      } catch (e) {
        log(`could not restrict cli socket permissions: ${e.message}`);
      }
      log(`cli socket at ${SOCK_PATH}`);
      // Remember the inode we created, so shutdown won't unlink a socket
      // that a NEWER daemon has already replaced (reload race).
      try {
        sockIno = fs.statSync(SOCK_PATH).ino;
      } catch (e) {
        /* ignore */
      }
    });
  } finally {
    process.umask(previousUmask);
  }
  return server;
}

async function handleCliRequest(conn, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    conn.end(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
    return;
  }
  const fn =
    typeof req?.cmd === "string" && Object.hasOwn(cliCommands, req.cmd)
      ? cliCommands[req.cmd]
      : null;
  if (!fn) {
    conn.end(JSON.stringify({ ok: false, error: `unknown cmd: ${req?.cmd}` }) + "\n");
    return;
  }
  const t0 = Date.now();
  try {
    const result = await fn(req);
    conn.end(JSON.stringify({ ok: true, result, ms: Date.now() - t0 }) + "\n");
  } catch (e) {
    conn.end(
      JSON.stringify({ ok: false, error: String(e?.message ?? e), ms: Date.now() - t0 }) +
        "\n"
    );
  }
}

// ---- lifecycle ---------------------------------------------------------

let cliServer = null;
let sockIno = null;

function shutdown(code) {
  clearTimeout(reloadTimer);
  configWatcher?.close();
  if (pollingConfig) fs.unwatchFile(CONFIG_PATH, onPolledConfigChange);
  for (const [file, listener] of dependencyWatchers) fs.unwatchFile(file, listener);
  dependencyWatchers.clear();
  disposeConfigState(state);
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error("daemon shutting down"));
  }
  pending.clear();
  try {
    if (cliServer) cliServer.close();
    // Only remove the socket if it's still OURS — a replacement daemon may
    // already be listening on a fresh socket at the same path.
    if (sockIno !== null && fs.existsSync(SOCK_PATH) && fs.statSync(SOCK_PATH).ino === sockIno) {
      fs.unlinkSync(SOCK_PATH);
    }
  } catch (e) {
    /* ignore */
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

log(`daemon starting (pid ${process.pid}, config ${CONFIG_PATH})`);
loadConfig();
watchConfig();
cliServer = startCliServer();
