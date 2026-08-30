// Unit tests for the daemon/extension pure logic, run in plain Node (no
// browser or chrome.*). Complements harness.mjs, which tests the daemon
// end-to-end.
//
//   node test/unit.mjs

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = require(path.join(ROOT, "extension", "lib", "core.js"));
const daemonCore = require(path.join(ROOT, "daemon", "lib", "core.js"));
const moduleGraph = require(path.join(ROOT, "daemon", "lib", "module-graph.js"));
const nativeMessaging = require(path.join(ROOT, "daemon", "lib", "native-messaging.js"));
const pageScripts = require(path.join(ROOT, "daemon", "lib", "page-scripts.js"));
const installTabGroups = require(path.join(ROOT, "config", "recipes", "tab-groups.js"));

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn, pattern) => {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(error.message);
  }
};

// ---- daemon pure logic --------------------------------------------------

check("parseInterval accepts supported units", daemonCore.parseInterval("5m") === 300_000);
check("parseInterval rejects zero", throws(() => daemonCore.parseInterval("0s"), /invalid interval/));
check("parseInterval rejects timer overflow", throws(() => daemonCore.parseInterval("597h"), /too large/));
{
  const pattern = /github\.com/g;
  pattern.lastIndex = 4;
  check(
    "daemon regex matching is stateless",
    daemonCore.regexMatches(pattern, "https://github.com/a") &&
      daemonCore.regexMatches(pattern, "https://github.com/b") &&
      pattern.lastIndex === 4
  );
}
{
  const parsed = daemonCore.parseRecipeState('{"__proto__":false,"demo":true}');
  check(
    "recipe state has no prototype surface",
    Object.getPrototypeOf(parsed) === null && parsed.demo === true && parsed.__proto__ === false
  );
  check("recipe state rejects arrays", Object.getPrototypeOf(daemonCore.parseRecipeState("[]")) === null);
}
{
  const state = daemonCore.createConfigState();
  const original = () => {};
  state.handlers.set("event", [original]);
  state.timers.push("retained");
  const snapshot = daemonCore.snapshotRegistrations(state);
  state.handlers.get("event").push(() => {});
  state.timers.push("discarded");
  const cleared = [];
  daemonCore.restoreRegistrations(state, snapshot, (timer) => cleared.push(timer));
  check(
    "registration rollback restores collections and clears new timers",
    state.handlers.get("event").length === 1 &&
      state.handlers.get("event")[0] === original &&
      eq(state.timers, ["retained"]) &&
      eq(cleared, ["discarded"])
  );
  daemonCore.disposeConfigState(state, (timer) => cleared.push(timer));
  check("config disposal clears retained timers and collections", cleared.at(-1) === "retained" && state.handlers.size === 0 && state.timers.length === 0);
}

// ---- config module graph ------------------------------------------------

{
  const a = { filename: "/a.js", children: [] };
  const b = { filename: "/b.js", children: [] };
  const unrelated = { filename: "/unrelated.js", children: [] };
  const parent = { filename: "/parent.js", children: [a, unrelated] };
  a.children.push(b);
  const cache = {
    "/a.js": a,
    "/b.js": b,
    "/unrelated.js": unrelated,
    "/parent.js": parent,
  };
  const files = moduleGraph.collectModuleGraph(["/a.js"], cache);
  check("module graph follows config dependencies only", files.has("/a.js") && files.has("/b.js") && !files.has("/unrelated.js"));
  const snapshot = moduleGraph.snapshotModules(files, cache);
  moduleGraph.evictModules(files, cache);
  check(
    "module eviction removes cache entries and parent references",
    !cache["/a.js"] &&
      !cache["/b.js"] &&
      parent.children.length === 1 &&
      parent.children[0] === unrelated &&
      a.children[0] === b
  );
  const candidateA = { filename: "/a.js", children: [] };
  cache["/a.js"] = candidateA;
  parent.children.push(candidateA);
  moduleGraph.evictModules(["/a.js"], cache);
  moduleGraph.restoreModules(snapshot, cache);
  check(
    "module rollback restores previous cache objects and parent links",
    cache["/a.js"] === a &&
      cache["/b.js"] === b &&
      parent.children[0] === a &&
      parent.children[1] === unrelated
  );
}

// ---- page-side action scripts ------------------------------------------

{
  const generated = [
    pageScripts.snapshotScript(),
    pageScripts.snapshotScript({ viewport: true }),
    pageScripts.visibleTextScript(),
    pageScripts.clickScript(0),
    pageScripts.typeScript(0, "hello"),
    pageScripts.typeScript(0, "hello", { enter: true }),
  ];
  check("every generated page script parses", generated.every((source) => {
    try { new Function(source); return true; } catch { return false; }
  }));
  check("page actions reject invalid snapshot indices", throws(() => pageScripts.clickScript(-1), /non-negative integer/));

  const makeElement = (top, name) => {
    const attributes = new Map([["data-matchum-i", "stale"]]);
    return {
      tagName: "BUTTON",
      innerText: name,
      href: "",
      getBoundingClientRect: () => ({ top, bottom: top + 20, left: 0, right: 20, width: 20, height: 20 }),
      getAttribute: (key) => attributes.get(key) || "",
      setAttribute: (key, value) => attributes.set(key, String(value)),
      removeAttribute: (key) => attributes.delete(key),
      hasAttribute: (key) => attributes.has(key),
      attribute: (key) => attributes.get(key),
    };
  };
  const stale = makeElement(200, "offscreen");
  const visible = makeElement(10, "visible");
  const document = {
    title: "page",
    querySelectorAll: (selector) => selector === "[data-matchum-i]" ? [stale, visible] : [stale, visible],
  };
  const snapshot = new Function(
    "document", "getComputedStyle", "location", "innerHeight", "innerWidth", "scrollY",
    pageScripts.snapshotScript({ viewport: true })
  )(document, () => ({ visibility: "visible", display: "block" }), { href: "https://example.com" }, 100, 100, 0);
  check(
    "snapshot clears stale stamps before viewport re-indexing",
    !stale.hasAttribute("data-matchum-i") && visible.attribute("data-matchum-i") === "0" && snapshot.items.length === 1
  );

  class FakeInput {
    constructor(cancelKeydown) {
      this.cancelKeydown = cancelKeydown;
      this.form = { submits: 0, requestSubmit: () => this.form.submits++ };
      this.events = [];
      this.isContentEditable = false;
      this.value = "";
    }
    focus() {}
    dispatchEvent(event) {
      this.events.push(event.type);
      return !(this.cancelKeydown && event.type === "keydown");
    }
  }
  class FakeEvent { constructor(type) { this.type = type; } }
  const runType = (element) => new Function(
    "document", "Event", "KeyboardEvent", "location",
    pageScripts.typeScript(0, "hello", { enter: true })
  )({ querySelector: () => element }, FakeEvent, FakeEvent, { href: "https://example.com" });
  const canceled = new FakeInput(true);
  runType(canceled);
  const accepted = new FakeInput(false);
  runType(accepted);
  check(
    "type only falls back to requestSubmit when Enter keydown is not canceled",
    canceled.form.submits === 0 && accepted.form.submits === 1 && eq(canceled.events.slice(-3), ["keydown", "keypress", "keyup"])
  );
}

// ---- native-messaging framing ------------------------------------------

{
  const messages = [];
  let invalidJson = 0;
  const decode = nativeMessaging.createDecoder({
    onMessage: (message) => messages.push(message),
    onInvalidJson: () => invalidJson++,
  });
  const first = nativeMessaging.encode({ id: 1 });
  const second = nativeMessaging.encode({ id: 2 });
  decode(first.subarray(0, 2));
  decode(Buffer.concat([first.subarray(2), second]));
  check("native decoder handles fragmented and adjacent frames", eq(messages, [{ id: 1 }, { id: 2 }]));

  const bytewise = nativeMessaging.encode({ id: 2.5, value: "fragmented" });
  for (const byte of bytewise) decode(Buffer.of(byte));
  check("native decoder accepts a frame split into one-byte chunks", messages.at(-1).id === 2.5);

  const invalid = Buffer.alloc(5);
  invalid.writeUInt32LE(1, 0);
  invalid.write("{", 4);
  decode(Buffer.concat([invalid, nativeMessaging.encode({ id: 3 })]));
  check("native decoder drops invalid JSON and continues", invalidJson === 1 && messages.at(-1).id === 3);
  check(
    "native encoder enforces its byte limit",
    throws(() => nativeMessaging.encode({ value: "too long" }, 4), /exceeds/)
  );
  const rejectLength = nativeMessaging.createDecoder({ maxBytes: 4, onMessage: () => {} });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(5, 0);
  check("native decoder rejects invalid frame lengths", throws(() => rejectLength(header), /length: 5/));
}

// ---- pick / isMeaningfulUpdate -----------------------------------------

check(
  "pick keeps the protocol subset and defaults groupId to -1",
  eq(core.pick({ id: 5, url: "u", title: "t", windowId: 1, active: true }), {
    id: 5, url: "u", title: "t", status: "", windowId: 1, groupId: -1, active: true, pinned: false,
  })
);
check("isMeaningfulUpdate true on status complete", core.isMeaningfulUpdate({ status: "complete" }));
check("isMeaningfulUpdate true on url change", core.isMeaningfulUpdate({ url: "x" }));
check("isMeaningfulUpdate false on a loading tick", !core.isMeaningfulUpdate({ status: "loading" }));

// ---- urlMatches / matchingSpecs ----------------------------------------

check("urlMatches honors flags", core.urlMatches({ source: "GITHUB", flags: "i" }, "https://github.com"));
check("urlMatches false when no match", !core.urlMatches({ source: "github", flags: "" }, "https://x.com"));
check("urlMatches never throws on a bad pattern", core.urlMatches({ source: "(", flags: "" }, "u") === false);
check(
  "matchingSpecs filters by href",
  eq(
    core.matchingSpecs([{ id: "a", source: "github", flags: "" }, { id: "b", source: "x\\.com", flags: "" }], "https://x.com").map((s) => s.id),
    ["b"]
  )
);

// ---- contentHash --------------------------------------------------------

check("contentHash is stable and int32", core.contentHash("hello") === core.contentHash("hello") && Number.isInteger(core.contentHash("hello")));
check("contentHash differs on different input", core.contentHash("a") !== core.contentHash("b"));

// ---- reconcileOverlays --------------------------------------------------

{
  const specs = [{ id: "o1", source: ".", flags: "" }, { id: "o2", source: "x\\.com", flags: "" }];
  const plan = core.reconcileOverlays(["o2", "stale"], specs, "https://github.com", true);
  check("reconcile mounts new matching spec", plan.mount.map((s) => s.id).join() === "o1");
  check("reconcile updates already-mounted matching spec", plan.update.length === 0); // o2 doesn't match github
  check("reconcile unmounts ids no longer active", plan.unmount.includes("stale") && plan.unmount.includes("o2"));
}
{
  const specs = [{ id: "o1", source: ".", flags: "" }];
  const plan = core.reconcileOverlays(["o1"], specs, "https://x.com", true);
  check("reconcile marks a matching mounted spec for update", plan.update.map((s) => s.id).join() === "o1" && plan.mount.length === 0);
  const sub = core.reconcileOverlays([], specs, "https://x.com", false);
  check("reconcile mounts nothing in a subframe", sub.mount.length === 0 && sub.update.length === 0);
}

// ---- buildUserScript / toRegistration / wrapExec -----------------------

{
  const src = core.buildUserScript({ id: "u1", source: "x\\.com", flags: "i", code: "return 1" });
  check("buildUserScript gates by regex on location.href", src.includes("new RegExp(\"x\\\\.com\", \"i\").test(location.href)"));
  check("buildUserScript escapes the id into the console tag", src.includes('"[matchum u1]"'));
  const reg = core.toRegistration({ id: "u1", source: "a", flags: "", code: "x", world: "main" });
  check("toRegistration sets MAIN world and <all_urls>", reg.world === "MAIN" && eq(reg.matches, ["<all_urls>"]) && reg.runAt === "document_idle");
  check("toRegistration defaults to USER_SCRIPT world", core.toRegistration({ id: "u", source: "a", flags: "", code: "x" }).world === "USER_SCRIPT");
  check("wrapExec makes return/await work", core.wrapExec("return 1") === "(async () => { return 1 })()");
}

// ---- classifyDaemonMessage ---------------------------------------------

check("classify reply", core.classifyDaemonMessage({ type: "reply", id: 1 }).kind === "reply");
check("classify cmd", core.classifyDaemonMessage({ type: "cmd", id: 1, method: "m" }).kind === "cmd");
check("classify ignores cmd without method", core.classifyDaemonMessage({ type: "cmd", id: 1 }).kind === "ignore");
check("classify ignores non-finite ids", core.classifyDaemonMessage({ type: "reply", id: NaN }).kind === "ignore");
check("classify ignores junk", core.classifyDaemonMessage(null).kind === "ignore");

// ---- deduplicated connection-scoped state ------------------------------

{
  const applied = [];
  let rejectNext = false;
  const latch = core.makeStateLatch(async (value) => {
    applied.push(value);
    if (rejectNext) {
      rejectNext = false;
      throw new Error("apply failed");
    }
    return true;
  });
  await latch.set(false);
  await latch.set(false);
  check(
    "state latch deduplicates repeated connection state",
    eq(applied, [false]) && latch.current() === false
  );
  rejectNext = true;
  await latch.set(true).catch(() => {});
  check("state latch rolls back a failed transition", latch.current() === false);
  await latch.set(true);
  check(
    "state latch retries after a failed transition",
    eq(applied, [false, true, true]) && latch.current() === true
  );
}

// ---- makeBroker ---------------------------------------------------------

{
  const sent = [];
  const broker = core.makeBroker({ send: (m) => sent.push(m), setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
  const p = broker.request("recipes.list", { a: 1 });
  check("broker sends a req frame with an id and params", sent[0].type === "req" && sent[0].method === "recipes.list" && sent[0].id === 1 && eq(sent[0].params, { a: 1 }));
  check("broker tracks the request as pending", broker.pendingCount() === 1);
  const consumed = broker.onReply({ type: "reply", id: 1, ok: true, result: 42 });
  check("broker consumes the matching reply", consumed === true && broker.pendingCount() === 0);
  const got = await p;
  check("broker resolves the promise with the result", got === 42);

  const broker2 = core.makeBroker({ send: () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
  const p2 = broker2.request("m").then(() => "ok", (e) => e.message);
  broker2.onReply({ type: "reply", id: 1, ok: false, error: "boom" });
  check("broker rejects on an error reply", (await p2) === "boom");
  check("broker ignores a non-reply message", broker2.onReply({ type: "cmd", id: 9, method: "m" }) === false);

  const brokerT = core.makeBroker({
    send: () => {},
    timeoutMs: 10,
    setTimeoutFn: (fn) => fn(), // fire immediately
    clearTimeoutFn: () => {},
  });
  const pt = brokerT.request("slow").then(() => "ok", (e) => e.message);
  check("broker rejects on timeout and clears pending", (await pt).includes("timed out") && brokerT.pendingCount() === 0);

  const brokerErr = core.makeBroker({ send: () => { throw new Error("no port"); }, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
  const pe = brokerErr.request("m").then(() => "ok", (e) => e.message);
  check("broker rejects and untracks when send throws", (await pe) === "no port" && brokerErr.pendingCount() === 0);

  const brokerDisconnect = core.makeBroker({ send: () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
  const pd = brokerDisconnect.request("m").then(() => "ok", (e) => e.message);
  brokerDisconnect.cancelAll("connection lost");
  check("broker rejects all pending requests on disconnect", (await pd) === "connection lost" && brokerDisconnect.pendingCount() === 0);
}

// ---- makeActivityTracker ------------------------------------------------

{
  const act = core.makeActivityTracker({ throttleMs: 1000, flushAfterMs: 15000 });
  check("first mark is accepted when the injected clock starts at zero", core.makeActivityTracker().mark("keys", 0));
  check("first mark arms the flush timer", act.mark("scrolls", 1000) === true);
  check("a second mark within the throttle window does not re-arm", act.mark("scrolls", 1500) === false);
  check("flushAfterMs is exposed for the caller's timer", act.flushAfterMs === 15000);
  act.mark("keys", 3000); // new second, new kind
  act.noteDepth(0.5);
  const data = act.flush();
  check("flush reports distinct active seconds and counts", data.activeSec === 2 && data.scrolls === 1 && data.keys === 1 && data.depth === 0.5);
  check("flush resets accounting", eq(act.flush(), { activeSec: 0, scrolls: 0, keys: 0, clicks: 0, selects: 0, moves: 0, depth: 0.5 }));
  check("mark can re-arm after a flush", act.mark("clicks", 9000) === true);
  check("noteDepth clamps to 1", (() => { const a = core.makeActivityTracker(); a.noteDepth(5); return a.flush().depth === 1; })());
}

// ---- shipped recipe behavior -------------------------------------------

{
  const handlers = new Map();
  const moves = [];
  installTabGroups(
    {
      on: (event, fn) => handlers.set(event, fn),
      log: () => {},
    },
    { rules: [{ match: /github\.com/g, group: "work" }] }
  );
  const update = handlers.get("tab.updated");
  await update({ id: 1, url: "https://github.com/a", title: "a", groupId: -1, moveToGroup: async (name) => moves.push(name) });
  await update({ id: 2, url: "https://github.com/b", title: "b", groupId: -1, moveToGroup: async (name) => moves.push(name) });
  check("tab-groups treats global regexes as stateless matchers", eq(moves, ["work", "work"]));

  let release;
  let pendingCalls = 0;
  const pendingMove = new Promise((resolve) => (release = resolve));
  const tab = {
    id: 3,
    url: "https://github.com/c",
    title: "c",
    groupId: -1,
    moveToGroup: () => {
      pendingCalls++;
      return pendingMove;
    },
  };
  const first = update(tab);
  const second = update(tab);
  await Promise.resolve();
  check("tab-groups coalesces concurrent updates for one tab", pendingCalls === 1);
  release();
  await Promise.all([first, second]);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
