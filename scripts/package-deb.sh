#!/bin/bash
# package-deb.sh — build an arm64 .deb package for Raspberry Pi OS.
#
# Prerequisites:
#   - Run on an arm64 host (Pi 4/5 or arm64 runner). Native modules
#     cannot be cross-compiled reliably.
#   - Node >= 22, npm, debhelper, dh-make
#
# Output:
#   switchboard_<version>_arm64.deb
#
# The package vendors better-sqlite3 and the platform-selected Go PTY host
# for arm64 at package-build time, so no target Pi ever needs a compiler.
# See raspberry-pi-installs-switchboard-with-apt.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Extract version from package.json
VERSION=$(node -p "require('./package.json').version")
PKG_NAME="switchboard"
DEB_NAME="${PKG_NAME}_${VERSION}_arm64.deb"

echo "Building ${DEB_NAME}..."

# 1. Compile the TypeScript
echo "Compiling TypeScript..."
npm run compile || { echo "Compile failed"; exit 1; }

# 2. Verify the native database module and the platform-selected Go PTY host
echo "Verifying native database module and Go PTY host..."
node -e "require('better-sqlite3')" || { echo "FAILED: better-sqlite3 not loadable"; exit 1; }
PTY_HOST_SRC="dist/linux-arm64/switchboard-pty-host"
[ -f "$PTY_HOST_SRC" ] || { echo "FAILED: $PTY_HOST_SRC missing — build the Go PTY host first"; exit 1; }
[ -x "$PTY_HOST_SRC" ] || { echo "FAILED: $PTY_HOST_SRC is not executable"; exit 1; }
PTY_READY=$(printf '' | "$PTY_HOST_SRC" --workspace "$ROOT_DIR")
node -e 'const m=JSON.parse(process.argv[1]); if(m.t!=="ready"||m.version!==1||!Number.isInteger(m.port)||!m.token) process.exit(1)' "$PTY_READY" || {
  echo "FAILED: Go PTY host version/handshake probe failed"; exit 1;
}
echo "Native database module and Go PTY host verified."

# 3. Build the .deb using dpkg-deb directly (simpler than full debhelper)
BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

# 2b. Build and verify the static Go launcher (plan: go-launcher-static-binary).
# Linux arm64 only — the launcher is the static binary that can run before
# Node.js or Switchboard is installed. The .deb layout flattens dist/ into
# /usr/lib/switchboard/, so the launcher binary lands at
# /usr/bin/switchboard-launcher (the desktop entry names it directly).
echo "Building static Go launcher (linux/arm64)..."
LAUNCHER_SRC="cmd/switchboard-launcher"
LAUNCHER_BIN="$BUILD_DIR/switchboard-launcher"
[ -d "$LAUNCHER_SRC" ] || { echo "FAILED: $LAUNCHER_SRC missing — launcher source tree not found"; exit 1; }
LAUNCHER_VERSION=$(node -p "require('./package.json').version")
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
  -trimpath -ldflags "-s -w -X main.launcherVersion=${LAUNCHER_VERSION} -X main.buildArch=linux/arm64" \
  -o "$LAUNCHER_BIN" ./cmd/switchboard-launcher \
  || { echo "FAILED: Go launcher build failed"; exit 1; }
[ -x "$LAUNCHER_BIN" ] || { echo "FAILED: $LAUNCHER_BIN is not executable"; exit 1; }
"$LAUNCHER_BIN" version || { echo "FAILED: launcher version probe failed"; exit 1; }
echo "Static Go launcher (linux/arm64) built and verified."

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
for (const key of Object.keys(manifest.targets)) manifest.targets[key] = manifest.targets[key].replace(/^dist\\//, '');
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\\n');
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
# of build tooling no target Pi needs, and it would ship inside the package.
echo "Vendoring production node_modules..."
VENDOR_DIR="$BUILD_DIR/vendor"
mkdir -p "$VENDOR_DIR"
cp package.json package-lock.json "$VENDOR_DIR/"
( cd "$VENDOR_DIR" && npm ci --omit=dev --ignore-scripts=false )
cp -a "$VENDOR_DIR/node_modules" "$INSTALL_DIR/usr/lib/switchboard/node_modules"

# Verify the native database module resolves out of the VENDORED tree, not the repo's.
node -e "require('$INSTALL_DIR/usr/lib/switchboard/node_modules/better-sqlite3')" \
  || { echo "FAILED: better-sqlite3 missing from the vendored tree"; exit 1; }
echo "Vendored database module verified."

# Entry point
ln -s /usr/lib/switchboard/standalone/cli.js "$INSTALL_DIR/usr/bin/switchboard"

# Static Go launcher (plan: go-launcher-static-binary). The desktop entry names
# it directly so icon launches go through the launcher, not `switchboard local`
# (which was cwd-sensitive and could serve $HOME). The launcher is a static
# binary with no Node dependency, so it can run before Node.js is installed.
cp "$LAUNCHER_BIN" "$INSTALL_DIR/usr/bin/switchboard-launcher"
chmod 755 "$INSTALL_DIR/usr/bin/switchboard-launcher"

# Desktop entry + icon (Linux desktop install; harmless on a headless Pi)
mkdir -p "$INSTALL_DIR/usr/share/applications"
cp packaging/switchboard.desktop "$INSTALL_DIR/usr/share/applications/switchboard.desktop"
# The .desktop file names Icon=switchboard, so an icon MUST land on the icon
# path or the launcher shows a generic placeholder. icon.png is the extension's
# own icon and the only one that ships in the repo root.
[ -f icon.png ] || { echo "FAILED: icon.png missing — the desktop entry names Icon=switchboard"; exit 1; }
mkdir -p "$INSTALL_DIR/usr/share/icons/hicolor/256x256/apps"
cp icon.png "$INSTALL_DIR/usr/share/icons/hicolor/256x256/apps/switchboard.png"

# Config file (conffile)
cp packaging/debian/switchboard.env "$INSTALL_DIR/etc/switchboard/switchboard.env"
echo "/etc/switchboard/switchboard.env" > "$INSTALL_DIR/DEBIAN/conffiles"

# Systemd unit
cp packaging/debian/switchboard.service "$INSTALL_DIR/lib/systemd/system/switchboard.service"

# Control file
cat > "$INSTALL_DIR/DEBIAN/control" << EOF
Package: switchboard
Version: ${VERSION}
Architecture: arm64
Maintainer: Switchboard <noreply@switchboard.ai>
Depends: nodejs (>= 22)
Recommends: tailscale
Section: utils
Priority: optional
Description: Switchboard — plan-driven agent orchestration board
 Switchboard is a standalone board and fleet manager for AI coding agents.
 It runs a local web board, dispatches work to agent CLIs, and tracks plans
 through a kanban workflow. This package installs the standalone host,
 a systemd service, and the switchboard CLI.
 .
 On a Raspberry Pi 4/5 (arm64, 4 GB), it runs two agent seats comfortably.
 The package vendors better-sqlite3 and the static Go PTY host for arm64, so no
 compiler is needed on the target.
EOF

# Maintainer scripts
cp packaging/debian/postinst "$INSTALL_DIR/DEBIAN/postinst"
cp packaging/debian/prerm "$INSTALL_DIR/DEBIAN/prerm"
cp packaging/debian/postrm "$INSTALL_DIR/DEBIAN/postrm"
chmod 755 "$INSTALL_DIR/DEBIAN/postinst" "$INSTALL_DIR/DEBIAN/prerm" "$INSTALL_DIR/DEBIAN/postrm"

# 4. Build the .deb
echo "Building .deb..."
dpkg-deb --build --root-owner-group "$INSTALL_DIR" "$DEB_NAME"

echo ""
echo "Built: ${DEB_NAME}"
echo "Install with: sudo apt install ./${DEB_NAME}"
echo "Then run:     switchboard setup host"
