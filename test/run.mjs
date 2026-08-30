// Run all test suites. `node test/run.mjs` (or `npm test`).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
let failed = false;
const suites = ["static.mjs", "unit.mjs", "harness.mjs"];
if (fs.existsSync("/bin/zsh")) suites.push("install.mjs");
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  try {
    execFileSync(process.execPath, [path.join(here, suite)], { stdio: "inherit" });
  } catch (e) {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
