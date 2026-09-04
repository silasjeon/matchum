# matchum — a programmable extension layer for your browser

A programmable layer that treats browser tabs and pages as first-class objects: hook into
events, manage and watch them with rules. Configuration is code (`~/.config/matchum/config.js`)
and hot-reloads on save.

The design stance (inspired by WezTerm's `wezterm.lua` + `wezterm cli`): the browser as a
long-lived, user-owned runtime. Standing config,
one-off CLI evals, and agent-submitted plans are three callers of the same `matchum` API on the
user's real logged-in session; behavior keeps running with no agent attached, and `matchum-ctl`
addresses the browser that is already on screen — an agent starts from live state (open tabs,
windows, what's in front) instead of launching a blank instance.

## Architecture

```
~/.config/matchum/config.js      user config (JS — the equivalent of wezterm.lua)
        │  dependency-aware fs.watch + polling fallback + hot reload
   daemon/daemon.js  ★ all user handlers, rules, timers, and state run here
        │  Native Messaging (stdio, 4-byte LE length + JSON)
   extension/        thin sensor/actuator (MV3 service worker)
        │  chrome.tabs / tabGroups / scripting / notifications
      Chrome
        ▲
   bin/matchum-ctl ── unix socket (~/.local/state/matchum/matchum.sock, JSON-lines)
```

- All state lives in the daemon. The MV3 service worker can die and wake at any time.
- Chrome auto-spawns the daemon via native messaging when the extension connects; the
  daemon exits when the connection drops.
- stdout is reserved for native messaging. Daemon logs go to
  `~/.local/state/matchum/daemon.log` + stderr.

## Protocol (extension ↔ daemon)

Framing: 4-byte little-endian length + UTF-8 JSON. The daemon enforces Chrome's native
messaging limits (64 MiB extension→host, 1 MiB host→extension) before decoding or writing.

| direction | type | fields | meaning |
|---|---|---|---|
| ext→d | `hello` | `version` | connection greeting |
| d→ext | `hello` | `ok`, `version`, `error?` | accepted handshake or explicit protocol mismatch |
| ext→d | `event` | `event`, `data` | browser event |
| ext→d | `res` | `id`, `ok`, `result`/`error` | command response |
| d→ext | `cmd` | `id`, `method`, `params` | command (10s timeout) |
| ext→d | `req` | `id`, `method`, `params` | extension (popup UI) asking the daemon (5s timeout) |
| d→ext | `reply` | `id`, `ok`, `result`/`error` | req response |

req methods: `system.status` (daemon, extension handshake, and config-generation health),
`recipes.list`, `recipes.set {name, enabled}` (persist switch state, re-run config),
`recipes.page {name}` (render result of a recipe's `page()` — `{title, html, css}`).

A version mismatch receives `hello {ok:false}` instead of failing silently. The daemon rejects
events and requests until a compatible greeting arrives, while the extension shows an error
badge/title. A successful greeting clears the error and republishes the current runtime state.

Events: `tab.created`, `tab.updated` (only on status complete / url / title changes),
`tab.removed`, `tab.activated`, `window.focused`, `watch.hit` (content-script watch results),
`idle.changed` (`chrome.idle` — `{state: active|idle|locked}`, 60s no-input threshold),
`page.activity` (content-script activity beacon — `{tabId, url, title, visible, activeSec,
scrolls, keys, clicks, selects, moves, depth, reason}`. Instrumentation is opt-in: input
listeners are installed only while config has a `page.activity` handler. Events are counted
with a 1s per-kind throttle and sent once 15s after the first event, immediately on
visibilitychange/pagehide. No handler means no activity listeners or beacons),
`script.msg` (messages sent by user scripts via
`chrome.runtime.sendMessage({type:"script.msg", data})` — `{tabId, url, data}`; enabled by
`userScripts.configureWorld({messaging:true})`).
Tab payload: `{id,url,title,status,windowId,groupId,active,pinned}`.

Command methods: `tabs.query`, `tab.activate`, `tab.close`, `tab.reload`, `tab.open`,
`tab.group` (reuses an existing group by name), `tab.text` (innerText, 20KB),
`tab.query` (selector → text array, max 50), `ext.reload` (extension reloads itself —
responds first, then `chrome.runtime.reload()`; the connection drops and a fresh daemon
spawns), `activity.set` (enable/disable content-script activity instrumentation), `tab.exec`
(run JS inside the page — `chrome.userScripts.execute`, USER_SCRIPT or
MAIN world, async/return supported), `script.set` (register persistent user scripts —
`chrome.userScripts.register` on `<all_urls>` with a regex URL gate inside the script;
serialized on the extension side and debounced 20ms in the daemon — prevents the
`Duplicate script ID` race when `matchum.run` is called repeatedly, interleaving
unregister/register), `tab.screenshot` (`captureVisibleTab` PNG data URL — activates the
tab first if inactive), `notify`, `watch.set`/`style.set`/`overlay.set` (distribute
watch/style/overlay specs — the extension stores them in session storage and broadcasts to
all tabs; freshly loading pages pull via `watch.get`/`style.get`/`overlay.get`). Activity state
uses the same distribution path through `activity.set`/`activity.get`.

Malformed messages are logged and dropped (strict validation).

## Config API (the `matchum` global)

- `matchum.on(event, handler)` — event hook. Handlers receive a wrapped tab
- `matchum.rule({match: RegExp, action})` — on `tab.updated`, match url/title → action(tab)
- `matchum.every("30s"|"5m"|"1h", fn)` — periodic execution
- `matchum.watch(pattern: RegExp, selector, handler, {debounceMs=800}?)` — real-time page
  watching. In every page whose URL matches, the content script's (`watcher.js`)
  MutationObserver detects DOM changes; after the debounce it extracts
  `querySelectorAll(selector)` texts (max 100 items, 50KB each) and emits `watch.hit` only
  when the content hash changed. The handler receives
  `{watchId, tabId, url, title, items: string[]}`. SPA URL changes are tracked too
- `matchum.style(pattern: RegExp, css)` — inject CSS into matching pages. The content script
  applies it as a `<style data-matchum-style>` element; saving the config updates already-open
  pages instantly (hot reload → `style.set` → style swap). SPA navigations are detected via
  href changes and styles re-applied/removed. Page CSP does not interfere (claude.ai
  verified to allow `style-src 'unsafe-inline'`)
- `matchum.overlay(id, pattern: RegExp, {html, css})` — draw an HTML widget on matching pages
  (top frame only). The content script renders a `<div data-matchum-overlay=id>` host with a
  closed Shadow DOM, fully isolated from page CSS. Idempotent by id — calling again
  re-renders (the daemon coalesces pushes at 50ms into `overlay.set`, applied live to all
  open tabs). Clicking any `[data-matchum-toggle]` element inside the widget toggles a
  `collapsed` class on the wrapper (remembered per site in localStorage). Cleared on config
  reload
- `matchum.run(pattern: RegExp, js: string, {world?: "main"})` — Tampermonkey-style persistent
  user script. Runs at document_idle in matching pages. Default USER_SCRIPT world (shares
  the DOM, isolated from site JS globals, no `chrome.*`); `world:"main"` shares the site's
  context. Fully re-registered on config reload. **Because MV3 bans remote code, the only
  sanctioned channel for arbitrary JS in pages is `chrome.userScripts`** — the user must
  enable "Allow User Scripts" on the extension's details page (a clear error otherwise)
- `matchum.notify(message, title?)`, `matchum.open(url, active?)`, `matchum.log(...)`
- `matchum.tabs.list()` / `matchum.tabs.find(regex)` — return wrapped tabs
- Wrapped tab methods: `activate() close() reload() moveToGroup(name) text()
  query(selector)` plus the agent action API:
  - `exec(js, {world?})` — run JS inside the page; `return` values come back, `await` works
  - `snapshot()` — list of actionable elements `{url, title, items:[{i, role, name, tag,
    href?}]}` (a/button/input/select/textarea/role=*/contenteditable, visible only, max
    300). Each element is stamped with a `data-matchum-i` index so later calls can reference
    it without selectors
  - `click(i)` / `type(i, text, {enter?})` — click/type by snapshot index. type uses the
    native value setter + input/change events for React compatibility; contenteditable uses
    execCommand insertText. **Both return evidence**, so no separate
    verification turn is needed: click → `{tag, name, href, navigated, url, title,
    status}`, type → `{typed (the value read back), matches, navigated, url, title}`.
    Two-phase design — the in-page script acts synchronously and returns immediately
    (awaiting across a navigation would strand the promise until the 10s timeout when the
    context is destroyed); the daemon waits for settle (click 600ms, type+enter 800ms) and
    reads the outcome url/title from `tabs.query`, which survives full navigations
    (`actWithEvidence`)
  - `snapshot({viewport:true})` — only elements inside the viewport; every item carries an
    `inView` flag, and the response includes `scrollY`/`viewportH`. **Lets an agent reason
    about what the user is actually looking at, not the whole DOM**
  - `visibleText()` — only the text currently on screen (per-text-node viewport
    intersection, sub-2px sr-only text excluded, 20KB cap). Where `text()` is the whole
    document, this is "what's in view right now"
  - `screenshot(file?)` — saves a PNG and returns its path (default
    `~/.local/state/matchum/shots/`)

Handler errors are isolated and only logged. Reload registration is transactional: matchum
builds a candidate generation, publishes it only after successful evaluation, then disposes the
old generation. If the candidate fails to parse or throws, its partial handlers/timers are
disposed, its CommonJS cache objects are evicted, and the previous state and module cache are
restored. The last-known-good generation remains active. One system notification is emitted per
failed reload; the popup and `status` continue to surface the error, failure time, whether a
previous generation was retained, and dependency-watch count.

The config runs inside the daemon (Node) process via `require`, so Node APIs like `fs` are
directly available (the same standing as wezterm.lua executing arbitrary Lua). The installed
example config is intentionally inert. `examples/config.showcase.js` contains explicit opt-in
examples such as navigation history and live conversation archiving; it is never installed or
executed automatically.

### Recipes (`config/recipes/`)

The on/off unit of config. Registered with `matchum.use(name, opts?)` — resolves
`<name>.js` from `~/.config/matchum/recipes/` (user recipes, user-versioned) first, then
from the repo's `config/recipes/` (shipped examples); a name containing `/` is treated
as a path relative to the config directory (unless absolute). Calls
`module.exports(matchum, opts)` or `.install` synchronously. `module.exports.description`
shows in the UI.
**Exporting `module.exports.page(matchum, opts)` gives the recipe its own internal page** at
`chrome-extension://<id>/page.html?recipe=<name>` (the "open" link in the popup).
`extension/page.js` fetches `{title, html, css}` via a `recipes.page` req and injects it;
when the recipe calls `matchum.refreshPage(name)` (`page.refresh` cmd → runtime message), an
open page re-renders. Extension-page CSP forbids inline JS, so pages follow the
"daemon-rendered HTML" model (same as overlays). Switch state persists in
`~/.local/state/matchum/recipes.json` (`{name: false}`; default on) across reloads and
restarts. A switched-off recipe is only read for its description, never executed; toggling
re-runs the whole config, so handlers/timers/overlays a recipe registered disappear
cleanly. Control surfaces: the toolbar popup (`extension/popup.html` — list/toggle via
ext→daemon `req`), `matchum-ctl recipes` / `on|off <name>`, or editing the file. The state
file path can be overridden with `MATCHUM_RECIPES_STATE` (for tests).

The daemon records the CommonJS dependency graph rooted at the config and every loaded recipe.
Saving a recipe or local helper evicts that graph and triggers a new transactional generation,
so helper-only edits do not leave stale closures or require-cache entries. Dependencies loaded
before a failed root module throws are retained in the watch set so fixing the helper retries
the generation. On failure, the candidate graph is removed and the exact previous module objects
and parent links are restored, so a retained handler cannot resolve a candidate helper. The config
entry itself is watched only by the directory watcher: it is recognized by real path, so a config
reached through a symlink (a dotfiles-linked `~/.config`, macOS's `/var` → `/private/var`) is not
also polled as a dependency, which would reload every save twice.

The graph boundary is the synchronous config/recipe installation phase. Every local helper must
be required during that phase (normally with a top-level `require()`), even if handlers call
`require()` again later. A purely lazy dependency first loaded inside a running handler is outside
the generation transaction and is unsupported for atomic hot reload. The transaction covers
matchum registrations, owned timers, and CommonJS cache identity; it cannot undo arbitrary
filesystem, process, or global-state side effects performed by user code.

`tab-groups.js`: **auto-grouping**. On `tab.updated`, the first rule in
`rules: [{match: RegExp, group: string}]` whose pattern matches url/title moves the tab
into a Chrome tab group of that name (existing group reused). A per-tab cache avoids
re-grouping on reloads; default rule: github → "gh".

## CLI (`bin/matchum-ctl`)

`status` | `tabs` | `notify <msg>` | `reload` | `ext-reload` | `eval '<js>'` (async execution in the
daemon context, `matchum` in scope) | `exec <regex> '<js>'` (JS inside the first matching
tab) | `snapshot <regex> [--viewport]` | `visible <regex>` | `shot <regex> [file]` |
`recipes` | `on|off <recipe>`.
A regex argument in `/…/i` form keeps its regex semantics; anything else becomes an escaped,
case-insensitive pattern. The socket path can be overridden with `MATCHUM_SOCK` (for tests),
the config path with `MATCHUM_CONFIG`, and the state directory with `MATCHUM_STATE_DIR`.
The client applies a 600s idle timeout — long batched evals send nothing until they
finish, so the ceiling is high; `MATCHUM_CTL_TIMEOUT_MS` overrides it for scripts that
want to fail fast.
`ext-reload` reloads extension + daemon — replacing the manual chrome://extensions dance
after editing extension code. Content scripts in already-open tabs stay stale, though;
refresh the tabs you need
(`eval 'for (const t of await matchum.tabs.list()) if (/pattern/.test(t.url)) await t.reload()'`).

The extension service worker retries `connect()` every 30s via `chrome.alarms`, so a lost
native-host connection comes back without waiting for another browser event. On startup,
connection loss, or handshake failure, it persists and broadcasts `activityEnabled=false` before
a compatible daemon may explicitly enable instrumentation again; stale session storage therefore
cannot keep activity listeners armed without the daemon.

Robustness: the daemon ignores stdout EPIPE (writes while the extension is dying), allocates
each validated native-message frame once instead of repeatedly concatenating fragments, falls
back to polling if the filesystem watcher fails, and exits cleanly on stdin end. The CLI
socket is mode `0600`; it is only unlinked when it is still the daemon's own inode (guards
the old/new daemon overlap race during reloads).

## Performance

`matchum-ctl` prints `[t] total · daemon · overhead` to stderr on every call (the daemon also
includes `ms` in CLI responses). Measured (2026-08-29, M-series): CLI spawn (node boot)
~25-50ms, socket+serialization 3-4ms, daemon↔extension↔page round trip 2-10ms,
`visibleText` computation 5-30ms, `tabs.query` ~10-55ms. Only screenshots are slow at
300ms-1s (capture + PNG + base64). **Cold cases**: the first userScripts execution per tab
right after an extension/daemon reload takes ~2s (one-off; USER_SCRIPT world creation,
presumably), and a sleeping MV3 service worker adds a wake cost to the first cmd.
Optimization rule: batch multi-page work into **one `eval`** instead of multiple matchum-ctl
invocations (visibleText×3 = 3×33ms separately → 42ms batched).

## Install / Run

`scripts/install.sh` has two explicit modes:

- The default release mode stages a self-contained copy at `~/.local/share/matchum`, generates
  its `extension/manifest.json`, and points both the unpacked extension and native host at that
  stable copy. Re-running it atomically replaces the managed runtime and retains one
  `~/.local/share/matchum.previous` rollback copy.
- `scripts/install.sh --dev` points the generated extension manifest and native-host wrapper at
  the checkout. It uses the same external identity and user data as release mode.

Both modes keep the private RSA identity at `~/.config/matchum/key.pem` (mode `0600`), put CLI
links in `~/.local/bin`, register
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.matchum.daemon.json`
(directory overridable with `MATCHUM_NATIVE_HOST_DIR`), and seed `~/.config/matchum/config.js`
only when absent. A legacy checkout-local
`scripts/key.pem` is copied automatically on first use, preserving the existing extension ID.
Generated manifests and private identity are untracked.

Load the installer-reported extension directory through `chrome://extensions` → Developer mode
→ Load unpacked. On Chrome 138+, enable Allow User Scripts on its details page (Chrome 135–137
uses the Developer mode toggle itself). Verify the static and live wiring with
`matchum-doctor`, then use `matchum-ctl tabs`.

`scripts/install.sh uninstall` removes only marked, managed runtime directories, managed CLI
links, and the native-host manifest. It retains config, state, and identity and never removes
the extension from Chrome. Paths can be overridden with `MATCHUM_*` environment variables for
isolated tests.

## Test

`npm test` (or `node test/run.mjs`) runs four suites, no browser needed:

- `test/static.mjs` — parses every JavaScript entry point and checks shared package/extension
  metadata.
- `test/unit.mjs` — daemon/extension pure logic loaded in plain Node: config transactions,
  native-message framing, tab payload shaping, regex matching, overlay reconciliation,
  user-script generation, the req/reply broker, activity accounting, CommonJS dependency
  graphs, generated page-action scripts, and shipped recipes.
- `test/harness.mjs` — the daemon end-to-end, with a harness that impersonates the
  extension: compatible and mismatched handshakes, rule firing (match/non-match), opt-in
  activity and watch/style/script spec distribution,
  script.msg dispatch, CLI round trips, socket permissions, recipe isolation/resolution and
  toggle via req/reply, config/recipe helper reload, stale watch rejection, last-known-good
  config retention, and recovery.
- `test/install.mjs` — isolated release install, identity consistency, inert first run,
  idempotent update and rollback copy, doctor output, and safe uninstall/data retention.

GitHub Actions runs the core matrix on Linux and the full suite, including the zsh/macOS
installer contract, on macOS.

The extension is split so this is possible: `extension/lib/core.js` holds every pure
browser decision (no `chrome.*`, no DOM) and is unit-tested; `background.js` and
`watcher.js` are the thin `chrome.*`/DOM glue that calls into it. `core.js` loads three ways — the service
worker `importScripts`es it, content scripts list it before `watcher.js`, and Node
`require`s it — via a tiny UMD wrapper.

The opt-in showcase config implements **live saving of Claude conversations** with
`matchum.watch`:
watch `[data-test-render-count]` on `claude.ai/chat/<uuid>` pages (one per message; roles
split by the "You said:" / "Claude responded:" prefixes) and, once the DOM settles
(debounce 1.5s), overwrite a full conversation snapshot at
`~/.local/state/matchum/claude/<conversation-id>.json`. "Thought for Ns" UI noise is
stripped. Limits: selectors need updating when the claude.ai UI changes; very long
conversations may be truncated by DOM virtualization.

## Browser-use (an agent operating my Chrome)

Drives **the user's own Chrome — logins, cookies, and extensions intact**, joining the
session already on screen. Observation is `watch` (push); action is
`exec/snapshot/click/type/screenshot`. Typical loop: pick an element with `snapshot()` →
`click(i)`/`type(i, text, {enter:true})` → confirm via `watch` or `text()`. Limits: no
alert/confirm dialog handling (needs `chrome.debugger`), screenshots activate the tab,
`snapshot` doesn't descend into shadow DOM or iframes. Detection surface: matchum uses no
CDP, so there is no `navigator.webdriver` flag, no debugger banner, and pages load with
the browser's normal fingerprint and cookies — but synthetic actions are DOM-level
(`el.click()`), so `event.isTrusted` is `false` and a site that inspects it can tell an
individual click was programmatic. `text`, `visibleText`, and `watch` are passive reads with no page-observable signal;
`snapshot` writes a temporary `data-matchum-i` attribute per element, so a page watching for
attribute mutations can notice it. (Injected styles, overlay hosts, and localStorage keys are
likewise visible to the page by design.)

## Known limits / next

- Daemon lifetime is tied to the Chrome connection — a standalone daemon with reconnect
  mode is future work
- No status-bar equivalent (side panel is a candidate); no network-level observation
  (`chrome.debugger` hybrid is a candidate)
- Registered for stable Chrome only. Canary/Brave need the manifest copied into their own
  NativeMessagingHosts directories
