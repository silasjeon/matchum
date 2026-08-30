// Parse every shipped JavaScript entry point and validate cross-file metadata.
// This catches syntax errors in browser-only glue that the Node tests cannot run.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [
  "bin/matchum-doctor",
  "bin/matchum-ctl",
  "config/config.example.js",
  "config/recipes/tab-groups.js",
  "daemon/daemon.js",
  "daemon/lib/core.js",
  "daemon/lib/module-graph.js",
  "daemon/lib/native-messaging.js",
  "daemon/lib/page-scripts.js",
  "examples/config.showcase.js",
  "extension/background.js",
  "extension/lib/core.js",
  "extension/lib/rpc.js",
  "extension/page.js",
  "extension/popup.js",
  "extension/watcher.js",
  "test/harness.mjs",
  "test/install.mjs",
  "test/run.mjs",
  "test/static.mjs",
  "test/unit.mjs",
];

for (const file of files) {
  execFileSync(process.execPath, ["--check", path.join(ROOT, file)], { stdio: "pipe" });
}
const zsh = "/bin/zsh";
if (fs.existsSync(zsh)) {
  execFileSync(zsh, ["-n", path.join(ROOT, "scripts", "install.sh")], { stdio: "pipe" });
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.template.json"), "utf8"));
if (pkg.name !== manifest.name) {
  throw new Error(`package name ${pkg.name} does not match extension name ${manifest.name}`);
}
if (pkg.version !== manifest.version) {
  throw new Error(`package version ${pkg.version} does not match extension version ${manifest.version}`);
}
if (Number(manifest.minimum_chrome_version) < 135) {
  throw new Error("chrome.userScripts.execute requires minimum_chrome_version 135 or newer");
}
const contentScripts = manifest.content_scripts?.[0]?.js ?? [];
const coreIndex = contentScripts.indexOf("lib/core.js");
const watcherIndex = contentScripts.indexOf("watcher.js");
if (coreIndex === -1 || watcherIndex === -1 || coreIndex > watcherIndex) {
  throw new Error("extension/lib/core.js must load before extension/watcher.js");
}

console.log(`  PASS  parsed ${files.length} JavaScript files`);
if (fs.existsSync(zsh)) console.log("  PASS  parsed the macOS installer");
console.log("  PASS  package and extension metadata agree");
