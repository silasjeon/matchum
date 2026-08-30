// matchum watcher — content script backing matchum.watch().
// Inert until it receives watch specs; then observes DOM mutations and,
// once changes settle (debounce), extracts matched elements and reports
// a watch.hit to the background worker. Handles SPA url changes because
// specs are re-matched against location.href on every debounce tick.

(() => {
  const { contentHash, matchingSpecs, reconcileOverlays, makeActivityTracker } = matchumCore;
  let specs = []; // [{spec, pattern}] — regexes compiled once per watch.set
  let styleSpecs = []; // [{id, source, flags, css}]
  let overlaySpecs = []; // [{id, source, flags, html, css}]
  const timers = new Map(); // spec id -> debounce timer
  const lastHash = new Map(); // spec id -> hash of last reported content
  const selectorErrors = new Set(); // invalid selectors already reported
  let observer = null;
  let lastHref = location.href;

  function compileWatches(next) {
    return next.map((spec) => {
      try {
        return { spec, pattern: new RegExp(spec.source, spec.flags) };
      } catch (e) {
        return { spec, pattern: null };
      }
    });
  }

  function matching() {
    const active = [];
    for (const entry of specs) {
      if (!entry.pattern) continue;
      entry.pattern.lastIndex = 0;
      if (entry.pattern.test(location.href)) active.push(entry.spec);
    }
    return active;
  }

  function sendRuntimeMessage(message) {
    try {
      chrome.runtime.sendMessage(message)?.catch(() => {});
    } catch (e) {
      /* extension context was reloaded or unloaded */
    }
  }

  function extract(spec) {
    timers.delete(spec.id);
    let items;
    try {
      items = Array.from(document.querySelectorAll(spec.selector))
        .slice(0, 100)
        .map((el) => (el.innerText || "").slice(0, 50000));
    } catch (e) {
      if (!selectorErrors.has(spec.id)) {
        selectorErrors.add(spec.id);
        console.warn(`[matchum ${spec.id}] invalid watch selector: ${spec.selector}`, e);
      }
      return;
    }
    const h = contentHash(spec.selector + "\0" + location.href + "\0" + items.join("\0"));
    if (lastHash.get(spec.id) === h) return;
    lastHash.set(spec.id, h);
    if (!items.length) return; // page transition with nothing matched yet
    sendRuntimeMessage({
      type: "watch.hit",
      data: { watchId: spec.id, url: location.href, title: document.title, items },
    });
  }

  // Styles: keep a <style data-matchum-style> element per spec matching the
  // current URL; SPA navigations are handled by re-applying on href change.
  function applyStyles() {
    const active = new Set();
    for (const s of matchingSpecs(styleSpecs, location.href)) {
      active.add(s.id);
      let el = document.querySelector(`style[data-matchum-style="${s.id}"]`);
      if (!el) {
        el = document.createElement("style");
        el.setAttribute("data-matchum-style", s.id);
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== s.css) el.textContent = s.css;
    }
    for (const el of document.querySelectorAll("style[data-matchum-style]")) {
      if (!active.has(el.getAttribute("data-matchum-style"))) el.remove();
    }
  }

  // Overlays: one <div data-matchum-overlay=id> host per matching spec, content
  // rendered into a closed shadow root so page CSS and ours never interact.
  // Any element with [data-matchum-toggle] collapses/expands the host (class
  // "collapsed" on the shadow wrapper), remembered per origin in localStorage.
  const overlayRoots = new Map(); // id -> {host, root, html, css}
  function collapsedKey(id) {
    return `matchum-overlay-collapsed:${id}`;
  }
  function mountOverlay(s) {
    const host = document.createElement("div");
    host.setAttribute("data-matchum-overlay", s.id);
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    const wrap = document.createElement("div");
    wrap.className = "matchum-wrap";
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(collapsedKey(s.id)) === "1";
    } catch (e) {
      /* storage blocked */
    }
    if (collapsed) wrap.classList.add("collapsed");
    wrap.addEventListener("click", (ev) => {
      const t = ev.composedPath().find((n) => n?.dataset && "matchumToggle" in n.dataset);
      if (!t) return;
      const now = wrap.classList.toggle("collapsed");
      try {
        localStorage.setItem(collapsedKey(s.id), now ? "1" : "0");
      } catch (e) {
        /* ignore */
      }
    });
    root.append(style, wrap);
    (document.body || document.documentElement).appendChild(host);
    const o = { host, style, wrap, html: null, css: null };
    overlayRoots.set(s.id, o);
    return o;
  }
  function paintOverlay(o, s) {
    if (o.css !== s.css) {
      o.css = s.css;
      o.style.textContent = s.css;
    }
    if (o.html !== s.html) {
      o.html = s.html;
      o.wrap.innerHTML = s.html;
    }
  }
  function applyOverlays() {
    // Reconnected hosts (SPA re-render) look mounted but aren't in the DOM.
    for (const [id, o] of overlayRoots) if (!o.host.isConnected) overlayRoots.delete(id);
    const plan = reconcileOverlays([...overlayRoots.keys()], overlaySpecs, location.href, window === window.top);
    for (const s of plan.mount) paintOverlay(mountOverlay(s), s);
    for (const s of plan.update) paintOverlay(overlayRoots.get(s.id), s);
    for (const id of plan.unmount) {
      overlayRoots.get(id)?.host.remove();
      overlayRoots.delete(id);
    }
  }

  function onMutation() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      applyStyles();
      applyOverlays();
    }
    for (const spec of matching()) {
      clearTimeout(timers.get(spec.id));
      timers.set(spec.id, setTimeout(() => extract(spec), spec.debounceMs ?? 800));
    }
  }

  function apply() {
    const need = specs.length || styleSpecs.length || overlaySpecs.length;
    if (need && !observer) {
      observer = new MutationObserver(onMutation);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }
    if (!need && observer) {
      observer.disconnect();
      observer = null;
    }
    applyStyles();
    applyOverlays();
    onMutation(); // initial extraction for already-rendered pages
  }

  // ---- opt-in activity beacon (backs page.activity) ---------------------
  // No input listeners exist until the daemon reports that the current config
  // has a page.activity handler.
  let stopActivity = null;

  function startActivity() {
    const act = makeActivityTracker(); // pure accounting; core-tested
    let flushTimer = null;

    function flush(reason) {
      clearTimeout(flushTimer);
      flushTimer = null;
      if (!act.hasActivity()) return;
      const data = {
        url: location.href,
        title: document.title,
        visible: document.visibilityState === "visible",
        reason,
        ...act.flush(),
      };
      sendRuntimeMessage({ type: "activity", data });
    }

    function mark(kind) {
      if (act.mark(kind, Date.now())) flushTimer = setTimeout(() => flush("tick"), act.flushAfterMs);
    }

    function scrollDepth() {
      const h = document.documentElement.scrollHeight - innerHeight;
      if (h > 0) act.noteDepth(scrollY / h);
    }

    const onScroll = () => { mark("scrolls"); scrollDepth(); };
    const onKeydown = () => mark("keys");
    const onMousedown = () => mark("clicks");
    const onMousemove = () => mark("moves");
    const onSelection = () => {
      if (String(getSelection()).length > 0) mark("selects");
    };
    const onVisibility = () => flush("visibility");
    const onPagehide = () => flush("pagehide");
    const opts = { passive: true, capture: true };

    window.addEventListener("scroll", onScroll, opts);
    window.addEventListener("keydown", onKeydown, opts);
    window.addEventListener("mousedown", onMousedown, opts);
    window.addEventListener("mousemove", onMousemove, opts);
    document.addEventListener("selectionchange", onSelection, opts);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPagehide);

    return () => {
      clearTimeout(flushTimer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("mousedown", onMousedown, true);
      window.removeEventListener("mousemove", onMousemove, true);
      document.removeEventListener("selectionchange", onSelection, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPagehide);
    };
  }

  function setActivityEnabled(enabled) {
    if (window !== window.top) return;
    if (enabled && !stopActivity) stopActivity = startActivity();
    if (!enabled && stopActivity) {
      stopActivity();
      stopActivity = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "watch.set" && Array.isArray(msg.specs)) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      specs = compileWatches(msg.specs);
      lastHash.clear();
      selectorErrors.clear();
      apply();
    }
    if (msg?.type === "style.set" && Array.isArray(msg.specs)) {
      styleSpecs = msg.specs;
      apply();
    }
    if (msg?.type === "overlay.set" && Array.isArray(msg.specs)) {
      overlaySpecs = msg.specs;
      apply();
    }
    if (msg?.type === "activity.set" && typeof msg.enabled === "boolean") {
      setActivityEnabled(msg.enabled);
    }
  });

  // Pull current specs on load (background stores them in session storage,
  // so this works even if the service worker was asleep).
  try {
    chrome.runtime.sendMessage({ type: "watch.get" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (Array.isArray(res) && res.length) {
        specs = compileWatches(res);
        apply();
      }
    });
    chrome.runtime.sendMessage({ type: "style.get" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (Array.isArray(res) && res.length) {
        styleSpecs = res;
        apply();
      }
    });
    chrome.runtime.sendMessage({ type: "overlay.get" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (Array.isArray(res) && res.length) {
        overlaySpecs = res;
        apply();
      }
    });
    chrome.runtime.sendMessage({ type: "activity.get" }, (enabled) => {
      if (chrome.runtime.lastError) return;
      setActivityEnabled(enabled === true);
    });
  } catch (e) {
    /* ignore */
  }
})();
