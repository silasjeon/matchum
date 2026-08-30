// Smoke test: pretend to be the Chrome extension side of the native
// messaging channel and verify the daemon end-to-end without a browser.
//
//   node test/harness.mjs
//
// Covers native framing, rules, extension spec distribution, recipes, the CLI
// socket, and transactional config hot reload without launching a browser.

import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "matchum-test-"));
const CONFIG = path.join(TMP, "config.js");
const SOCK = path.join(TMP, "matchum.sock");
const RECIPE = path.join(TMP, "demo-recipe.js");
const RECIPE_HELPER = path.join(TMP, "demo-recipe-description.js");
const CONFIG_HELPER = path.join(TMP, "config-helper.js");
const LAZY_HELPER = path.join(TMP, "lazy-helper.js");
const RECIPES_STATE = path.join(TMP, "recipes.json");
fs.writeFileSync(RECIPE_HELPER, `module.exports = "demo";\n`);
fs.writeFileSync(
  LAZY_HELPER,
  `globalThis.__matchumLazyLoads = (globalThis.__matchumLazyLoads || 0) + 1;\n` +
    `module.exports = "lazy-" + globalThis.__matchumLazyLoads;\n`
);
fs.writeFileSync(
  RECIPE,
  `module.exports = (matchum) => matchum.every("1h", () => {});\n` +
    `module.exports.description = require("./demo-recipe-description.js");\n` +
    `module.exports.page = () => ({ title: "demo page", html: "<b>hi</b>", css: "b{color:red}" });\n`
);

// User recipes dir = <config dir>/recipes. "user-demo" exists only there;
// "tab-groups" shadows the shipped example of the same name.
fs.mkdirSync(path.join(TMP, "recipes"));
fs.writeFileSync(
  path.join(TMP, "recipes", "user-demo.js"),
  `module.exports = () => {};\nmodule.exports.description = "from user dir";\n`
);
fs.writeFileSync(
  path.join(TMP, "recipes", "tab-groups.js"),
  `module.exports = () => {};\nmodule.exports.description = "user shadow";\n`
);
fs.writeFileSync(
  path.join(TMP, "recipes", "broken-recipe.js"),
  `module.exports = (matchum) => {\n` +
    `  matchum.on("script.msg", () => matchum.notify("broken recipe leaked"));\n` +
    `  matchum.every("1h", () => {});\n` +
    `  throw new Error("install failed");\n` +
    `};\n`
);

fs.writeFileSync(
  CONFIG,
  `matchum.rule({ match: /github\\.com/g, action: (t) => t.moveToGroup("dev") });\n` +
    `matchum.watch(/claude\\.ai/, "[data-msg]", (hit) => matchum.notify("saved " + hit.items.length));\n` +
    `matchum.style(/claude\\.ai/, "body { background: red; }");\n` +
    `matchum.run(/github\\.com/, "document.title = 'hi'");\n` +
    `matchum.on("script.msg", (d) => matchum.notify("msg " + d.data.x));\n` +
    `matchum.on("page.activity", () => {});\n` +
    `matchum.use(${JSON.stringify(RECIPE)});\n` +
    `matchum.use("user-demo");\n` +
    `matchum.use("tab-groups");\n` +
    `matchum.use("broken-recipe");\n` +
    `matchum.use("no-such-recipe");\n`
);

const daemon = spawn(process.execPath, [path.join(ROOT, "daemon", "daemon.js")], {
  env: {
    ...process.env,
    MATCHUM_CONFIG: CONFIG,
    MATCHUM_SOCK: SOCK,
    MATCHUM_RECIPES_STATE: RECIPES_STATE,
    MATCHUM_STATE_DIR: TMP,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
daemon.stderr.on("data", (d) => process.stderr.write(`  [daemon] ${d}`));

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

const FAKE_TABS = [
  { id: 1, url: "https://github.com/x/y", title: "repo", status: "complete", windowId: 1, groupId: -1, active: true, pinned: false },
  { id: 2, url: "https://example.com", title: "example", status: "complete", windowId: 1, groupId: -1, active: false, pinned: false },
];

// Collect daemon->extension commands; auto-respond like the extension would.
const received = [];
const knownCommands = new Set([
  "tabs.query",
  "tab.activate",
  "tab.close",
  "tab.reload",
  "ext.reload",
  "tab.open",
  "tab.group",
  "tab.text",
  "tab.query",
  "watch.set",
  "style.set",
  "overlay.set",
  "activity.set",
  "tab.exec",
  "script.set",
  "tab.screenshot",
  "page.refresh",
  "notify",
]);
const unexpectedCommands = new Set();
let buf = Buffer.alloc(0);
daemon.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
    buf = buf.subarray(4 + len);
    received.push(msg);
    if (msg.type === "cmd") {
      if (!knownCommands.has(msg.method)) unexpectedCommands.add(msg.method);
      const result = msg.method === "tabs.query" ? FAKE_TABS : true;
      daemon.stdin.write(
        frame(
          knownCommands.has(msg.method)
            ? { type: "res", id: msg.id, ok: true, result }
            : { type: "res", id: msg.id, ok: false, error: `unknown method: ${msg.method}` }
        )
      );
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, what, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = received.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${what}`);
};

let failures = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};

try {
  // 1. protocol handshake: mismatches are explicit and block events until a
  // compatible hello arrives.
  daemon.stdin.write(frame({ type: "hello", version: 99 }));
  const mismatch = await waitFor(
    (message) => message.type === "hello" && message.ok === false,
    "protocol mismatch response"
  );
  check(
    "protocol mismatch is reported explicitly",
    mismatch.version === 1 && /extension v99, daemon v1/.test(mismatch.error)
  );
  const groupsBeforeHandshake = received.filter((message) => message.method === "tab.group").length;
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  await sleep(100);
  check(
    "events are blocked after an incompatible handshake",
    received.filter((message) => message.method === "tab.group").length === groupsBeforeHandshake
  );
  daemon.stdin.write(frame({ type: "req", id: 900, method: "recipes.list", params: {} }));
  const rejectedRequest = await waitFor(
    (message) => message.type === "reply" && message.id === 900,
    "request rejection before compatible handshake"
  );
  check(
    "requests fail immediately after a protocol mismatch",
    rejectedRequest.ok === false && /protocol mismatch/.test(rejectedRequest.error)
  );

  daemon.stdin.write(frame({ type: "hello", version: 1 }));
  const hello = await waitFor(
    (message) => message.type === "hello" && message.ok === true,
    "successful protocol handshake"
  );
  check("daemon starts and accepts hello", daemon.exitCode === null && hello.version === 1);
  check("CLI socket is private to the current user", (fs.statSync(SOCK).mode & 0o777) === 0o600);

  // 2. rule fires on matching tab.updated
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  const groupCmd = await waitFor(
    (m) => m.type === "cmd" && m.method === "tab.group" && m.params.name === "dev",
    "tab.group command from rule"
  );
  check("rule(match) -> tab.group command", groupCmd.params.tabId === 1);

  // Stateful /g and /y regex flags must not make repeated events alternate.
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  await sleep(200);
  check(
    "rules treat global regexes as stateless matchers",
    received.filter((m) => m.method === "tab.group" && m.params.name === "dev").length === 2
  );

  // non-matching tab must NOT trigger the rule
  const before = received.filter((m) => m.method === "tab.group").length;
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[1], change: { status: "complete" } } })
  );
  await sleep(300);
  check(
    "non-matching tab does not fire rule",
    received.filter((m) => m.method === "tab.group").length === before
  );

  // 2b. watch specs are pushed to the extension after hello
  const watchSet = await waitFor(
    (m) => m.type === "cmd" && m.method === "watch.set",
    "watch.set command after hello"
  );
  check(
    "matchum.watch -> watch.set pushed to extension",
    watchSet.params.specs.length === 1 && watchSet.params.specs[0].selector === "[data-msg]"
  );

  // 2b'. style specs are pushed too
  const styleSet = await waitFor(
    (m) => m.type === "cmd" && m.method === "style.set",
    "style.set command after hello"
  );
  check(
    "matchum.style -> style.set pushed to extension",
    styleSet.params.specs.length === 1 && styleSet.params.specs[0].css.includes("background: red")
  );

  const activitySet = await waitFor(
    (message) => message.type === "cmd" && message.method === "activity.set",
    "activity.set command after hello"
  );
  check("page.activity instrumentation is opt-in", activitySet.params.enabled === true);

  // 2b-2. user scripts are pushed, regex carried as source/flags
  const scriptSet = await waitFor(
    (m) => m.type === "cmd" && m.method === "script.set",
    "script.set command after hello"
  );
  check(
    "matchum.run -> script.set pushed to extension",
    scriptSet.params.specs.length === 1 &&
      scriptSet.params.specs[0].source === "github\\.com" &&
      scriptSet.params.specs[0].code.includes("document.title")
  );

  // 2b-3. a script.msg event from a page reaches matchum.on("script.msg")
  daemon.stdin.write(
    frame({ type: "event", event: "script.msg", data: { tabId: 1, url: "https://github.com/x", data: { x: 42 } } })
  );
  check(
    "script.msg -> config handler runs",
    !!(await waitFor(
      (m) => m.type === "cmd" && m.method === "notify" && m.params.message === "msg 42",
      "notify from script.msg"
    ))
  );
  await sleep(100);
  check(
    "failed recipe registrations are rolled back",
    !received.some((m) => m.type === "cmd" && m.method === "notify" && m.params.message === "broken recipe leaked")
  );

  // 2b-4. matchum-ctl exec -> tab.exec command for the matching tab
  const execOut = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(ROOT, "bin", "matchum-ctl"), "exec", "github", "return 1+1"],
      { env: { ...process.env, MATCHUM_SOCK: SOCK } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout))
    );
  });
  const execCmd = received.find((m) => m.type === "cmd" && m.method === "tab.exec");
  check(
    "matchum-ctl exec -> tab.exec command for matching tab",
    !!execCmd && execCmd.params.tabId === 1 && execCmd.params.code === "return 1+1" && execOut.trim() === "true"
  );

  const findOut = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        path.join(ROOT, "bin", "matchum-ctl"),
        "eval",
        `const re = /github\\.com/g; const a = await matchum.tabs.find(re); const b = await matchum.tabs.find(re); return [a?.id, b?.id];`,
      ],
      { env: { ...process.env, MATCHUM_SOCK: SOCK } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout))
    );
  });
  check("matchum.tabs.find treats global regexes as stateless", findOut.trim() === "[\n  1,\n  1\n]");

  // 2b-5. recipes: ext->daemon req/reply lists the recipe; set(off) persists and unloads it
  daemon.stdin.write(frame({ type: "req", id: 901, method: "recipes.list", params: {} }));
  const listReply = await waitFor((m) => m.type === "reply" && m.id === 901, "recipes.list reply");
  const rec = Object.fromEntries((listReply.result || []).map((r) => [r.name, r]));
  check(
    "req recipes.list -> reply with loaded recipe",
    listReply.ok && rec["demo-recipe"]?.enabled && rec["demo-recipe"]?.description === "demo"
  );
  check("recipe resolves from user dir (<config dir>/recipes) by name", rec["user-demo"]?.description === "from user dir");
  check("user recipe shadows shipped recipe of the same name", rec["tab-groups"]?.description === "user shadow");
  check("failed recipe exposes its error without partial installation", rec["broken-recipe"]?.error === "install failed");
  check(
    "unknown recipe name -> recorded error naming both search dirs",
    /not found in .*recipes/.test(rec["no-such-recipe"]?.error || "")
  );
  daemon.stdin.write(frame({ type: "req", id: 906, method: "system.status", params: {} }));
  const statusReply = await waitFor((message) => message.type === "reply" && message.id === 906, "system.status reply");
  check(
    "popup status request reports a healthy generation",
    statusReply.ok && statusReply.result.config.ok && statusReply.result.extension.connected
  );
  daemon.stdin.write(frame({ type: "req", id: 904, method: "toString", params: {} }));
  const unknownReply = await waitFor((m) => m.type === "reply" && m.id === 904, "unknown request reply");
  check("prototype properties are not exposed as request methods", !unknownReply.ok && /unknown method/.test(unknownReply.error));
  daemon.stdin.write(frame({ type: "req", id: 903, method: "recipes.page", params: { name: "demo-recipe" } }));
  const pageReply = await waitFor((m) => m.type === "reply" && m.id === 903, "recipes.page reply");
  check(
    "req recipes.page -> rendered {title, html, css}",
    pageReply.ok && pageReply.result.html === "<b>hi</b>" && pageReply.result.title === "demo page" && rec["demo-recipe"].page === true
  );

  const recipeReloadStart = received.length;
  fs.writeFileSync(RECIPE_HELPER, `module.exports = "demo updated";\n`);
  await waitFor(
    (message, index) => index >= recipeReloadStart && message.type === "cmd" && message.method === "watch.set",
    "extension sync after recipe helper reload"
  );
  daemon.stdin.write(frame({ type: "req", id: 905, method: "recipes.list", params: {} }));
  const helperReply = await waitFor(
    (message) => message.type === "reply" && message.id === 905,
    "recipes.list after helper reload"
  );
  check(
    "recipe helper edits trigger reload and cache eviction",
    helperReply.result.find((recipe) => recipe.name === "demo-recipe")?.description === "demo updated"
  );

  daemon.stdin.write(frame({ type: "req", id: 902, method: "recipes.set", params: { name: "demo-recipe", enabled: false } }));
  const setReply = await waitFor((m) => m.type === "reply" && m.id === 902, "recipes.set reply");
  const reloadedWatchSet = received.filter((m) => m.type === "cmd" && m.method === "watch.set").at(-1);
  check(
    "req recipes.set(off) -> persisted and recipe unloaded",
    setReply.ok && setReply.result.find((r) => r.name === "demo-recipe")?.enabled === false && JSON.parse(fs.readFileSync(RECIPES_STATE, "utf8"))["demo-recipe"] === false
  );
  check("recipe state is written with private permissions", (fs.statSync(RECIPES_STATE).mode & 0o777) === 0o600);
  check(
    "watch ids change across config generations",
    reloadedWatchSet.params.specs[0].id !== watchSet.params.specs[0].id
  );

  // 2c. a watch.hit event reaches the config handler
  const savedBefore = received.filter(
    (m) => m.type === "cmd" && m.method === "notify" && m.params.message === "saved 2"
  ).length;
  daemon.stdin.write(
    frame({
      type: "event",
      event: "watch.hit",
      data: {
        watchId: watchSet.params.specs[0].id,
        url: "https://claude.ai/chat/abc",
        title: "test",
        items: ["hello", "world"],
        tabId: 1,
      },
    })
  );
  await sleep(150);
  check(
    "stale watch hits are dropped after config reload",
    received.filter((m) => m.type === "cmd" && m.method === "notify" && m.params.message === "saved 2").length === savedBefore
  );
  daemon.stdin.write(
    frame({
      type: "event",
      event: "watch.hit",
      data: {
        watchId: reloadedWatchSet.params.specs[0].id,
        url: "https://claude.ai/chat/abc",
        title: "test",
        items: ["hello", "world"],
        tabId: 1,
      },
    })
  );
  const notifyCmd = await waitFor(
    (m) => m.type === "cmd" && m.method === "notify" && m.params.message === "saved 2",
    "notify command from watch handler"
  );
  check("watch.hit -> config handler runs", !!notifyCmd);

  // 3. CLI socket round-trip
  const cli = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(ROOT, "bin", "matchum-ctl"), "tabs"],
      { env: { ...process.env, MATCHUM_SOCK: SOCK } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout))
    );
  });
  check("matchum-ctl tabs lists fake tabs", cli.includes("github.com") && cli.includes("example.com"));

  const statusOut = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(ROOT, "bin", "matchum-ctl"), "status"],
      { env: { ...process.env, MATCHUM_SOCK: SOCK } },
      (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout))
    );
  });
  const liveStatus = JSON.parse(statusOut);
  check(
    "matchum-ctl status reports config and extension health",
    liveStatus.protocol === 1 && liveStatus.config.ok && liveStatus.extension.connected
  );

  // 3b. ext-reload CLI round-trips through daemon to the extension
  const extReload = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(ROOT, "bin", "matchum-ctl"), "ext-reload"],
      { env: { ...process.env, MATCHUM_SOCK: SOCK } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout))
    );
  });
  check(
    "matchum-ctl ext-reload -> ext.reload command",
    extReload.includes("reloading") &&
      received.some((m) => m.type === "cmd" && m.method === "ext.reload")
  );

  // 4. hot reload: change the rule's group name, expect new behavior
  const reloadStart = received.length;
  fs.writeFileSync(CONFIG_HELPER, `module.exports = "work";\n`);
  fs.writeFileSync(
    CONFIG,
    `const group = require("./config-helper.js");\n` +
      `matchum.rule({ match: /github\\.com/, action: (t) => t.moveToGroup(group) });\n`
  );
  await waitFor(
    (m, index) => index >= reloadStart && m.type === "cmd" && m.method === "watch.set",
    "extension sync after config reload"
  );
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  await waitFor(
    (m) => m.type === "cmd" && m.method === "tab.group" && m.params.name === "work",
    "tab.group with reloaded config"
  );
  check("config hot-reload applies new rule", true);
  check(
    "page.activity listeners are disabled when no handler is registered",
    received.filter((message) => message.method === "activity.set").at(-1)?.params.enabled === false
  );

  const helperReloadStart = received.length;
  fs.writeFileSync(CONFIG_HELPER, `module.exports = "helper-updated";\n`);
  await waitFor(
    (message, index) => index >= helperReloadStart && message.type === "cmd" && message.method === "watch.set",
    "extension sync after config helper reload"
  );
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  await waitFor(
    (message) => message.type === "cmd" && message.method === "tab.group" && message.params.name === "helper-updated",
    "tab.group after helper-only edit"
  );
  check("config helper edits trigger reload and cache eviction", true);

  // Install a generation whose handler calls require lazily, but whose helper
  // is eagerly declared during installation so it belongs to the transaction.
  const lazyReloadStart = received.length;
  fs.writeFileSync(
    CONFIG,
    `require("./lazy-helper.js");\n` +
      `matchum.rule({ match: /github\\.com/, action: (t) => t.moveToGroup(require("./lazy-helper.js")) });\n`
  );
  await waitFor(
    (message, index) =>
      index >= lazyReloadStart && message.type === "cmd" && message.method === "watch.set",
    "extension sync after lazy-helper generation"
  );
  const lazyActionStart = received.length;
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  const lazyAction = await waitFor(
    (message, index) =>
      index >= lazyActionStart &&
      message.type === "cmd" &&
      message.method === "tab.group" &&
      /^lazy-/.test(message.params.name),
    "lazy require from successful generation"
  );
  const lastKnownLazyName = lazyAction.params.name;
  check("eagerly declared helper remains callable lazily", !!lastKnownLazyName);

  // 5. A config that throws discards its partial generation while preserving
  // the last-known-good behavior and CommonJS cache objects.
  const brokenReloadStart = received.length;
  fs.writeFileSync(
    CONFIG,
    `require("./lazy-helper.js");\n` +
      `matchum.rule({ match: /github\\.com/, action: (t) => t.moveToGroup(require("./lazy-helper.js")) });\n` +
      `matchum.on("script.msg", () => matchum.notify("partial config leaked"));\n` +
      `matchum.every("1h", () => {});\n` +
      `throw new Error("broken config");\n`
  );
  let failedStatus = null;
  for (let attempt = 0; attempt < 40 && !failedStatus; attempt++) {
    await sleep(100);
    const body = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [path.join(ROOT, "bin", "matchum-ctl"), "status"],
        { env: { ...process.env, MATCHUM_SOCK: SOCK } },
        (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout))
      );
    });
    const candidate = JSON.parse(body);
    if (candidate.config.ok === false) failedStatus = candidate;
  }
  check(
    "failed config status is visible and reports retained state",
    failedStatus?.config.retainedPrevious === true && /broken config/.test(failedStatus.config.error)
  );
  const failureNotice = await waitFor(
    (message, index) =>
      index >= brokenReloadStart &&
      message.type === "cmd" &&
      message.method === "notify" &&
      message.params.title === "matchum config error",
    "system notification after config failure"
  );
  await sleep(400);
  check(
    "failed config reload emits one visible system notification",
    /last-known-good config is still active/i.test(failureNotice.params.message) &&
      received.filter(
        (message, index) =>
          index >= brokenReloadStart &&
          message.type === "cmd" &&
          message.method === "notify" &&
          message.params.title === "matchum config error"
      ).length === 1
  );
  const partialBefore = received.length;
  daemon.stdin.write(
    frame({ type: "event", event: "script.msg", data: { tabId: 1, url: "https://github.com", data: {} } })
  );
  await sleep(200);
  check(
    "failed config reload discards partial registrations",
    !received.slice(partialBefore).some((m) => m.method === "notify" && m.params.message === "partial config leaked")
  );
  const lastGoodStart = received.length;
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  check(
    "failed config reload retains last-known-good behavior",
    !!(await waitFor(
      (message, index) =>
        index >= lastGoodStart &&
        message.type === "cmd" &&
        message.method === "tab.group" &&
        message.params.name === lastKnownLazyName,
      "last-known-good lazy require after config failure"
    ))
  );
  check(
    "failed candidate restores the previous CommonJS cache generation",
    !received.slice(lastGoodStart).some(
      (message) =>
        message.type === "cmd" &&
        message.method === "tab.group" &&
        /^lazy-/.test(message.params.name) &&
        message.params.name !== lastKnownLazyName
    )
  );

  const recoveryStart = received.length;
  fs.writeFileSync(
    CONFIG,
    `matchum.rule({ match: /github\\.com/g, action: (t) => t.moveToGroup("recovered") });\n`
  );
  await waitFor(
    (m, index) => index >= recoveryStart && m.type === "cmd" && m.method === "watch.set",
    "extension sync after config recovery"
  );
  const recoveredBefore = received.filter(
    (m) => m.type === "cmd" && m.method === "tab.group" && m.params.name === "recovered"
  ).length;
  daemon.stdin.write(
    frame({ type: "event", event: "tab.updated", data: { tab: FAKE_TABS[0], change: { status: "complete" } } })
  );
  await waitFor(
    (m) => m.type === "cmd" && m.method === "tab.group" && m.params.name === "recovered",
    "rule after recovering from a config error"
  );
  check(
    "daemon recovers after the config is repaired",
    received.filter((m) => m.type === "cmd" && m.method === "tab.group" && m.params.name === "recovered").length === recoveredBefore + 1
  );
  check(
    "daemon emits only extension commands implemented by the harness",
    unexpectedCommands.size === 0
  );
} catch (e) {
  console.error(`  FAIL  ${e.message}`);
  failures++;
} finally {
  if (daemon.exitCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill();
    await Promise.race([exited, sleep(1000)]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
