// matchum core — the extension's pure logic, no chrome.*, no DOM.
// Loaded by the service worker (importScripts), by content scripts (listed
// before watcher.js in the manifest), and by Node tests (module.exports).
// Everything here is deterministic: side effects stay in background.js/watcher.js.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.matchumCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- tabs -------------------------------------------------------------

  // The tab payload the protocol ships — a stable subset of chrome.tabs.Tab.
  function pick(tab) {
    return {
      id: tab.id,
      url: tab.url ?? "",
      title: tab.title ?? "",
      status: tab.status ?? "",
      windowId: tab.windowId,
      groupId: tab.groupId ?? -1,
      active: !!tab.active,
      pinned: !!tab.pinned,
    };
  }

  // Forward a tab.updated only for meaningful transitions, not loading ticks.
  function isMeaningfulUpdate(changeInfo) {
    return changeInfo.status === "complete" || !!changeInfo.url || !!changeInfo.title;
  }

  // ---- specs (watch / style / overlay share the shape) -------------------

  // Does a spec's {source, flags} regex match this href? Bad patterns never throw.
  function urlMatches(spec, href) {
    try {
      return new RegExp(spec.source, spec.flags).test(href);
    } catch (e) {
      return false;
    }
  }

  function matchingSpecs(specs, href) {
    return (specs || []).filter((s) => urlMatches(s, href));
  }

  // Content hash used to suppress duplicate watch.hits.
  function contentHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  // ---- overlay reconciliation -------------------------------------------

  // Given the ids currently rendered and the specs that should exist for this
  // href, return a plan. Pure: the caller applies it to the DOM.
  //   {mount: [spec], update: [spec], unmount: [id]}
  // "update" lists every matching spec that is already mounted — the caller
  // diffs html/css itself (it holds what's actually in the DOM).
  function reconcileOverlays(mountedIds, specs, href, isTopFrame) {
    const plan = { mount: [], update: [], unmount: [] };
    const active = new Set();
    if (isTopFrame) {
      for (const s of specs || []) {
        if (!urlMatches(s, href)) continue;
        active.add(s.id);
        (mountedIds.includes(s.id) ? plan.update : plan.mount).push(s);
      }
    }
    for (const id of mountedIds) if (!active.has(id)) plan.unmount.push(id);
    return plan;
  }

  // ---- user scripts ------------------------------------------------------

  // matchum.run registers on <all_urls> and gates by regex inside the script,
  // because chrome.userScripts wants match patterns while matchum speaks regex.
  function buildUserScript(spec) {
    return (
      `if (new RegExp(${JSON.stringify(spec.source)}, ${JSON.stringify(spec.flags)}).test(location.href)) ` +
      `(async () => { ${spec.code} })().catch((e) => console.error("[matchum ${spec.id}]", e));`
    );
  }

  function toRegistration(spec) {
    return {
      id: spec.id,
      matches: ["<all_urls>"],
      runAt: "document_idle",
      world: spec.world === "main" ? "MAIN" : "USER_SCRIPT",
      js: [{ code: buildUserScript(spec) }],
    };
  }

  // tab.exec wraps user code so `return` and `await` both work.
  function wrapExec(code) {
    return `(async () => { ${code} })()`;
  }

  // ---- message classification -------------------------------------------

  // What should the worker do with a message from the daemon?
  //   {kind: "reply"|"cmd"|"ignore"}
  function classifyDaemonMessage(msg) {
    if (msg && msg.type === "reply" && Number.isSafeInteger(msg.id)) return { kind: "reply" };
    if (msg && msg.type === "cmd" && Number.isSafeInteger(msg.id) && typeof msg.method === "string")
      return { kind: "cmd" };
    return { kind: "ignore" };
  }

  // ---- request broker (ext -> daemon req/reply) --------------------------

  // Bookkeeping for in-flight requests. Timer functions are injectable so
  // tests control time. send() is injected too; the broker owns no I/O.
  function makeBroker({ send, timeoutMs = 5000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    let nextId = 1;
    const pending = new Map();
    return {
      pendingCount: () => pending.size,
      request(method, params) {
        return new Promise((resolve, reject) => {
          const id = nextId++;
          // Register before arming the timer so a synchronous timeout callback
          // (and real async ones) always find the entry to clear.
          const entry = { resolve, reject, timer: null };
          pending.set(id, entry);
          entry.timer = setTimeoutFn(() => {
            if (pending.delete(id)) reject(new Error(`daemon request timed out: ${method}`));
          }, timeoutMs);
          if (!pending.has(id)) return; // injectable timers may fire synchronously
          try {
            send({ type: "req", id, method, params: params ?? {} });
          } catch (e) {
            if (pending.delete(id)) {
              clearTimeoutFn(entry.timer);
              reject(e);
            }
          }
        });
      },
      // Feed every daemon message in; returns true if it consumed a reply.
      onReply(msg) {
        if (classifyDaemonMessage(msg).kind !== "reply") return false;
        const p = pending.get(msg.id);
        if (!p) return true; // a reply, but stale/unknown — consumed, dropped
        pending.delete(msg.id);
        clearTimeoutFn(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || "request failed"));
        return true;
      },
      cancelAll(reason = new Error("daemon disconnected")) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        for (const { reject, timer } of pending.values()) {
          clearTimeoutFn(timer);
          reject(error);
        }
        pending.clear();
      },
    };
  }

  // Deduplicate an asynchronously applied state value. Concurrent transitions
  // may supersede one another; a failed transition rolls back only when it is
  // still the current value. Callers use this to couple page instrumentation to
  // the native-connection lifecycle without duplicate tab broadcasts.
  function makeStateLatch(apply) {
    if (typeof apply !== "function") throw new TypeError("state apply callback is required");
    const unset = Symbol("unset");
    let current = unset;
    let pending = null;

    return {
      current: () => (current === unset ? undefined : current),
      set(value) {
        if (Object.is(current, value)) return pending ?? Promise.resolve(true);
        const previous = current;
        current = value;
        const applied = Promise.resolve().then(() => apply(value));
        const operation = applied
          .catch((error) => {
            if (Object.is(current, value)) current = previous;
            throw error;
          })
          .finally(() => {
            if (pending === operation) pending = null;
          });
        pending = operation;
        return operation;
      },
    };
  }

  // ---- activity tracker (backs the attention beacon) ---------------------

  // Event-driven input accounting: per-kind 1s throttle, a Set of active
  // seconds, and a single delayed flush armed by the first event. The clock
  // is injectable; the caller owns the actual timer and DOM listeners.
  function makeActivityTracker({ throttleMs = 1000, flushAfterMs = 15000 } = {}) {
    const counts = { scrolls: 0, keys: 0, clicks: 0, selects: 0, moves: 0 };
    const secs = new Set();
    const last = {};
    let depth = 0;
    let armedAt = null;

    return {
      // Returns true when this event should arm the flush timer.
      mark(kind, now) {
        if (last[kind] !== undefined && now - last[kind] < throttleMs) return false;
        last[kind] = now;
        secs.add(Math.floor(now / 1000));
        if (kind in counts) counts[kind]++;
        const arm = armedAt === null;
        if (arm) armedAt = now;
        return arm;
      },
      noteDepth(d) {
        if (d > depth) depth = Math.min(1, d);
      },
      flushAfterMs,
      // Drain the accumulated state into a beacon payload (and reset).
      flush() {
        const data = { activeSec: secs.size, ...counts, depth };
        secs.clear();
        for (const k of Object.keys(counts)) counts[k] = 0;
        armedAt = null;
        return data;
      },
      hasActivity: () => secs.size > 0,
    };
  }

  return {
    pick,
    isMeaningfulUpdate,
    urlMatches,
    matchingSpecs,
    contentHash,
    reconcileOverlays,
    buildUserScript,
    toRegistration,
    wrapExec,
    classifyDaemonMessage,
    makeBroker,
    makeStateLatch,
    makeActivityTracker,
  };
});
