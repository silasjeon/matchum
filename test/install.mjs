// macOS installer integration: isolated paths, stable identity, idempotent
// updates, doctor validation, and non-destructive uninstall.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matchum-install-test-"));
const configDir = path.join(tmp, "config");
const installDir = path.join(tmp, "share", "matchum");
const binDir = path.join(tmp, "bin");
const nativeHostDir = path.join(tmp, "native-hosts");
const stateDir = path.join(tmp, "state");
const env = {
  ...process.env,
  MATCHUM_NODE_BIN: process.execPath,
  MATCHUM_CONFIG_DIR: configDir,
  MATCHUM_INSTALL_DIR: installDir,
  MATCHUM_BIN_DIR: binDir,
  MATCHUM_NATIVE_HOST_DIR: nativeHostDir,
  MATCHUM_STATE_DIR: stateDir,
  MATCHUM_LEGACY_KEY: path.join(tmp, "no-legacy-key.pem"),
};

let failures = 0;
function check(name, condition) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures++;
}

function runInstaller(...args) {
  return runInstallerWith(env, ...args);
}

function runInstallerWith(runEnv, ...args) {
  return execFileSync("/bin/zsh", [path.join(ROOT, "scripts", "install.sh"), ...args], {
    env: runEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function extensionId(publicKey) {
  const hex = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
  return [...hex].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join("");
}

try {
  runInstaller();
  const keyFile = path.join(configDir, "key.pem");
  const configFile = path.join(configDir, "config.js");
  const manifestFile = path.join(installDir, "extension", "manifest.json");
  const metadataFile = path.join(installDir, "install.json");
  const nativeManifestFile = path.join(nativeHostDir, "com.matchum.daemon.json");

  check(
    "release install writes only to the configured stable paths",
    fs.existsSync(path.join(installDir, ".matchum-install")) &&
      fs.existsSync(path.join(installDir, "daemon", "daemon.js")) &&
      fs.existsSync(manifestFile) &&
      fs.existsSync(keyFile)
  );
  check(
    "first-run config is inert",
    execFileSync(
      process.execPath,
      [
        "-e",
        `globalThis.matchum = new Proxy({}, { get() { throw new Error("config performed work"); } }); require(process.argv[1]);`,
        configFile,
      ],
      { stdio: "ignore" }
    ) === null
  );

  const keyBefore = fs.readFileSync(keyFile);
  const publicDer = crypto.createPublicKey(keyBefore).export({ type: "spki", format: "der" });
  const id = extensionId(publicDer);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  const nativeManifest = JSON.parse(fs.readFileSync(nativeManifestFile, "utf8"));
  check(
    "extension identity agrees across key, manifest, metadata, and native host",
    manifest.key === publicDer.toString("base64") &&
      metadata.extensionId === id &&
      nativeManifest.allowed_origins.includes(`chrome-extension://${id}/`)
  );
  check(
    "installed commands are linked without copying user data into the checkout",
    fs.realpathSync(path.join(binDir, "matchum-ctl")) === fs.realpathSync(path.join(installDir, "bin", "matchum-ctl")) &&
      fs.realpathSync(path.join(binDir, "matchum-doctor")) === fs.realpathSync(path.join(installDir, "bin", "matchum-doctor"))
  );

  fs.writeFileSync(configFile, "// user-owned config\n");
  runInstaller();
  check("update preserves extension identity", fs.readFileSync(keyFile).equals(keyBefore));
  check("update preserves user config", fs.readFileSync(configFile, "utf8") === "// user-owned config\n");
  check("update retains one managed rollback copy", fs.existsSync(`${installDir}.previous/.matchum-install`));

  const doctor = execFileSync(path.join(installDir, "bin", "matchum-doctor"), [], {
    env,
    encoding: "utf8",
  });
  check("doctor validates a disconnected installation", doctor.includes("extension id") && !doctor.includes("FAIL"));

  runInstaller("uninstall");
  check(
    "uninstall removes runtime, registration, and managed links",
    !fs.existsSync(installDir) &&
      !fs.existsSync(`${installDir}.previous`) &&
      !fs.existsSync(nativeManifestFile) &&
      !fs.existsSync(path.join(binDir, "matchum-ctl"))
  );
  check("uninstall retains identity and user config", fs.existsSync(keyFile) && fs.existsSync(configFile));

  const migratedConfigDir = path.join(tmp, "migrated-config");
  const migratedInstallDir = path.join(tmp, "migrated-share", "matchum");
  const migratedEnv = {
    ...env,
    MATCHUM_CONFIG_DIR: migratedConfigDir,
    MATCHUM_INSTALL_DIR: migratedInstallDir,
    MATCHUM_BIN_DIR: path.join(tmp, "migrated-bin"),
    MATCHUM_NATIVE_HOST_DIR: path.join(tmp, "migrated-native-hosts"),
    MATCHUM_LEGACY_KEY: keyFile,
  };
  runInstallerWith(migratedEnv);
  check(
    "legacy checkout identity migrates without changing the extension id",
    fs.readFileSync(path.join(migratedConfigDir, "key.pem")).equals(keyBefore) &&
      JSON.parse(fs.readFileSync(path.join(migratedInstallDir, "install.json"), "utf8"))
        .extensionId === id
  );

  const sentinel = path.join(installDir, "user-owned.txt");
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(sentinel, "keep\n");
  let refusedUnmanaged = false;
  try {
    runInstaller();
  } catch (error) {
    refusedUnmanaged = /refusing to replace unmanaged directory/.test(
      `${error.stderr || ""}`
    );
  }
  check(
    "update refuses an unmarked directory without deleting its contents",
    refusedUnmanaged && fs.readFileSync(sentinel, "utf8") === "keep\n"
  );
} catch (error) {
  console.error(`  FAIL  ${error.stderr?.toString() || error.stack || error.message}`);
  failures++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
