#!/bin/bash
# package-deb.sh — build a native .deb package for the detected Debian
# architecture (amd64 or arm64).
#
# Prerequisites:
#   - Run on a Debian-compatible Linux host whose native architecture is
#     amd64 or arm64. Native payloads (better-sqlite3, the Go PTY host, the
#     Go client, the Go launcher) cannot be cross-compiled reliably, so the
#     package architecture is detected from the build host, never supplied
#     by the caller.
#   - Node >= 22, npm, dpkg-deb, dpkg-scanpackages (for the repository
#     builder, not this script), `file`, `go`.
#
# Output:
#   releases/deb/<version>/<arch>/switchboard_<version>_<arch>.deb
#   releases/deb/<version>/<arch>/switchboard_<version>_<arch>.deb.manifest.json
#
# The package vendors better-sqlite3 and the platform-selected Go PTY host,
# client and launcher for the detected architecture at package-build time, so
# no target ever needs a compiler. See amd64-package-and-an-apt-repository.md.
#
# Architecture detection (plan: amd64-package-and-an-apt-repository):
#   The native Debian architecture (dpkg --print-architecture) and the Node
#   architecture (process.arch) are resolved independently, mapped to the
#   supported Debian names, and required to agree. An optional
#   --expect-arch argument is an assertion that fails on mismatch — it is
#   never the source of package metadata. A caller-supplied target is not
#   proof of the bytes produced.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Argument parsing ──────────────────────────────────────────────────────
EXPECT_ARCH=""
for arg in "$@"; do
  case "$arg" in
    --expect-arch=*) EXPECT_ARCH="${arg#*=}" ;;
    --expect-arch)   echo "ERROR: --expect-arch requires a value (use --expect-arch=amd64)" >&2; exit 2 ;;
    --help|-h)
      cat <<'USAGE'
package-deb.sh [--expect-arch=amd64|arm64]

Builds a native .deb for the DETECTED Debian architecture. --expect-arch is
an assertion only: the build fails if the detected architecture does not
match it. It never supplies package metadata.
USAGE
      exit 0 ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

# ── Architecture detection ────────────────────────────────────────────────
# Resolve the native Debian architecture and the Node architecture
# independently, map them to the supported Debian names, and require agreement.
if ! command -v dpkg >/dev/null 2>&1; then
  echo "ERROR: dpkg not found — this script builds a Debian package on a Debian-compatible host." >&2
  exit 1
fi
DEB_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
if [[ -z "$DEB_ARCH" ]]; then
  echo "ERROR: dpkg --print-architecture returned empty. Cannot detect native Debian architecture." >&2
  exit 1
fi

NODE_ARCH_RAW="$(node -p "process.arch" 2>/dev/null || true)"
if [[ -z "$NODE_ARCH_RAW" ]]; then
  echo "ERROR: could not resolve process.arch. Node is required to build." >&2
  exit 1
fi

# Map Node arch -> Debian arch. Only the two supported Linux targets.
map_node_to_deb() {
  case "$1" in
    x64)   printf 'amd64' ;;
    arm64) printf 'arm64' ;;
    *)     printf '' ;;
  esac
}
NODE_DEB_ARCH="$(map_node_to_deb "$NODE_ARCH_RAW")"

if [[ "$DEB_ARCH" != "amd64" && "$DEB_ARCH" != "arm64" ]]; then
  echo "ERROR: detected Debian architecture '$DEB_ARCH' is not one of amd64, arm64." >&2
  echo "       This package supports Debian-compatible amd64 and arm64 only." >&2
  exit 1
fi
if [[ -z "$NODE_DEB_ARCH" ]]; then
  echo "ERROR: Node process.arch '$NODE_ARCH_RAW' does not map to a supported Debian architecture." >&2
  exit 1
fi
if [[ "$DEB_ARCH" != "$NODE_DEB_ARCH" ]]; then
  echo "ERROR: architecture mismatch — Debian dpkg reports '$DEB_ARCH' but Node process.arch '$NODE_ARCH_RAW' maps to '$NODE_DEB_ARCH'." >&2
  echo "       A wrong-architecture package would carry native modules that cannot load on the target." >&2
  exit 1
fi
ARCH="$DEB_ARCH"

# --expect-arch is an assertion, never the source of metadata.
if [[ -n "$EXPECT_ARCH" ]]; then
  if [[ "$EXPECT_ARCH" != "amd64" && "$EXPECT_ARCH" != "arm64" ]]; then
    echo "ERROR: --expect-arch '$EXPECT_ARCH' is not amd64 or arm64." >&2
    exit 2
  fi
  if [[ "$EXPECT_ARCH" != "$ARCH" ]]; then
    echo "ERROR: --expect-arch '$EXPECT_ARCH' does not match detected architecture '$ARCH'." >&2
    echo "       Build on the matching native host; do not cross-compile." >&2
    exit 2
  fi
fi

# Node runtime version — recorded in the sidecar manifest.
NODE_VERSION="$(node -p "process.version" 2>/dev/null || echo unknown)"

# ── Version + paths ───────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version")
PKG_NAME="switchboard"
# The Node >=22 application contract (package.json engines). The package
# Depends line is derived from this single reviewable constant so a future
# floor change touches one place, not a buried heredoc.
# Derived from package.json `engines.node`, never typed twice: the plan requires
# the packaging floor to MATCH the application contract, and a hand-copied
# literal drifts silently the moment the engine floor moves.
NODE_ENGINE_FLOOR="$(node -p "
  const r = require('./package.json').engines && require('./package.json').engines.node;
  if (!r) { console.error('package.json has no engines.node'); process.exit(1); }
  const m = String(r).match(/(\\d+)/);
  if (!m) { console.error('cannot parse a major version from engines.node: ' + r); process.exit(1); }
  m[1];
")"
if [[ -z "$NODE_ENGINE_FLOOR" ]]; then
  echo "ERROR: could not derive the Node engine floor from package.json engines.node" >&2
  exit 1
fi
DEB_NAME="${PKG_NAME}_${VERSION}_${ARCH}.deb"
OUT_DIR="releases/deb/${VERSION}/${ARCH}"
mkdir -p "$OUT_DIR"
OUT_PATH="$OUT_DIR/$DEB_NAME"
MANIFEST_PATH="$OUT_DIR/$DEB_NAME.manifest.json"

# Source revision (git). Recorded so the repository builder can reject a
# mixed-revision release set. Empty when not a git checkout.
SOURCE_REVISION="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo '')"
SOURCE_DIRTY=""
if [[ -n "$SOURCE_REVISION" ]]; then
  if ! git -C "$ROOT_DIR" diff --quiet 2>/dev/null || ! git -C "$ROOT_DIR" diff --cached --quiet 2>/dev/null; then
    SOURCE_DIRTY="dirty"
  fi
fi

# Map Debian arch -> Go GOARCH + pty-host manifest target key.
case "$ARCH" in
  amd64) GOARCH="amd64"; PTY_TARGET="linux-amd64"; LAUNCHER_GOARCH="amd64" ;;
  arm64) GOARCH="arm64"; PTY_TARGET="linux-arm64"; LAUNCHER_GOARCH="arm64" ;;
esac

echo "Building ${DEB_NAME} (detected Debian arch: ${ARCH}, Node arch: ${NODE_ARCH_RAW}, Node ${NODE_VERSION})..."

# ── 1. Compile TypeScript ─────────────────────────────────────────────────
echo "Compiling TypeScript..."
npm run compile || { echo "FAILED: compile failed"; exit 1; }

# ── 2. Verify native modules + Go PTY host for the detected arch ──────────
echo "Verifying native database module and Go PTY host..."
node -e "require('better-sqlite3')" || { echo "FAILED: better-sqlite3 not loadable"; exit 1; }
PTY_HOST_SRC="dist/${PTY_TARGET}/switchboard-pty-host"
[ -f "$PTY_HOST_SRC" ] || { echo "FAILED: $PTY_HOST_SRC missing — build the Go PTY host first"; exit 1; }
[ -x "$PTY_HOST_SRC" ] || { echo "FAILED: $PTY_HOST_SRC is not executable"; exit 1; }
PTY_READY=$(printf '' | "$PTY_HOST_SRC" --workspace "$ROOT_DIR")
node -e 'const m=JSON.parse(process.argv[1]); if(m.t!=="ready"||m.version!==1||!Number.isInteger(m.port)||!m.token) process.exit(1)' "$PTY_READY" || {
  echo "FAILED: Go PTY host version/handshake probe failed"; exit 1;
}
# Assert the PTY host binary's ELF machine matches the detected arch.
PTY_HOST_FILE="$(file -b "$PTY_HOST_SRC")"
case "$ARCH" in
  amd64) echo "$PTY_HOST_FILE" | grep -q 'x86-64' || { echo "FAILED: $PTY_HOST_SRC is not an x86-64 binary (file: $PTY_HOST_FILE)"; exit 1; } ;;
  arm64) echo "$PTY_HOST_FILE" | grep -q 'ARM aarch64\|ARM64\|aarch64' || { echo "FAILED: $PTY_HOST_SRC is not an aarch64 binary (file: $PTY_HOST_FILE)"; exit 1; } ;;
esac
echo "Native database module and Go PTY host verified for ${ARCH}."

# ── 3. Build the .deb using dpkg-deb directly ─────────────────────────────
BUILD_DIR=$(mktemp -d)
cleanup() { rm -rf "$BUILD_DIR"; }
trap cleanup EXIT

# 3b. Build and verify the static Go launcher for the detected arch.
echo "Building static Go launcher (linux/${LAUNCHER_GOARCH})..."
LAUNCHER_SRC="cmd/switchboard-launcher"
LAUNCHER_BIN="$BUILD_DIR/switchboard-launcher"
[ -d "$LAUNCHER_SRC" ] || { echo "FAILED: $LAUNCHER_SRC missing — launcher source tree not found"; exit 1; }
LAUNCHER_VERSION="$VERSION"
CGO_ENABLED=0 GOOS=linux GOARCH="$LAUNCHER_GOARCH" go build \
  -trimpath -ldflags "-s -w -X main.launcherVersion=${LAUNCHER_VERSION} -X main.buildArch=linux/${LAUNCHER_GOARCH}" \
  -o "$LAUNCHER_BIN" ./cmd/switchboard-launcher \
  || { echo "FAILED: Go launcher build failed"; exit 1; }
[ -x "$LAUNCHER_BIN" ] || { echo "FAILED: $LAUNCHER_BIN is not executable"; exit 1; }
"$LAUNCHER_BIN" version || { echo "FAILED: launcher version probe failed"; exit 1; }
# Assert the launcher binary's ELF machine matches the detected arch.
LAUNCHER_FILE="$(file -b "$LAUNCHER_BIN")"
case "$ARCH" in
  amd64) echo "$LAUNCHER_FILE" | grep -q 'x86-64' || { echo "FAILED: launcher is not an x86-64 binary (file: $LAUNCHER_FILE)"; exit 1; } ;;
  arm64) echo "$LAUNCHER_FILE" | grep -q 'ARM aarch64\|ARM64\|aarch64' || { echo "FAILED: launcher is not an aarch64 binary (file: $LAUNCHER_FILE)"; exit 1; } ;;
esac
echo "Static Go launcher (linux/${LAUNCHER_GOARCH}) built and verified."

INSTALL_DIR="$BUILD_DIR/deb"
mkdir -p "$INSTALL_DIR/DEBIAN"
mkdir -p "$INSTALL_DIR/usr/lib/switchboard"
mkdir -p "$INSTALL_DIR/usr/bin"
mkdir -p "$INSTALL_DIR/etc/switchboard"
mkdir -p "$INSTALL_DIR/lib/systemd/system"

# Copy built dist. The Go manifest is rewritten for the package root because
# the Debian layout flattens dist/ into /usr/lib/switchboard/.
cp -a dist/* "$INSTALL_DIR/usr/lib/switchboard/"
node - <<'NODE' "$INSTALL_DIR/usr/lib/switchboard/pty-host-artifacts.json"
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync('pty-host-artifacts.json', 'utf8'));
for (const key of Object.keys(manifest.targets)) manifest.targets[key] = manifest.targets[key].replace(/^dist\//, '');
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
NODE

# The CLI is exec'd directly by /usr/bin/switchboard and by the systemd unit.
# webpack's BannerPlugin gives it a `#!/usr/bin/env node` shebang, but the
# emitted file is mode 0644 — systemd would fail the unit with 203/EXEC and the
# operator would see a unit that never starts and no reason why. Assert the
# shebang and set the exec bit here, where it costs a rebuild.
CLI_JS="$INSTALL_DIR/usr/lib/switchboard/standalone/cli.js"
[ -f "$CLI_JS" ] || { echo "FAILED: $CLI_JS missing — did npm run compile emit dist/standalone?"; exit 1; }
head -c 2 "$CLI_JS" | grep -q '#!' || {
  echo "FAILED: dist/standalone/cli.js has no shebang — /usr/bin/switchboard would fail with 203/EXEC"; exit 1;
}
chmod 755 "$CLI_JS"

# Copy vendored node_modules. Production only: the dev tree is hundreds of MB
# of build tooling no target needs, and it would ship inside the package.
echo "Vendoring production node_modules..."
VENDOR_DIR="$BUILD_DIR/vendor"
mkdir -p "$VENDOR_DIR"
cp package.json package-lock.json "$VENDOR_DIR/"
( cd "$VENDOR_DIR" && npm ci --omit=dev --ignore-scripts=false )
cp -a "$VENDOR_DIR/node_modules" "$INSTALL_DIR/usr/lib/switchboard/node_modules"

# There is no PTY prebuild staging or strip any more: terminals are owned by the
# static Go host copied above, and the retired native PTY module is gone from
# package.json. better-sqlite3 is the only remaining native module.
# Verify the native database module resolves out of the VENDORED tree, not the repo's.
node -e "require('$INSTALL_DIR/usr/lib/switchboard/node_modules/better-sqlite3')" \
  || { echo "FAILED: better-sqlite3 missing from the vendored tree"; exit 1; }
echo "Vendored native modules verified."

# Entry point. `/usr/bin/switchboard` is the STATIC GO CLIENT, not a symlink to
# the 17 MB Node bundle: the client verbs are one HTTP request each and paying a
# bundle parse for them is the whole cost this feature removes. The Go front
# controller hands every non-client verb (local, tailnet, setup, secrets,
# import/export, control-plane) to the Node entry that remains installed at
# /usr/lib/switchboard/standalone/cli.js — the absolute path declared in
# client-artifacts.json's `nodeHostEntry.deb`. The systemd unit's ExecStart is
# `/usr/bin/switchboard service --no-open`, so it DOES go through this client:
# `service` is not an owned verb, so the client syscall-execs the Node entry in
# place and systemd's MainPID is preserved (plan: go-cli-client-verbs).
CLIENT_BIN="$BUILD_DIR/switchboard-client"
echo "Building static Go client for linux/${GOARCH}..."
CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -trimpath \
  -ldflags "-s -w -X main.clientVersion=${VERSION}" \
  -o "$CLIENT_BIN" ./cmd/switchboard \
  || { echo "FAILED: static Go client build failed for linux/${GOARCH}"; exit 1; }
[ -x "$CLIENT_BIN" ] || { echo "FAILED: $CLIENT_BIN is not executable"; exit 1; }
cp "$CLIENT_BIN" "$INSTALL_DIR/usr/bin/switchboard"
chmod 755 "$INSTALL_DIR/usr/bin/switchboard"
# Client manifest for the HOST's own resolution. `cliPathToken.resolveGoClientPath`
# probes for client-artifacts.json next to the bundle and above it, so the Debian
# layout gets its own copy pointing at the installed absolute path. Without it the
# host emits `node "<17 MB bundle>"` in every dispatched prompt even though the Go
# client is installed one directory away (plan: go-cli-client-verbs).
cat > "$INSTALL_DIR/usr/lib/switchboard/client-artifacts.json" <<JSON
{
  "version": 1,
  "binary": "switchboard",
  "description": "Static Go client installed by the Debian package.",
  "targets": {
    "linux-${GOARCH}": "../../bin/switchboard"
  },
  "nodeHostEntry": {
    "deb": "/usr/lib/switchboard/standalone/cli.js"
  }
}
JSON

# Static Go launcher. The desktop entry names it directly so icon launches go
# through the launcher, not `switchboard local` (which was cwd-sensitive and
# could serve $HOME). The launcher is a static binary with no Node dependency,
# so it can run before Node.js is installed.
cp "$LAUNCHER_BIN" "$INSTALL_DIR/usr/bin/switchboard-launcher"
chmod 755 "$INSTALL_DIR/usr/bin/switchboard-launcher"

# Desktop entry + icon (Linux desktop install; harmless on a headless Pi)
mkdir -p "$INSTALL_DIR/usr/share/applications"
cp packaging/switchboard.desktop "$INSTALL_DIR/usr/share/applications/switchboard.desktop"
[ -f icon.png ] || { echo "FAILED: icon.png missing — the desktop entry names Icon=switchboard"; exit 1; }
mkdir -p "$INSTALL_DIR/usr/share/icons/hicolor/256x256/apps"
cp icon.png "$INSTALL_DIR/usr/share/icons/hicolor/256x256/apps/switchboard.png"

# Config file (conffile)
cp packaging/debian/switchboard.env "$INSTALL_DIR/etc/switchboard/switchboard.env"
echo "/etc/switchboard/switchboard.env" > "$INSTALL_DIR/DEBIAN/conffiles"

# Systemd unit
cp packaging/debian/switchboard.service "$INSTALL_DIR/lib/systemd/system/switchboard.service"

# Control file. Architecture is stamped from the DETECTED value, never a
# hardcoded literal. Depends derives from the single NODE_ENGINE_FLOOR constant
# so a future floor change touches one place.
cat > "$INSTALL_DIR/DEBIAN/control" << EOF
Package: switchboard
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Switchboard <noreply@switchboard.ai>
Depends: nodejs (>= ${NODE_ENGINE_FLOOR})
Recommends: tailscale
Section: utils
Priority: optional
Description: Switchboard — plan-driven agent orchestration board
 Switchboard is a standalone board and fleet manager for AI coding agents.
 It runs a local web board, dispatches work to agent CLIs, and tracks plans
 through a kanban workflow. This package installs the standalone host,
 a systemd service, and the switchboard CLI.
 .
 The package vendors better-sqlite3 and the static Go PTY host, client and
 launcher for ${ARCH}, so no compiler is needed on the target.
EOF

# Maintainer scripts
cp packaging/debian/postinst "$INSTALL_DIR/DEBIAN/postinst"
cp packaging/debian/prerm "$INSTALL_DIR/DEBIAN/prerm"
cp packaging/debian/postrm "$INSTALL_DIR/DEBIAN/postrm"
chmod 755 "$INSTALL_DIR/DEBIAN/postinst" "$INSTALL_DIR/DEBIAN/prerm" "$INSTALL_DIR/DEBIAN/postrm"

# ── 4. Build the .deb ─────────────────────────────────────────────────────
echo "Building .deb..."
dpkg-deb --build --root-owner-group "$INSTALL_DIR" "$OUT_PATH"

# ── 5. Post-build validation ──────────────────────────────────────────────
# Inspect the package control metadata and staged native binary formats;
# assert package architecture, Node architecture, and native payload agree.
PKG_CTRL_ARCH="$(dpkg-deb -f "$OUT_PATH" Architecture 2>/dev/null || true)"
if [[ "$PKG_CTRL_ARCH" != "$ARCH" ]]; then
  echo "FAILED: package control Architecture is '$PKG_CTRL_ARCH', expected '$ARCH'" >&2
  exit 1
fi
PKG_CTRL_VERSION="$(dpkg-deb -f "$OUT_PATH" Version 2>/dev/null || true)"
if [[ "$PKG_CTRL_VERSION" != "$VERSION" ]]; then
  echo "FAILED: package control Version is '$PKG_CTRL_VERSION', expected '$VERSION'" >&2
  exit 1
fi
# Inspect every staged .node native addon and the two Go binaries; assert each
# ELF machine matches the package architecture.
validate_native_elf() {
  local elf_path="$1" label="$2"
  local f
  f="$(file -b "$elf_path")"
  case "$ARCH" in
    amd64) echo "$f" | grep -q 'x86-64' || { echo "FAILED: $label native binary is not x86-64 (file: $f)" >&2; exit 1; } ;;
    arm64) echo "$f" | grep -q 'ARM aarch64\|ARM64\|aarch64' || { echo "FAILED: $label native binary is not aarch64 (file: $f)" >&2; exit 1; } ;;
  esac
}
# better-sqlite3 .node addon
BETTER_SQLITE3_NODE="$(find "$INSTALL_DIR/usr/lib/switchboard/node_modules/better-sqlite3" -name '*.node' -type f 2>/dev/null | head -1)"
if [[ -z "$BETTER_SQLITE3_NODE" ]]; then
  echo "FAILED: no better-sqlite3 .node addon found in staged tree" >&2
  exit 1
fi
validate_native_elf "$BETTER_SQLITE3_NODE" "better-sqlite3"
# Go binaries
validate_native_elf "$INSTALL_DIR/usr/lib/switchboard/${PTY_TARGET}/switchboard-pty-host" "Go PTY host"
validate_native_elf "$INSTALL_DIR/usr/bin/switchboard" "Go client"
validate_native_elf "$INSTALL_DIR/usr/bin/switchboard-launcher" "Go launcher"
echo "Post-build native payload validation passed for ${ARCH}."

# ── 6. Sidecar manifest ───────────────────────────────────────────────────
# Machine-readable, consumed by the repository builder to reject a
# mixed-version or mixed-revision release set. Records the final SHA-256 so
# the repository builder can detect a changed artifact at an existing version.
PKG_SHA256="$(sha256sum "$OUT_PATH" | awk '{print $1}')"
PKG_INSTALLED_SIZE="$(dpkg-deb -f "$OUT_PATH" Installed-Size 2>/dev/null || echo 0)"
# Payload listing: every file under /usr/lib/switchboard, relative paths, sorted.
PAYLOAD_LISTING="$(cd "$INSTALL_DIR" && find usr/lib/switchboard -type f | sort | tr '\n' ',' | sed 's/,$//')"

node - <<NODE "$MANIFEST_PATH" "$VERSION" "$ARCH" "$NODE_VERSION" "$NODE_ARCH_RAW" "$SOURCE_REVISION" "$SOURCE_DIRTY" "$PKG_SHA256" "$PKG_INSTALLED_SIZE" "$PAYLOAD_LISTING" "$NODE_ENGINE_FLOOR"
const fs = require('fs');
const file = process.argv[2];
const manifest = {
  schemaVersion: 1,
  applicationVersion: process.argv[3],
  packageArchitecture: process.argv[4],
  nodeVersion: process.argv[5],
  nodeArch: process.argv[6],
  sourceRevision: process.argv[7] || null,
  sourceDirty: process.argv[8] === 'dirty',
  packageSha256: process.argv[9],
  packageInstalledSizeKB: Number(process.argv[10]) || 0,
  payloadListing: (process.argv[11] || '').split(',').filter(Boolean),
  nodeEngineFloor: Number(process.argv[12]),
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
NODE

echo ""
echo "Built: ${OUT_PATH}"
echo "Manifest: ${MANIFEST_PATH}"
echo "Architecture: ${ARCH} (detected from dpkg + process.arch)"
echo "Install with: sudo apt install ./${OUT_PATH}"
echo "Then run:     switchboard setup host"
