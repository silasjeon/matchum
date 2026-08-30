#!/bin/zsh
# matchum installer (macOS / Chrome)
#
# Default: copy a stable runtime to ~/.local/share/matchum.
# --dev:   point Chrome at this checkout while keeping identity outside it.
# doctor:  validate the installation without changing it.
# uninstall: remove installed code and registration, retaining config and state.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-install}"
HOST_NAME="com.matchum.daemon"
CONFIG_DIR="${MATCHUM_CONFIG_DIR:-$HOME/.config/matchum}"
INSTALL_DIR="${MATCHUM_INSTALL_DIR:-$HOME/.local/share/matchum}"
BIN_DIR="${MATCHUM_BIN_DIR:-$HOME/.local/bin}"
NM_DIR="${MATCHUM_NATIVE_HOST_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
LEGACY_KEY="${MATCHUM_LEGACY_KEY:-$ROOT/scripts/key.pem}"
KEY="$CONFIG_DIR/key.pem"
NATIVE_MANIFEST="$NM_DIR/$HOST_NAME.json"
MARKER=".matchum-install"

usage() {
  cat >&2 <<'EOF'
usage: scripts/install.sh [--dev|doctor|uninstall]

  (no argument)  install or update a stable copy under ~/.local/share/matchum
  --dev          use this checkout directly (identity still lives outside it)
  doctor         validate files, identity, registration, and daemon status
  uninstall      remove installed code and registration; keep config and state
EOF
  exit 2
}

fail() {
  echo "install: $*" >&2
  exit 1
}

case "$ACTION" in
  install) MODE="release" ;;
  --dev) MODE="dev" ;;
  doctor)
    exec "$ROOT/bin/matchum-doctor"
    ;;
  uninstall) MODE="uninstall" ;;
  -h|--help) usage ;;
  *) usage ;;
esac

NODE_BIN="${MATCHUM_NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || fail "Node 22 or newer is required"
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' ||
  fail "Node 22 or newer is required (found $("$NODE_BIN" --version))"

managed_dir() {
  local dir="$1"
  [[ -n "$dir" && "$dir" != "/" && "$dir" != "$HOME" && -f "$dir/$MARKER" ]]
}

remove_managed_dir() {
  local dir="$1"
  [[ ! -e "$dir" ]] && return
  managed_dir "$dir" || fail "refusing to remove unmanaged directory: $dir"
  rm -rf -- "$dir"
}

remove_managed_link() {
  local link="$1"
  [[ ! -L "$link" ]] && return
  local target="$(readlink "$link")"
  if [[ "$target" == "$INSTALL_DIR/"* || "$target" == "$ROOT/"* ]]; then
    rm -- "$link"
  else
    echo "kept unrelated symlink: $link -> $target"
  fi
}

if [[ "$MODE" == "uninstall" ]]; then
  remove_managed_link "$BIN_DIR/matchum-ctl"
  remove_managed_link "$BIN_DIR/matchum-doctor"
  [[ -e "$NATIVE_MANIFEST" ]] && rm -- "$NATIVE_MANIFEST"
  remove_managed_dir "$INSTALL_DIR"
  remove_managed_dir "$INSTALL_DIR.previous"
  echo "uninstalled matchum runtime and Chrome native-host registration."
  echo "kept user data: $CONFIG_DIR and ${MATCHUM_STATE_DIR:-$HOME/.local/state/matchum}"
  echo "remove the unpacked extension from chrome://extensions when no longer needed."
  exit 0
fi

command -v openssl >/dev/null || fail "openssl is required"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ ! -f "$KEY" ]]; then
  if [[ -f "$LEGACY_KEY" ]]; then
    install -m 600 "$LEGACY_KEY" "$KEY"
    echo "migrated extension identity: $LEGACY_KEY -> $KEY"
  else
    KEY_TMP="$KEY.$$.tmp"
    openssl genrsa -out "$KEY_TMP" 2048 2>/dev/null
    chmod 600 "$KEY_TMP"
    mv "$KEY_TMP" "$KEY"
    echo "generated $KEY (back it up; it pins the extension id)"
  fi
fi
chmod 600 "$KEY"

PUB_B64="$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"
EXT_ID="$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null |
  "$NODE_BIN" -e '
    const crypto = require("node:crypto");
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const hex = crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex").slice(0, 32);
      process.stdout.write([...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join(""));
    });
  ')"

write_manifest() {
  local template="$1"
  local out="$2"
  "$NODE_BIN" - "$template" "$out" "$PUB_B64" <<'EOF'
const fs = require("node:fs");
const [template, out, key] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(template, "utf8"));
manifest.key = key;
const tmp = `${out}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, out);
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}
EOF
}

write_wrapper() {
  local out="$1"
  local daemon="$2"
  local tmp="$out.$$.tmp"
  printf '#!/bin/zsh\nexec %q %q\n' "$NODE_BIN" "$daemon" > "$tmp"
  chmod 755 "$tmp"
  mv "$tmp" "$out"
}

write_metadata() {
  local out="$1"
  local mode="$2"
  local extension="$3"
  local daemon="$4"
  "$NODE_BIN" - "$out" "$mode" "$extension" "$daemon" "$EXT_ID" <<'EOF'
const fs = require("node:fs");
const [out, mode, extension, daemon, extensionId] = process.argv.slice(2);
const metadata = { version: 1, mode, extension, daemon, extensionId };
const tmp = `${out}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmp, `${JSON.stringify(metadata, null, 2)}\n`);
  fs.renameSync(tmp, out);
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}
EOF
}

write_native_manifest() {
  mkdir -p "$NM_DIR"
  "$NODE_BIN" - "$NATIVE_MANIFEST" "$HOST_NAME" "$INSTALL_DIR/matchum-host" "$EXT_ID" <<'EOF'
const fs = require("node:fs");
const [file, name, hostPath, extensionId] = process.argv.slice(2);
const manifest = {
  name,
  description: "matchum daemon",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
const tmp = `${file}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, file);
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}
EOF
}

install_link() {
  local target="$1"
  local link="$2"
  if [[ -e "$link" && ! -L "$link" ]]; then
    echo "kept existing file (add matchum to PATH yourself): $link"
    return
  fi
  ln -sfn "$target" "$link"
}

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

if [[ "$MODE" == "release" ]]; then
  if [[ -e "$INSTALL_DIR" ]]; then
    managed_dir "$INSTALL_DIR" || fail "refusing to replace unmanaged directory: $INSTALL_DIR"
  fi

  STAGE="$(mktemp -d "$(dirname "$INSTALL_DIR")/.matchum-install.XXXXXX")"
  cleanup_stage() { [[ -n "${STAGE:-}" && -d "$STAGE" ]] && rm -rf -- "$STAGE"; }
  trap cleanup_stage EXIT

  mkdir -p "$STAGE/bin" "$STAGE/config/recipes" "$STAGE/daemon/lib" "$STAGE/extension/lib"
  touch "$STAGE/$MARKER"
  cp "$ROOT/bin/matchum-ctl" "$STAGE/bin/matchum-ctl"
  cp "$ROOT/bin/matchum-doctor" "$STAGE/bin/matchum-doctor"
  cp "$ROOT/config/recipes/tab-groups.js" "$STAGE/config/recipes/tab-groups.js"
  cp "$ROOT/daemon/daemon.js" "$STAGE/daemon/daemon.js"
  cp "$ROOT/daemon/lib/core.js" "$STAGE/daemon/lib/core.js"
  cp "$ROOT/daemon/lib/module-graph.js" "$STAGE/daemon/lib/module-graph.js"
  cp "$ROOT/daemon/lib/native-messaging.js" "$STAGE/daemon/lib/native-messaging.js"
  cp "$ROOT/daemon/lib/page-scripts.js" "$STAGE/daemon/lib/page-scripts.js"
  cp "$ROOT/extension/background.js" "$STAGE/extension/background.js"
  cp "$ROOT/extension/icon.png" "$STAGE/extension/icon.png"
  cp "$ROOT/extension/lib/core.js" "$STAGE/extension/lib/core.js"
  cp "$ROOT/extension/lib/rpc.js" "$STAGE/extension/lib/rpc.js"
  cp "$ROOT/extension/manifest.template.json" "$STAGE/extension/manifest.template.json"
  cp "$ROOT/extension/page.html" "$STAGE/extension/page.html"
  cp "$ROOT/extension/page.js" "$STAGE/extension/page.js"
  cp "$ROOT/extension/popup.html" "$STAGE/extension/popup.html"
  cp "$ROOT/extension/popup.js" "$STAGE/extension/popup.js"
  cp "$ROOT/extension/watcher.js" "$STAGE/extension/watcher.js"
  chmod 755 "$STAGE/bin/matchum-ctl" "$STAGE/bin/matchum-doctor" "$STAGE/daemon/daemon.js"
  write_manifest "$STAGE/extension/manifest.template.json" "$STAGE/extension/manifest.json"
  write_wrapper "$STAGE/matchum-host" "$INSTALL_DIR/daemon/daemon.js"
  write_metadata "$STAGE/install.json" "$MODE" "$INSTALL_DIR/extension" "$INSTALL_DIR/daemon/daemon.js"

  remove_managed_dir "$INSTALL_DIR.previous"
  if [[ -e "$INSTALL_DIR" ]]; then mv "$INSTALL_DIR" "$INSTALL_DIR.previous"; fi
  if ! mv "$STAGE" "$INSTALL_DIR"; then
    [[ -e "$INSTALL_DIR.previous" ]] && mv "$INSTALL_DIR.previous" "$INSTALL_DIR"
    fail "could not activate staged installation"
  fi
  STAGE=""
  EXTENSION_DIR="$INSTALL_DIR/extension"
  CLI_TARGET="$INSTALL_DIR/bin/matchum-ctl"
  DOCTOR_TARGET="$INSTALL_DIR/bin/matchum-doctor"
else
  if [[ -e "$INSTALL_DIR" ]]; then
    managed_dir "$INSTALL_DIR" || fail "refusing to use unmanaged directory: $INSTALL_DIR"
  else
    mkdir -p "$INSTALL_DIR"
    touch "$INSTALL_DIR/$MARKER"
  fi
  write_manifest "$ROOT/extension/manifest.template.json" "$ROOT/extension/manifest.json"
  write_wrapper "$INSTALL_DIR/matchum-host" "$ROOT/daemon/daemon.js"
  write_metadata "$INSTALL_DIR/install.json" "$MODE" "$ROOT/extension" "$ROOT/daemon/daemon.js"
  EXTENSION_DIR="$ROOT/extension"
  CLI_TARGET="$ROOT/bin/matchum-ctl"
  DOCTOR_TARGET="$ROOT/bin/matchum-doctor"
fi

write_native_manifest
install_link "$CLI_TARGET" "$BIN_DIR/matchum-ctl"
install_link "$DOCTOR_TARGET" "$BIN_DIR/matchum-doctor"

if [[ ! -f "$CONFIG_DIR/config.js" ]]; then
  cp "$ROOT/config/config.example.js" "$CONFIG_DIR/config.js"
  chmod 600 "$CONFIG_DIR/config.js"
  echo "seeded inert config: $CONFIG_DIR/config.js"
fi

echo ""
echo "installed matchum ($MODE)."
echo "  extension id : $EXT_ID"
echo "  extension    : $EXTENSION_DIR"
echo "  host manifest: $NATIVE_MANIFEST"
echo "  user config  : $CONFIG_DIR/config.js"
echo "  cli          : $BIN_DIR/matchum-ctl"
echo ""
echo "next: chrome://extensions -> Developer mode -> 'Load unpacked' -> $EXTENSION_DIR"
echo "then enable 'Allow User Scripts' on matchum's extension details page."
echo "verify with: $BIN_DIR/matchum-doctor"
